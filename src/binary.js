let {platform} = require("process");
let {existsSync, readFileSync, createWriteStream} = require("fs");
let {resolve} = require("path");
let {get} = require("https");

const SYSTEM = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
const ARCH = ["darwin", "linux"].includes(SYSTEM) && process.arch.includes("arm") ? "arm" : "x86";

const BINARY_NAME = `${SYSTEM}-${ARCH}-64-webview${SYSTEM === "windows" ? ".exe" : ""}`
const BINARY_PATH = resolve(__dirname, "..", "build", BINARY_NAME);

const URL = "https://github.com/Spinnr/native-webview/releases/download";

function getVersion() {
    const packJSON = readFileSync(resolve(__dirname, "..", "package.json"), "utf-8");
    const pack = JSON.parse(packJSON);
    return pack.version;
}

function isBinaryFile() {
    return existsSync(BINARY_PATH);
}

async function getResponse(url) {
    return new Promise((resolve, reject) => {
        get(url, response => {
            const status = response.statusCode || 0;
            const location = response.headers.location;

            if(status === 200) {
                resolve(response);
            } else if(status >= 300 && status < 400 && location) {
                getResponse(location)
                    .then(resolve)
                    .catch(reject);
            } else {
                reject();
            }
        }).on("error", reject);
    });
}

async function writeFile(res, path) {
    return new Promise(resolve => {
        const file = createWriteStream(path, {mode: 755});
        res.pipe(file);
        file.on("finish", () => {
            file.close();
            resolve(path);
        });
    });
}

async function downloadBinaryFile(version) {
    version = version ?? getVersion();
    const url = `${URL}/v${version}/${BINARY_NAME}`;

    console.log(`Downloading native-webview ${version} binary file for your OS.`)

    try {
        const res = await getResponse(url);
        await writeFile(res, BINARY_PATH);
    } catch(e) {
        if(e) throw e;
        throw new Error(`Native-webview binary file ${version} for your OS is not found: ${URL}`);
    }
}

function getBinaryPath() {
    return BINARY_PATH;
}

module.exports = {
    isBinaryFile,
    downloadBinaryFile,
    getBinaryPath
}

if(require.main === module) {
    let i = process.argv.indexOf("--download-binary");
    if(i >= 0) {
        if(!isBinaryFile()) downloadBinaryFile(process.argv[i + 1] ?? undefined);
    }
}