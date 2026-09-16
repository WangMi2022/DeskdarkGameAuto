"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("placegameDesktopApp", {
  name: "复古打宝挂机助手",
  version: "0.1.7",
});
