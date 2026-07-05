"use strict";
// Electron shell: spawns the local master service (sidecar) and loads the offline
// POS renderer. The renderer talks to the sidecar over HTTP, so no native modules
// run inside Electron itself — better-sqlite3 lives only in the sidecar (plain Node).

const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow } = require("electron");

const DEV_URL = process.env.EDGE_RENDERER_URL || "http://localhost:5175";
let sidecar;

function startSidecar() {
  // Spawn with SYSTEM Node (not Electron): better-sqlite3 is compiled for Node's ABI,
  // so the local master must run under real Node, never Electron's bundled runtime.
  // No shell: keeps the space in "Pet Pooja Clone" intact (shell:true splits on it).
  // node.exe is resolved from PATH; args are passed verbatim.
  const nodeBin = process.platform === "win32" ? "node.exe" : "node";
  sidecar = spawn(nodeBin, [path.join(__dirname, "..", "sidecar", "server.js")], {
    stdio: "inherit",
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    backgroundColor: "#14110f",
    title: "Spice Route · Edge POS",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  if (process.env.EDGE_LOAD_FILE) win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  else win.loadURL(DEV_URL);
}

app.whenReady().then(() => {
  startSidecar();
  // Give the sidecar a moment to bind its port before the renderer polls it.
  setTimeout(createWindow, 800);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (sidecar) sidecar.kill();
  if (process.platform !== "darwin") app.quit();
});
app.on("quit", () => sidecar && sidecar.kill());
