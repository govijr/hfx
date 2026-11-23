#!/usr/bin/env node
// Launches the built app inside the pixel runtime in this terminal pane.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const pixelBin = path.join(path.dirname(require.resolve("@zenbu-labs/pixel/package.json")), "dist", "bin.js");
const entry = path.join(__dirname, "..", "dist", "main.js");
const res = spawnSync(process.execPath, [pixelBin, entry, "--", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
