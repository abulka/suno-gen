import { chromium } from "playwright-core";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = 9222;
export const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const PROFILE_DIR = path.join(__dirname, ".chrome-profile");
export const OUT_DIR = path.join(__dirname, "out");

export function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export function isPortUp(port = PORT) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Connect to the debuggable Chrome. Does not close Chrome on exit. */
export async function connect() {
  if (!(await isPortUp())) {
    throw new Error(
      "No debuggable Chrome on port " +
        PORT +
        ". Run `npm run chrome` first (and log into Suno in that window)."
    );
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("Connected but no browser context found.");
  return { browser, ctx };
}

export async function sunoPage(ctx, url = "https://suno.com/create") {
  let page = ctx.pages().find((p) => /https:\/\/([a-z0-9-]+\.)?suno\.com/.test(p.url()));
  if (!page) {
    page = await ctx.newPage();
  }
  if (!page.url().includes("suno.com")) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  return page;
}

export async function looksLoggedOut(page) {
  return page.evaluate(() => {
    const text = (document.body.innerText || "").slice(0, 4000).toLowerCase();
    return (
      text.includes("log in") ||
      text.includes("sign up") ||
      text.includes("join suno") ||
      document.querySelector("input[type='password']") !== null
    );
  });
}

export function writeJson(name, data) {
  ensureOutDir();
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
