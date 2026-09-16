"use strict";

// Opens the packaged application with a fresh profile. Reads only DOM metadata;
// no login, purchase, enhancement or challenge is performed.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const project = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const folder = path.join(project, `dist-portable-final-v${pkg.version}`, "PlacegameAutoHelper-win32-x64");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const archive = path.join(folder, "resources/app.asar");
  for (const file of ["main.js", "renderer-helper.js", "preload.js", "package.json"]) {
    assert.deepEqual(asar.extractFile(archive, file), fs.readFileSync(path.join(project, file)), `Packaged ${file} differs`);
  }
  assert.ok(asar.listPackage(archive).length < 20, "Unexpected files in archive");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "placegame-smoke-"));
  const child = spawn(path.join(folder, "PlacegameAutoHelper.exe"), [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
  ], { windowsHide: true, stdio: "ignore" });
  let childError;
  child.on("error", (error) => { childError = error; });
  let socket;
  try {
    const deadline = Date.now() + 45000;
    let target;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null) throw new Error(`Application exited: ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        const targets = await response.json();
        target = targets.find((entry) => entry.type === "page" && entry.url.startsWith("https://game.placegame.cn"));
        if (target) break;
      } catch { /* Wait for the isolated app's local debugger. */ }
      await pause(250);
    }
    assert.ok(target, "Game page did not open within 45 seconds");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let seq = 0;
    async function evaluate(expression) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error("DOM check timed out")); }, 5000);
        function receive(event) {
          const data = JSON.parse(event.data);
          if (data.id !== id) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", receive);
          if (data.error || data.result.exceptionDetails) reject(new Error("DOM check failed"));
          else resolve(data.result.result.value);
        }
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      });
    }
    let info;
    while (Date.now() < deadline) {
      info = await evaluate(`(() => {
        const host = document.getElementById('placegame-auto-helper-host');
        return { origin: location.origin, ready: document.readyState, mounted: !!host?.shadowRoot,
          tabs: host ? Array.from(host.shadowRoot.querySelectorAll('[data-tab]'), el => el.textContent) : [],
          version: window.placegameDesktopApp?.version };
      })()`);
      if (info.mounted && info.ready === "complete") break;
      await pause(250);
    }
    assert.equal(info.mounted, true, "Helper was not injected");
    assert.equal(info.version, pkg.version);
    assert.deepEqual(info.tabs, ["自动强化", "金币材料", "世界BOSS", "自动爬塔", "自动领奖"]);
    assert.equal(await evaluate(`(() => {
      const host = document.getElementById('placegame-auto-helper-host');
      host.shadowRoot.querySelector('[data-action="close"]').click();
      const hidden = host.hidden;
      window.__PLACEGAME_SHOW_HELPER__();
      return hidden && !host.hidden;
    })()`), true);
    console.log(JSON.stringify({ packageMatchesSource: true, ...info, reopen: true, profile: "isolated", gameActions: 0 }));
  } finally {
    socket?.close();
    if (child.pid && child.exitCode === null) {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
