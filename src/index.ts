import { platform } from 'process';
import { resolve, extname } from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

const IO_CHANNEL_PREFIX = "_ioc:";

const SYSTEM = platform === "darwin" ? "darwin" :
    platform === "win32" ? "windows" :
        "linux";

const PROGRAM_PATH = resolve(__dirname, "..", "dist", `${SYSTEM}_x86_64`, `native-webview${SYSTEM === "windows" ? ".exe" : ""}`);

export type NativeWebViewSettings = {
    focus: {},
    close: {},
    eval: { js: string },

    title: { title: string },
    /**
     * Sets the window icon. On Windows and Linux, this is typically the small icon in the top-left
     * corner of the title bar.
     *
     * ## Platform-specific
     * - **iOS / Android / macOS:** Unsupported.
     *
     * On Windows, this sets `ICON_SMALL`. The base size for a window icon is 16x16, but it's
     * recommended to account for screen scaling and pick a multiple of that, i.e. 32x32.
     */
    windowIcon: { path: string },
    resizable: { resizable: boolean },
    innerSize: { width: number, height: number },
    minInnerSize: { width: number, height: number },
    maxInnerSize: { width: number, height: number },
    outerPosition: { top: number, left: number },
    alwaysOnTop: { always: boolean },
    decorations: { decorations: boolean },
    fullscreen: { fullscreen: boolean },
    maximized: { maximized: boolean },
    minimized: { minimized: boolean },
};

type Path = {
    url: string,
    path: string,
    mimetype: string
};

type ChannelIn =
    | { type: "start" }
    | { type: "end" }
    | { type: "message", message: string }
    | { type: "log", log: string /* stringify as array */ }
    | { type: "error", message: string, source: string, line: number, column: string, stack: string }
    | { type: "path", url: string };

export default class NativeWebView {
    private settings: Partial<NativeWebViewSettings>;
    private childProcess: null | ChildProcessWithoutNullStreams = null;

    private getPath: (nwv: string) => string = (nwv) => resolve(__dirname, "..", "dist", nwv.replace("nwv://", ""));
    private onMessage: (message: any) => void = (message) => console.log("Message:", message);

    constructor(
        settings: Partial<Omit<NativeWebViewSettings, "eval" | "close" | "focus" | "title">> & { title: string },
        getPath?: (nwv: string) => string,
        onMessage?: (message: any) => void,
    ) {
        const { title, windowIcon, ...other } = settings;
        this.settings = { title: { title }, ...other };

        if (getPath) this.getPath = getPath;
        if (onMessage) this.onMessage = onMessage;
    }

    // web common MIME types
    private getMimetype(path: string): string {
        const extension = extname(path);

        switch (extension) {
            case ".htm":
            case ".html": return "text/html";
            case ".js": return "text/javascript";
            case ".png": return "image/png";
            case ".css": return "text/css";
            case ".gif": return "image/gif";
            case ".ico": return "image/vnd.microsoft.icon";
            case ".jpg":
            case ".jpeg": return "image/jpeg";
            case ".json": return "application/json";
            case ".svg": return "image/svg+xml";
            default: return "application/octet-stream";
        }
    }

    private sendPath(path: Path) {
        if (this.childProcess === null) throw Error("WebView is not running.");

        this.childProcess.stdin.write(`${IO_CHANNEL_PREFIX}${JSON.stringify({ type: "path", ...path })}\n`);
    }

    private sendSetting<Type extends keyof NativeWebViewSettings>(type: Type, setting: NativeWebViewSettings[Type]) {
        if (this.childProcess === null) throw Error("WebView is not running.");

        this.childProcess.stdin.write(`${IO_CHANNEL_PREFIX}${JSON.stringify({ type, ...setting })}\n`);
    }

    private receiveChannel(message: ChannelIn) {
        switch (message.type) {
            case "start":

                return;
            case "end":
                if (this.childProcess) {
                    this.childProcess.kill();
                    this.childProcess = null;
                }
                return;
            case "message":
                this.onMessage(JSON.parse(decodeURIComponent(message.message)));
                return;
            case "path":
                const path = this.getPath(message.url);
                this.sendPath({ url: message.url, path, mimetype: this.getMimetype(path) });
                return;

            case "log":
                console.log("WebView:", ...JSON.parse(decodeURIComponent(message.log)));
                return;
            case "error":
                console.error("WebView Error:", decodeURIComponent(message.message), message.source, "line:", message.line, "column:", message.column, decodeURIComponent(message.stack));
                return;
            default:
                console.error("Unknown message type.", message);
        }
    }

    async run(): Promise<void> {
        if (this.childProcess !== null) throw Error("WebView is already running.");

        this.childProcess = spawn(PROGRAM_PATH, [], {});
        this.childProcess.stdin.setDefaultEncoding("utf-8");

        return new Promise((resolve, reject) => {
            if (this.childProcess === null) throw Error("WebView is not running.");

            // error
            this.childProcess.stderr.on('data', (data) => {
                reject(new Error(`WebView error: ${data}`));
            });

            this.childProcess.on('close', (code) => {
                this.childProcess = null;
                // this.isRunning = false;
                resolve();
            });

            // receive message
            let out = "";
            this.childProcess.stdout.on('data', (data: string) => {

                data.toString().split("\n").forEach((row, i) => {
                    if (i == 0) {
                        out += row.trim();
                    } else {
                        if (out.startsWith(IO_CHANNEL_PREFIX)) {
                            let message = null;
                            try {
                                message = JSON.parse(out.substring(IO_CHANNEL_PREFIX.length));
                            } catch (e) {
                                console.error("Message parse error. ", e);
                            }

                            if (message) {
                                this.receiveChannel(message);
                            }
                        } else {
                            console.log("FE:", data.toString());
                        }

                        out = row.trim();
                    }
                });
            });

            // TODO: update setting with first run
            for (const [type, value] of Object.entries(this.settings)) {
                if (value !== null) {
                    this.set(type as keyof NativeWebViewSettings, value);
                }
            }
        });
    }

    set<Type extends keyof NativeWebViewSettings>(type: Type, setting: NativeWebViewSettings[Type]) {
        this.sendSetting(type, setting);
    }

    // ------ most used --------

    eval(js: string) {
        this.set("eval", { js });
    }

    focus() {
        this.set("focus", {});
    }

    close() {
        this.set("close", {});
    }

    setTitle(title: string) {
        this.set("title", { title });
    }
}
