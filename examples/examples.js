if(require.main === module) {
    if(process.argv.length > 2) {
        if(process.argv.includes("features")) require("./features");
        if(process.argv.includes("transparent")) require("./transparent");
    } else {
        console.log("Usage: node examples.js [features] [transparent]");
    }
}