/**
 * Dumps a selector inventory of the live Suno create page.
 *
 *   npm run chrome     (once, log in)
 *   npm run inspect
 *
 * Writes tools/out/inventory.json and prints a readable summary.
 */
import { connect, sunoPage, looksLoggedOut, writeJson, ensureOutDir, OUT_DIR } from "./lib.js";
import path from "node:path";

const urlArg = process.argv.find((a) => a.startsWith("--url="));
const targetUrl = urlArg ? urlArg.slice("--url=".length) : "https://suno.com/create";
ensureOutDir();

const INVENTORY = () => {
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + node.id;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function desc(el) {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === "style" || a.name === "class") continue;
      attrs[a.name] = a.value.length > 120 ? a.value.slice(0, 120) + "…" : a.value;
    }
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
      value: el.value !== undefined ? String(el.value).slice(0, 60) : undefined,
      rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
      path: cssPath(el)
    };
  }

  const sel =
    "input, textarea, select, button, [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='menu'], [contenteditable='true'], [data-testid], [aria-label]";
  const nodes = Array.from(document.querySelectorAll(sel));
  const seen = new Set();
  const elements = [];
  for (const el of nodes) {
    if (el.type === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const d = desc(el);
    const key = d.tag + "|" + JSON.stringify(d.attrs) + "|" + d.text;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(d);
    if (elements.length >= 400) break;
  }

  const clipRows = Array.from(document.querySelectorAll("[data-testid='clip-row']")).map((r) => ({
    label: r.getAttribute("aria-label"),
    status: r.getAttribute("data-clip-status"),
    text: (r.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
  }));

  return {
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    clipRows,
    elements
  };
};

function summarize(inv) {
  const buttons = inv.elements.filter((e) => e.tag === "button" || e.attrs.role === "button");
  const inputs = inv.elements.filter((e) => ["input", "textarea", "select"].includes(e.tag));
  const lines = [];
  lines.push("URL: " + inv.url);
  lines.push("Clip rows: " + inv.clipRows.length);
  lines.push("");
  lines.push("INPUTS (" + inputs.length + "):");
  for (const i of inputs) {
    const idBits = [
      i.attrs.placeholder ? "placeholder=" + JSON.stringify(i.attrs.placeholder) : null,
      i.attrs["aria-label"] ? "aria=" + JSON.stringify(i.attrs["aria-label"]) : null,
      i.attrs.id ? "id=" + JSON.stringify(i.attrs.id) : null,
      i.attrs["data-testid"] ? "testid=" + JSON.stringify(i.attrs["data-testid"]) : null
    ]
      .filter(Boolean)
      .join(" ");
    lines.push("  " + i.tag.padEnd(8) + " " + idBits + "  path=" + i.path);
  }
  lines.push("");
  lines.push("BUTTONS (" + buttons.length + "):");
  for (const b of buttons) {
    const label = b.attrs["aria-label"] || b.text || "";
    if (!label) continue;
    lines.push(
      "  " +
        JSON.stringify(label).slice(0, 50).padEnd(52) +
        (b.attrs["data-testid"] ? "testid=" + b.attrs["data-testid"] + " " : "") +
        "path=" +
        b.path
    );
  }
  return lines.join("\n");
}

const { ctx } = await connect();
const page = await sunoPage(ctx, targetUrl);
if (!page.url().includes(targetUrl.replace("https://suno.com", ""))) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
}

if (await looksLoggedOut(page)) {
  console.error("Not logged in. Log into Suno in the debuggable Chrome window, then retry.");
  process.exit(1);
}

await page
  .waitForSelector("[data-testid='clip-row'], textarea, input[placeholder]", { timeout: 20000 })
  .catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(OUT_DIR, "inspect.png") });

const inv = await page.evaluate(INVENTORY);
const file = writeJson("inventory.json", inv);
console.log(summarize(inv));
console.log("");
console.log("Wrote " + file);
process.exit(0);
