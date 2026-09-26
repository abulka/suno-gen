/**
 * Drives the Cover flow on the live create page and dumps the resulting
 * Advanced form, so selectors can be confirmed without guesswork.
 *
 *   npm run chrome    (once, log in)
 *   npm run cover                       # first clip row
 *   npm run cover -- --title=jarring    # row whose title contains "jarring"
 *
 * Writes tools/out/menu.json, tools/out/cover-form.json and screenshots.
 */
import { connect, sunoPage, looksLoggedOut, writeJson, ensureOutDir, OUT_DIR } from "./lib.js";
import path from "node:path";

const arg = process.argv.find((a) => a.startsWith("--title="));
const wantedTitle = arg ? arg.slice("--title=".length) : "";

ensureOutDir();

const { ctx } = await connect();
const page = await sunoPage(ctx);

if (await looksLoggedOut(page)) {
  console.error("Not logged in. Log into Suno in the debuggable Chrome window, then retry.");
  process.exit(1);
}

const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, name), fullPage: false });

async function dumpVisibleMatching(text) {
  return page.evaluate((wanted) => {
    const nodes = Array.from(document.querySelectorAll("[role='menuitem'], button, div"));
    const out = [];
    nodes.forEach((n, i) => {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if ((n.textContent || "").replace(/\s+/g, " ").trim() !== wanted) return;
      const attrs = {};
      for (const a of n.attributes) {
        if (a.name === "style" || a.name === "class") continue;
        attrs[a.name] = a.value.length > 80 ? a.value.slice(0, 80) + "…" : a.value;
      }
      out.push({ index: i, tag: n.tagName.toLowerCase(), attrs, h: Math.round(r.height), w: Math.round(r.width) });
    });
    return out;
  }, text);
}

async function dumpVisibleMenus() {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const desc = (el) => {
      const attrs = {};
      for (const a of el.attributes) {
        if (a.name === "style" || a.name === "class") continue;
        attrs[a.name] = a.value.length > 80 ? a.value.slice(0, 80) + "…" : a.value;
      }
      return {
        tag: el.tagName.toLowerCase(),
        attrs,
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)
      };
    };
    const portals = Array.from(
      document.querySelectorAll("body > div[data-context-menu='true'], [role='menu']")
    ).filter((d) => isVisible(d));
    return portals.map((p) => ({
      portal: desc(p),
      items: Array.from(
        p.querySelectorAll("button[data-context-menu-trigger='true'], [role='menuitem'], button")
      )
        .filter(isVisible)
        .slice(0, 40)
        .map(desc)
    }));
  });
}

// --- locate clip rows ---
await page.waitForSelector(".clip-row, [data-testid='clip-row']", { timeout: 20000 }).catch(() => {});
const rows = page.locator(".clip-row, [data-testid='clip-row']");
const count = await rows.count();
if (!count) {
  console.error("No clip rows found. Open a page that shows your clip list (e.g. /create).");
  process.exit(1);
}
console.log("Clip rows on screen:");
for (let i = 0; i < Math.min(count, 15); i++) {
  const label = await rows.nth(i).getAttribute("aria-label");
  const status = await rows.nth(i).getAttribute("data-clip-status");
  console.log("  [" + i + "] " + (status || "?").padEnd(10) + " " + label);
}

let target = null;
for (let i = 0; i < count; i++) {
  const label = (await rows.nth(i).getAttribute("aria-label")) || "";
  if (!wantedTitle || label.toLowerCase().includes(wantedTitle.toLowerCase())) {
    target = rows.nth(i);
    break;
  }
}
if (!target) {
  console.error("No row matched title filter: " + wantedTitle);
  process.exit(1);
}
console.log("\nUsing row: " + (await target.getAttribute("aria-label")));

// --- open the ... menu ---
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(300);
const menuCount = () =>
  page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll("body > div[data-context-menu='true'], [role='menu']")
      ).filter((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length
  );

const more = target.locator("[aria-label='More options']").first();
await more.click();
await page.waitForTimeout(800);
if ((await menuCount()) === 0) {
  await more.click();
  await page.waitForTimeout(800);
}
await shot("cover-1-menu.png");
const menuDump = await dumpVisibleMenus();
writeJson("menu.json", menuDump);
console.log("Menu portals: " + menuDump.length + " (see tools/out/menu.json)");

// --- open the Create submenu (hover, then click) ---
const coverBtn = page.locator("button[aria-label='Cover']");
const isCoverVisible = async () => {
  const n = await coverBtn.count();
  for (let i = 0; i < n; i++) {
    if (await coverBtn.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
};

if (!(await isCoverVisible())) {
  // Walk every submenu trigger in the open context menu until Cover appears.
  const triggers = page.locator(
    "[data-context-menu='true'] button[data-context-menu-trigger='true'], [data-context-menu='true'] [aria-haspopup='menu']"
  );
  const n = await triggers.count();
  console.log("Submenu triggers: " + n);
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    const label = (await t.textContent().catch(() => "")) || "";
    if (!(await t.isVisible().catch(() => false))) continue;
    console.log("  trying trigger: " + JSON.stringify(label.trim()));
    try {
      await t.hover({ timeout: 2000 });
      await page.waitForTimeout(600);
      if (await isCoverVisible()) break;
      await t.click({ timeout: 2000 });
      await page.waitForTimeout(600);
      if (await isCoverVisible()) break;
    } catch (err) {
      /* try next */
    }
  }
}

if (!(await isCoverVisible())) {
  await shot("cover-2-nocover.png");
  const after = await dumpVisibleMenus();
  writeJson("menu-after-triggers.json", after);
  console.error("Cover item never appeared. See tools/out/menu-after-triggers.json and cover-2-nocover.png.");
  process.exit(2);
}

// --- click Cover, dismiss Keep Current ---
await coverBtn.first().click();
await page.waitForTimeout(900);
await shot("cover-3-after-cover.png");

const keep = page.getByRole("button", { name: "Keep Current" });
if (await keep.count()) {
  await keep.first().click().catch(() => {});
  await page.waitForTimeout(700);
  console.log("Clicked 'Keep Current'.");
} else {
  console.log("No 'Keep Current' dialog.");
}

// --- ensure Advanced mode and dump the form ---
const adv = page.locator("button[aria-label='Advanced']");
if (await adv.count()) {
  const selected = await adv.first().getAttribute("aria-selected");
  if (selected !== "true") {
    await adv.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
}
await page.waitForTimeout(1200);
await shot("cover-4-form.png");

const form = await page.evaluate(() => {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const desc = (el) => {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === "style" || a.name === "class") continue;
      attrs[a.name] = a.value.length > 100 ? a.value.slice(0, 100) + "…" : a.value;
    }
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70),
      value: el.value !== undefined ? String(el.value).slice(0, 80) : undefined
    };
  };
  const sel =
    "input, textarea, button, [role='button'], [role='menuitem'], [role='tab'], [role='menu'], [contenteditable='true'], [aria-label], [data-testid]";
  return {
    url: location.href,
    capturedAt: new Date().toISOString(),
    elements: Array.from(document.querySelectorAll(sel))
      .filter((el) => isVisible(el) && el.type !== "hidden")
      .slice(0, 300)
      .map(desc)
  };
});
const file = writeJson("cover-form.json", form);
console.log("Wrote " + file);
console.log("Screenshots in " + OUT_DIR);
process.exit(0);
