const cp = require("child_process");

if(require.main === module) {
    // if windows, spawn "npm run build:win"
    // if linux, spawn "npm run build:linux"
    // if mac, spawn "npm run build:mac"

    let command = "npm run build"
    if(process.argv.includes("dev") || process.argv.includes("development")) command += ":dev";
    command += ({
        win32: ":win",
        linux: ":linux",
        darwin: ":mac"
    })[process.platform];

    if(process.arch.includes("arm")) command += ":arm";

    cp.execSync(command, {stdio: "inherit"});
}