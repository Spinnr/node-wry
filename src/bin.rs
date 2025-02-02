use std::fs::{canonicalize, read};
use std::io::{self, BufRead};
use std::thread;

use clap::Parser;

use crossbeam_channel::{bounded, Receiver};
use serde::{Deserialize, Serialize};

use wry::{
    application::{
        dpi::{LogicalPosition, LogicalSize},
        event::{Event, StartCause, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        window::{Fullscreen, WindowBuilder},
    },
    http::ResponseBuilder,
    webview::{FileDropEvent, WebViewBuilder},
};

#[cfg(not(target_os = "macos"))]
use image;
#[cfg(not(target_os = "macos"))]
use wry::application::window::Icon;

#[derive(Parser, Debug)]
struct Args {
    #[clap(long, short, default_value = "Native WebView")]
    title: String,
    #[clap(long)]
    transparent: bool,
    #[cfg(debug_assertions)]
    #[clap(long)]
    devtools: bool,
}

#[derive(Serialize, Deserialize)]
struct FrontEndError {
    message: String,
    source: String,
    line: u64,
    column: u64,
    stack: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FrontEndMessage {
    Log { log: String },
    Message { message: String },
    Error(FrontEndError),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Message {
    Start {},
    End {},
    Message { message: String },
    Log { log: String },
    Path { url: String },
    Error(FrontEndError),

    FileDropHovered { paths: Vec<String> },
    FileDropDropped { paths: Vec<String> },
    FileDropCancelled {},
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Settings {
    Focus {},
    Close {},
    Eval { js: String },
    Title { title: String },
    WindowIcon { path: String },
    Resizable { resizable: bool },
    InnerSize { width: f64, height: f64 },
    MinInnerSize { width: f64, height: f64 },
    MaxInnerSize { width: f64, height: f64 },
    OuterPosition { top: f64, left: f64 },
    AlwaysOnTop { always: bool },
    Decorations { decorations: bool },
    Fullscreen { fullscreen: bool },
    Maximized { maximized: bool },
    Minimized { minimized: bool },
    Devtools { devtools: bool },
}

#[derive(Deserialize)]
struct Path {
    url: String,
    path: String,
    mimetype: String,
}

const IO_CHANNEL_PREFIX: &str = "_ioc:";
const INIT_SCRIPT: &str = r#"
console.logOriginal = console.log;
console.log = function () {
    console.logOriginal.apply(this, arguments);
    ipc.postMessage(JSON.stringify({ type: "log", log: JSON.stringify(Array.prototype.splice.call(arguments, 0)) }));
};
window.onerror = function(message, source, line, column, error) {
    let stack = "";
    if (error instanceof Error && error.stack) {
        stack = error.stack.toString();
    }
    ipc.postMessage(JSON.stringify({ type: "error", message, source, line, column, stack }));
};

function sendMessage(message) {
    ipc.postMessage(JSON.stringify({ type: "message", message: JSON.stringify(message) }));
}
"#;

fn send_ioc_message(message: Message) {
    println!(
        "{}{}",
        IO_CHANNEL_PREFIX,
        serde_json::to_string(&message).unwrap()
    )
}

fn get_path(url: &str, rx: Receiver<Path>) -> Path {
    send_ioc_message(Message::Path {
        url: url.to_string(),
    });

    loop {
        let path = rx.recv().unwrap();

        if path.url == url {
            return path;
        }
    }
}

fn main() -> wry::Result<()> {
    let args = Args::parse();

    let (s_path, r_path) = bounded::<Path>(0);

    let event_loop = EventLoop::with_user_event();
    let window = WindowBuilder::new()
        .with_transparent(args.transparent)
        .with_decorations(!args.transparent)
        .with_title(args.title)
        .build(&event_loop)?;
    let webview = WebViewBuilder::new(window)?
        .with_transparent(args.transparent)
        .with_initialization_script(INIT_SCRIPT)
        .with_custom_protocol("nwv".into(), move |request| {
            let path = get_path(request.uri(), r_path.clone());
            let content = read(canonicalize(path.path)?)?;

            ResponseBuilder::new()
                .mimetype(&path.mimetype)
                .body(content)
        })
        .with_url("nwv://index.html")?
        .with_ipc_handler(|_window, front_end_message| {
            match serde_json::from_str::<FrontEndMessage>(&front_end_message) {
                Ok(message) => match message {
                    FrontEndMessage::Message { message } => {
                        send_ioc_message(Message::Message { message })
                    }
                    FrontEndMessage::Log { log } => send_ioc_message(Message::Log { log }),
                    FrontEndMessage::Error(error) => send_ioc_message(Message::Error(error)),
                },
                Err(_) => {
                    println!("Unknown IPC message type {}", front_end_message)
                }
            }
        })
        .with_file_drop_handler(|_, data| {
            match data {
                FileDropEvent::Hovered(paths) => send_ioc_message(Message::FileDropHovered {
                    paths: paths
                        .iter()
                        .map(|buf| buf.to_str().unwrap().to_string())
                        .collect(),
                }),
                FileDropEvent::Dropped(paths) => send_ioc_message(Message::FileDropDropped {
                    paths: paths
                        .iter()
                        .map(|buf| buf.to_str().unwrap().to_string())
                        .collect(),
                }),
                _ => send_ioc_message(Message::FileDropCancelled {}),
            }
            true // Returning true will block the OS default behaviour.
        })
        .with_devtools(args.devtools)
        .build()?;

    let monitor = event_loop
        .available_monitors()
        .nth(0) // TODO: set active monitor
        .expect("No available monitor");
    let borderless_fullscreen = Fullscreen::Borderless(Some(monitor));

    let event_proxy = event_loop.create_proxy();
    thread::spawn(move || loop {
        let stdin = io::stdin();
        let input = stdin.lock().lines().next();
        let line = input
            .expect("No lines in buffer")
            .expect("Failed to read line")
            .trim()
            .to_string();

        if line.starts_with(IO_CHANNEL_PREFIX) {
            let string = &line[IO_CHANNEL_PREFIX.len()..];
            // let message: Value = ;
            // let message_type = .unwrap().["type"].as_str().unwrap();

            match serde_json::from_str::<Path>(string) {
                Ok(path) => s_path.send(path).unwrap(),
                Err(_) => {
                    event_proxy.send_event(string.to_string()).unwrap();
                }
            }
        }
    });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(string) => {
                let window = webview.window();

                match serde_json::from_str::<Settings>(&string).unwrap() {
                    Settings::Eval { js } => webview.evaluate_script(&js).unwrap(),
                    Settings::Close {} => {
                        *control_flow = ControlFlow::Exit;
                        send_ioc_message(Message::End {});
                    }
                    Settings::Focus {} => {
                        window.set_focus();
                        webview.focus();
                    }
                    Settings::Title { title } => window.set_title(&title),
                    #[cfg(not(target_os = "macos"))]
                    Settings::WindowIcon { path } => window.set_window_icon(Some(load_icon(&path))),
                    #[cfg(target_os = "macos")]
                    Settings::WindowIcon { path: _ } => {
                        println!("Window icon not allowed for macos.");
                    }
                    Settings::Resizable { resizable } => window.set_resizable(resizable),
                    Settings::InnerSize { width, height } => {
                        window.set_inner_size(LogicalSize::new(width, height))
                    }
                    Settings::MinInnerSize { width, height } => {
                        window.set_min_inner_size(Some(LogicalSize::new(width, height)))
                    }
                    Settings::MaxInnerSize { width, height } => {
                        window.set_max_inner_size(Some(LogicalSize::new(width, height)))
                    }
                    Settings::OuterPosition { top, left } => {
                        window.set_outer_position(LogicalPosition::new(left, top))
                    }
                    Settings::AlwaysOnTop { always } => window.set_always_on_top(always),
                    Settings::Decorations { decorations } => window.set_decorations(decorations),
                    Settings::Fullscreen { fullscreen } => {
                        if fullscreen {
                            window.set_fullscreen(Some(borderless_fullscreen.clone()));
                        } else {
                            window.set_fullscreen(None);
                        }
                    }
                    Settings::Maximized { maximized } => window.set_maximized(maximized),
                    Settings::Minimized { minimized } => window.set_minimized(minimized),
                    Settings::Devtools { devtools } => {
                        if cfg!(debug_assertions) {
                            if devtools {
                                webview.open_devtools();
                            } else {
                                webview.close_devtools();
                            }
                        }
                    }
                }
            }
            Event::NewEvents(StartCause::Init) => send_ioc_message(Message::Start {}),
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
                send_ioc_message(Message::End {});
            }
            _ => {}
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn load_icon(path: &str) -> Icon {
    let (icon_rgba, icon_width, icon_height) = {
        let image = image::open(path)
            .expect("Failed to open icon path")
            .into_rgba8();
        let (width, height) = image.dimensions();
        let rgba = image.into_raw();
        (rgba, width, height)
    };
    Icon::from_rgba(icon_rgba, icon_width, icon_height).expect("Failed to open icon")
}
