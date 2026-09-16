"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPackage } = require("@electron/asar");

const project = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
const output = path.join(project, `dist-portable-final-v${packageJson.version}`, "PlacegameAutoHelper-win32-x64");
if (fs.existsSync(output)) {
  fs.rmSync(output, { recursive: true, force: true });
}

const electronRuntime = path.dirname(require("electron"));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "placegame-app-stage-"));
const appStage = path.join(stage, "app");
fs.mkdirSync(appStage, { recursive: true });
for (const name of ["main.js", "preload.js", "renderer-helper.js", "README.md", "package.json"]) {
  fs.copyFileSync(path.join(project, name), path.join(appStage, name));
}
fs.cpSync(path.join(project, "assets"), path.join(appStage, "assets"), { recursive: true });

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.cpSync(electronRuntime, output, { recursive: true });
const resources = path.join(output, "resources");
fs.mkdirSync(resources, { recursive: true });
fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
createPackage(appStage, path.join(resources, "app.asar")).then(() => {
  fs.renameSync(path.join(output, "electron.exe"), path.join(output, "PlacegameAutoHelper.exe"));
  console.log(`Portable package created: ${output}`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
