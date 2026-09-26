/**
 * Runs the extension's real cover-flow logic inside the live page (no Create
 * click, so no credits are spent) and reports the resulting form state.
 *
 *   node tools/test-flow.js --title="two days" --style="dreamy synthwave" --song="happy song" --ws="26-9 Mashes"
 */
import { connect, sunoPage, looksLoggedOut, writeJson } from "./lib.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const get = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith("--" + name + "="));
  return a ? a.slice(name.length + 3) : dflt;
};

const rowTitle = get("title", "two days");
const style = get("style", "dreamy synthwave, warm analog pads, mid tempo");
const songName = get("song", "test song");
const workspace = get("ws", "26-9 Mashes");
const take = get("take", "01");
const rating = get("rating", "iiiN");
const styleCode = get("code", "qhvy");
const submit = get("submit", "") === "yes";
const batch = get("batch", "") === "yes";

const { ctx } = await connect();
const page = await sunoPage(ctx, "https://suno.com/me");
await page.goto("https://suno.com/me", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForSelector(".clip-row", { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1200);
if (await looksLoggedOut(page)) {
  console.error("Not logged in.");
  process.exit(1);
}

for (const f of ["shared/title.js", "content/selectors.js", "content/cover-flow.js"]) {
  await page.addScriptTag({ path: path.join(SRC, f) });
}

await page.waitForTimeout(500);

const built = await page.evaluate(
  ({ rowTitle, style, songName, workspace, take, rating, styleCode }) => {
    const S = globalThis.SunoGenSelectors;
    const F = globalThis.SunoGenCoverFlow._internals;
    const row = S.findClipRow(rowTitle);
    const title = globalThis.SunoGenTitle.buildTitle({
      date: "26-9",
      take,
      rating,
      styleCode,
      songName
    });
    return {
      rowLabel: row ? row.getAttribute("aria-label") : null,
      source: { title: row ? row.getAttribute("aria-label") : null },
      style,
      title,
      workspace
    };
  },
  { rowTitle, style, songName, workspace, take, rating, styleCode }
);

console.log("Target:", JSON.stringify(built, null, 2));
if (!built.source.title) {
  console.error("No matching clip row found.");
  process.exit(1);
}

if (batch) {
  const config = {
    source: built.source,
    batch: { songName: songName, date: "26-9", take: take, rating: rating, workspace: workspace },
    presets: [
      {
        id: "p1",
        selected: true,
        name: "A",
        styleCode: styleCode || "tsta",
        stylePrompt: style,
        lyrics: "[instrumental]"
      },
      {
        id: "p2",
        selected: true,
        name: "B",
        styleCode: "tstb",
        stylePrompt: "dark cinematic synthwave, slow, heavy",
        lyrics: "[instrumental]"
      }
    ],
    settings: { defaultModel: "", delayMs: 5000, monitorTimeoutMs: 180000 }
  };
  console.log("Running batch (spends credits)…");
  const out = await page.evaluate(async (cfg) => {
    const F = globalThis.SunoGenCoverFlow;
    const events = [];
    const results = await F.runBatch(cfg, (e) => events.push(e));
    return { results, events };
  }, config);
  for (const e of out.events) {
    if (e.type === "job-start") console.log("[start] " + e.job.title + " -> " + e.job.workspace);
    else if (e.type === "job-submitted") console.log("[submitted] " + e.job.title);
    else if (e.type === "job-error") console.log("[ERROR] " + e.job.title + ": " + e.error);
    else if (e.type === "job-status") console.log("[status] " + e.title + " -> " + e.status);
    else if (e.type === "batch-complete") console.log("[complete]");
  }
  console.log("Results:", JSON.stringify(out.results, null, 2));
  await page.screenshot({ path: path.join(__dirname, "out", "test-batch.png") });
  process.exit(0);
}

const steps = await page.evaluate(
  async ({ source, style, title, workspace }) => {
    const F = globalThis.SunoGenCoverFlow._internals;
    const out = [];
    const step = async (name, fn) => {
      try {
        await fn();
        out.push({ step: name, ok: true });
      } catch (err) {
        out.push({ step: name, ok: false, error: String((err && err.message) || err) });
        throw err;
      }
    };
    try {
      await step("ensureCoverContext", () => F.ensureCoverContext(source));
      await step("fillStyle", () => F.fillStyle(style));
      await step("fillTitle", () => F.fillTitle(title));
      await step("fillLyrics", () => F.fillLyrics("[instrumental]"));
      await step("selectWorkspace", () => F.selectWorkspace(workspace));
    } catch (err) {
      /* recorded above */
    }
    return out;
  },
  { source: built.source, style: built.style, title: built.title, workspace: built.workspace }
);

console.log("Steps:", JSON.stringify(steps, null, 2));

const state = await page.evaluate(() => {
  const S = globalThis.SunoGenSelectors;
  const styleEl = S.find("styleInput");
  const titleEl = S.find("titleInput");
  const editor = S.find("lyricsEditor");
  const trig = S.findWorkspaceTrigger();
  const create = S.find("createButton");
  return {
    style: styleEl ? styleEl.value : null,
    title: titleEl ? titleEl.value : null,
    lyrics: editor ? (editor.textContent || "").trim() : null,
    workspacePill: trig ? (trig.textContent || "").trim() : null,
    createLabel: create ? (create.textContent || "").trim() : null,
    createDisabled: create ? !!create.disabled || create.getAttribute("aria-disabled") === "true" : null
  };
});

console.log("Form state:", JSON.stringify(state, null, 2));
writeJson("test-flow.json", { built, steps, state });
await page.screenshot({ path: path.join(__dirname, "out", "test-flow.png") });

if (submit) {
  console.log("Submitting (this spends credits)…");
  await page.evaluate(() => globalThis.SunoGenCoverFlow._internals.clickCreate());
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".clip-row")).slice(0, 8).map((r) => ({
      label: r.getAttribute("aria-label"),
      status: r.getAttribute("data-clip-status")
    }));
    const toasts = Array.from(
      document.querySelectorAll("[aria-label*='notifications' i]")
    ).map((n) => (n.textContent || "").trim().slice(0, 200));
    return { rows, toasts };
  });
  console.log("After submit:", JSON.stringify(after, null, 2));
  await page.screenshot({ path: path.join(__dirname, "out", "test-submit.png") });
  console.log("Screenshot: tools/out/test-submit.png");
}
process.exit(0);
