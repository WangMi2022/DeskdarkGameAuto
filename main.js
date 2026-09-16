"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const GAME_URL = "https://game.placegame.cn/";
const GAME_ORIGIN = "https://game.placegame.cn";
const HELPER_FILE = path.join(__dirname, "renderer-helper.js");
const PRELOAD_FILE = path.join(__dirname, "preload.js");

let mainWindow;
let helperSource = "";

function loadHelperSource() {
  if (helperSource) return helperSource;
  helperSource = fs.readFileSync(HELPER_FILE, "utf8");
  return helperSource;
}

function isGameUrl(url) {
  try {
    return new URL(url).origin === GAME_ORIGIN;
  } catch {
    return false;
  }
}

async function injectHelper(window) {
  if (!window || window.isDestroyed()) return;
  const source = loadHelperSource();
  const wrapped = `(function () {
    if (window.__PLACEGAME_AUTO_HELPER_INSTALLED__) {
      window.__PLACEGAME_SHOW_HELPER__?.();
      return;
    }
    window.__PLACEGAME_AUTO_HELPER_INSTALLED__ = true;
    ${source}
  })();`;
  try {
    await window.webContents.executeJavaScript(wrapped, true);
  } catch (error) {
    console.error("无法注入挂机助手:", error);
  }
}

function createApplicationMenu() {
  const template = [
    {
      label: "助手",
      submenu: [
        {
          label: "刷新游戏",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
        {
          label: "重新打开助手面板",
          accelerator: "CmdOrCtrl+Shift+H",
          click: () => injectHelper(mainWindow),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "查看",
      submenu: [
        { role: "toggledevtools", label: "开发者工具" },
        { role: "resetzoom", label: "重置缩放" },
        { role: "zoomin", label: "放大" },
        { role: "zoomout", label: "缩小" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const HELPER_PANEL_WIDTH = 400;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 860,
    minWidth: 1100,
    minHeight: 600,
    backgroundColor: "#101722",
    title: "复古打宝挂机助手",
    autoHideMenuBar: false,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // The game serves the normal web client to a Chrome-like user agent.
  const chromeUserAgent = mainWindow.webContents.getUserAgent().replace(/Electron\/[^ ]+\s?/i, "");
  mainWindow.webContents.setUserAgent(chromeUserAgent);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isGameUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isGameUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    // Separate game container and helper into two distinct flexbox columns with zero overlap.
    mainWindow.webContents.insertCSS(`
      html, body {
        width: 100vw !important;
        height: 100vh !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: row !important;
      }
      #root {
        flex: 1 1 0% !important;
        min-width: 0 !important;
        width: 0 !important;
        height: 100vh !important;
        overflow: auto !important;
        position: relative !important;
        contain: paint !important;
      }
      .app-shell {
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        height: 100% !important;
      }
      #placegame-auto-helper-host {
        flex: 0 0 ${HELPER_PANEL_WIDTH}px !important;
        width: ${HELPER_PANEL_WIDTH}px !important;
        min-width: ${HELPER_PANEL_WIDTH}px !important;
        max-width: ${HELPER_PANEL_WIDTH}px !important;
        height: 100vh !important;
        position: relative !important;
        box-sizing: border-box !important;
      }
      #placegame-auto-helper-host[hidden] {
        display: none !important;
      }
    `).catch(() => {});
    void injectHelper(mainWindow);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "crashed" || details.reason === "oom") {
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "游戏页面异常",
        message: "游戏页面进程已退出，请重新加载。",
        buttons: ["重新加载", "退出"],
      }).then(({ response }) => {
        if (response === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        if (response === 1) app.quit();
      });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  createApplicationMenu();
  void mainWindow.loadURL(GAME_URL);
}

app.setName("复古打宝挂机助手");
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication");

app.whenReady().then(() => {
  // Keep the normal persistent Electron profile so the game's localStorage/cookies survive restarts.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "notifications");
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
