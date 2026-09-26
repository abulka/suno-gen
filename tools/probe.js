/**
 * Runs an arbitrary JS expression in the live Suno page and prints the result.
 * The expression is evaluated as a function body; use `return` for a value.
 *
 *   node tools/probe.js --url=https://suno.com/me "return document.title"
 *   node tools/probe.js "return [...document.querySelectorAll('[role=group]')].length"
 */
import { connect, sunoPage, looksLoggedOut } from "./lib.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arg = (i) => process.argv[i] || "";
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const targetUrl = urlArg ? urlArg.slice("--url=".length) : "";
const clickSel = process.argv.find((a) => a.startsWith("--click="));
const clickText = process.argv.find((a) => a.startsWith("--click-text="));
const clickRe = process.argv.find((a) => a.startsWith("--click-re="));
const clickAt = process.argv.find((a) => a.startsWith("--click-at="));
const shotArg = process.argv.find((a) => a.startsWith("--shot="));
const waitMs = Number((process.argv.find((a) => a.startsWith("--wait=")) || "--wait=800").split("=")[1]);
const code = process.argv.slice(2).find((a) => !a.startsWith("--")) || "return document.title";

const { ctx } = await connect();
const page = await sunoPage(ctx, targetUrl || "https://suno.com/create");
if (targetUrl && !page.url().startsWith(targetUrl)) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
}
if (await looksLoggedOut(page)) {
  console.error("Not logged in.");
  process.exit(1);
}

if (process.argv.includes("--inject")) {
  const SRC = path.join(__dirname, "..", "src");
  for (const f of ["shared/title.js", "content/selectors.js", "content/cover-flow.js"]) {
    await page.addScriptTag({ path: path.join(SRC, f) });
  }
  await page.waitForTimeout(300);
}

if (clickSel) {
  await page.locator(clickSel.slice("--click=".length)).first().click({ timeout: 5000 }).catch((e) => {
    console.error("click failed:", String(e).slice(0, 160));
  });
  await page.waitForTimeout(waitMs);
}
if (clickText) {
  const wanted = clickText.slice("--click-text=".length);
  await page
    .locator("button,[role='button'],div")
    .filter({ hasText: new RegExp("^" + wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") })
    .first()
    .click({ timeout: 5000 })
    .catch((e) => console.error("click-text failed:", String(e).slice(0, 160)));
  await page.waitForTimeout(waitMs);
}
if (clickAt) {
  const [x, y] = clickAt.slice("--click-at=".length).split(",").map(Number);
  await page.mouse.click(x, y);
  await page.waitForTimeout(waitMs);
}
if (clickRe) {
  const re = new RegExp(clickRe.slice("--click-re=".length));
  await page
    .getByText(re)
    .first()
    .click({ timeout: 5000 })
    .catch((e) => console.error("click-re failed:", String(e).slice(0, 200)));
  await page.waitForTimeout(waitMs);
}
if (shotArg) {
  await page.screenshot({ path: "tools/out/" + shotArg.slice("--shot=".length) });
}

const result = await page
  .evaluate("(async function(){ " + code + " })()")
  .catch((err) => ({ __error: String(err) }));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
