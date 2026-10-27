/**
 * Exercise the SHIPPING catalogue module (src/content/catalog.js) against live
 * Suno, without the extension installed.
 *
 *   node tools/probe-catalog.js            # API path (default) + DOM fallback
 *   node tools/probe-catalog.js --api      # API only
 *   node tools/probe-catalog.js --dom      # DOM/picker only
 */
import { connect, sunoPage, looksLoggedOut, writeJson } from "./lib.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const targetUrl = urlArg ? urlArg.slice("--url=".length) : "https://suno.com/create";
const only = process.argv.includes("--api") ? "api" : process.argv.includes("--dom") ? "dom" : "both";

const { ctx } = await connect();
const page = await sunoPage(ctx, targetUrl);
if (await looksLoggedOut(page)) {
  console.error("Not logged in.");
  process.exit(1);
}
for (const f of ["shared/title.js", "content/selectors.js", "content/catalog.js"]) {
  await page.addScriptTag({ path: path.join(SRC, f) });
}
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

const results = {};

if (only !== "dom") {
  const api = await page.evaluate(async () => {
    const C = globalThis.SunoGenCatalog;
    const progress = [];
    const t0 = Date.now();
    const res = await C.collectWorkspaces({
      onProgress: (p) => progress.push(p)
    });
    return { ...res, ms: Date.now() - t0, progress: progress.slice(0, 20), progressCount: progress.length };
  });
  results.api = api;
  console.log(
    "API path:",
    JSON.stringify(
      { source: api.source, count: api.workspaces.length, total: api.total, ms: api.ms, warning: api.warning },
      null,
      2
    )
  );
  console.log(" first/last:", api.workspaces[0] && api.workspaces[0].name, "…", api.workspaces.at(-1) && api.workspaces.at(-1).name);
}

if (only !== "api") {
  const dom = await page.evaluate(async () => {
    const C = globalThis.SunoGenCatalog;
    const progress = [];
    const t0 = Date.now();
    const res = await C.internals.collectFromDom((p) => progress.push(p));
    return { ...res, ms: Date.now() - t0, progressCount: progress.length, pickerStillOpen: !!C.internals.pickerDialog() };
  });
  results.dom = dom;
  console.log(
    "DOM path:",
    JSON.stringify(
      { count: dom.workspaces.length, openedPicker: dom.openedPicker, ms: dom.ms, pickerStillOpen: dom.pickerStillOpen },
      null,
      2
    )
  );
  if (results.api) {
    const apiNames = new Set(results.api.workspaces.map((w) => w.name.toLowerCase()));
    const missing = dom.workspaces.filter((w) => !apiNames.has(w.name.toLowerCase())).map((w) => w.name);
    console.log(" dom-only entries:", missing.length, missing.slice(0, 5));
  }
}

const file = writeJson("catalog-probe.json", results);
console.log("Wrote", file);
process.exit(0);
