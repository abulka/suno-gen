/**
 * Launches a debuggable Chrome with a dedicated profile so Playwright can
 * attach to it. You log into Suno in this window once; the session persists in
 * tools/.chrome-profile.
 *
 *   npm run chrome
 *
 * Chrome is spawned detached, so this script exits and leaves it running.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { CHROME, PORT, PROFILE_DIR, isPortUp } from "./lib.js";

if (!fs.existsSync(CHROME)) {
  console.error("Chrome not found at: " + CHROME);
  console.error("Set CHROME_PATH to override.");
  process.exit(1);
}

if (await isPortUp()) {
  console.log("Debuggable Chrome already running on port " + PORT + ".");
  console.log("Open https://suno.com/create in that window and log in if needed.");
  process.exit(0);
}

fs.mkdirSync(PROFILE_DIR, { recursive: true });

const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "https://suno.com/create"
];

const child = spawn(CHROME, args, { detached: true, stdio: "ignore" });
child.unref();

const started = Date.now();
let up = false;
while (Date.now() - started < 15000) {
  if (await isPortUp()) {
    up = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 400));
}

console.log("");
if (up) {
  console.log("Chrome is open and debuggable on port " + PORT + ".");
  console.log("");
  console.log("1. Log into Suno in that window (session is saved to tools/.chrome-profile).");
  console.log("2. Then run:  npm run inspect");
  console.log("");
  console.log("Leave this Chrome window open. It is separate from your normal Chrome.");
} else {
  console.error("Chrome started but the debug port never came up.");
  console.error("If Chrome was already running with this profile, quit it and retry.");
}
