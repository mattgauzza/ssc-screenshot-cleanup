#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const script = path.join(__dirname, "screenshot-cleanup.js");
const passThrough = process.argv.slice(2);
const args = [script, "run-daily", ...passThrough];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  shell: false
});

child.on("exit", (code) => {
  process.exitCode = code || 0;
});

