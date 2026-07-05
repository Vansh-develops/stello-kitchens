"use strict";
// The renderer reaches the local master service over HTTP (localhost:4010), so no
// privileged bridge is needed. This preload exists as the seam for future native
// integrations (silent printing, drawer kick, peripheral access).
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("edgeShell", {
  platform: process.platform,
  isElectron: true,
});
