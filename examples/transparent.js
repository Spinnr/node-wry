let {resolve} = require("path");
let OpenWebView = require("../src/index");

async function runExample() {
    const wv = await OpenWebView({
        title: "Transparent window",
        transparent: true,
        devtools: true,
        innerSize: {width: 420, height: 150},
        getPath: (src) => resolve(__dirname, "transparent.html"),
        onMessage: (message) => {
            console.log("Message from WebView:", message);
            if(typeof message.type === "string") {
                wv.set(message.type, message);
            }
        }
    });

    await wv.onClose();
    console.log("WebView closed");
}

runExample();
