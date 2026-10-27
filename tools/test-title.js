/**
 * Pure-logic checks for the naming helpers. Dev-only, no browser needed:
 *
 *   node tools/test-title.js
 */
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/shared/title.js", import.meta.url), "utf8");
const context = { globalThis: null };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const T = context.SunoGenTitle;

let failed = 0;
function eq(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + label + " => " + JSON.stringify(actual) + (ok ? "" : " (expected " + JSON.stringify(expected) + ")"));
}

// --- deriveSongName: processing markers are not song names ---
eq(T.deriveSongName("2026-06-28 fine - mangled"), "fine", "mangled suffix");
eq(T.deriveSongName("2026-06-28 - anne - mangled"), "anne", "empty segment + mangled");
eq(T.deriveSongName("2026-06-28 vera - mangled"), "vera", "vera");
eq(T.deriveSongName("2026-06-28 rythmtron - mangled"), "rythmtron", "rythmtron");
eq(T.deriveSongName("2026-06-27 chop - mangled"), "chop", "chop");
eq(T.deriveSongName("2026-06-16 ballan v2 - mangled"), "ballan v2", "versioned name");
eq(T.deriveSongName("2026-06-25 compose-permutator v3 - mangled"), "compose-permutator v3", "long name");
eq(T.deriveSongName("2026-06-14 farm v2 mangled"), "farm v2", "space-separated mangled");
eq(T.deriveSongName("2026-07-24 seqout mangled2"), "seqout", "mangled2");
eq(T.deriveSongName("2026-06-28 fine - mangled-8be1"), "fine", "dedupe suffix on marker");

// --- deriveSongName: existing conventions still work ---
eq(T.deriveSongName("2026-06-27 real use"), "real use", "plain name");
eq(T.deriveSongName("2026-06-15 70s zsil"), "70s zsil", "name starting with digits");
eq(T.deriveSongName("2026-08-28 70s nu jam - truck"), "truck", "last segment");
eq(T.deriveSongName("2026-08-28 01-iii2 gm art jam - truck (x)"), "truck (x)", "parenthetical");
eq(T.deriveSongName("26-9 06-iiiN artjam - truZ"), "truZ", "already generated title");
eq(T.deriveSongName("2026-07-28 arlie · bb7c68e4-1111-2222-3333-444444444444"), "arlie", "uuid suffix");

// --- sourceName ignores leaked marker overrides ---
eq(T.sourceName({ title: "2026-06-28 fine - mangled", songName: "mangled" }), "fine", "stale marker override ignored");
eq(T.sourceName({ title: "2026-06-28 fine - mangled", songName: "mangled-8be1" }), "fine", "stale dedupe override ignored");
eq(T.sourceName({ title: "2026-06-28 fine - mangled", songName: "my fine" }), "my fine", "real override kept");

// --- title split/join ---
eq(T.joinTitle("26-10 iiiN artjam", "fine"), "26-10 iiiN artjam - fine", "join title");
eq(T.splitTitle("post a30p 70s - dedication 01 - frag1 mangled").head, "post a30p 70s", "split keeps later separators");
eq(T.splitTitle("post a30p 70s - dedication 01 - frag1 mangled").songName, "dedication 01 - frag1 mangled", "split song name");

// --- repairSongName ---
eq(T.repairSongName("mangled-8be1", "fine"), "fine", "pure marker falls back to derived");
eq(T.repairSongName("mangled", "anne"), "anne", "pure marker");
eq(T.repairSongName("seqout mangled2", "seqout"), "seqout", "strip marker, keep name");
eq(T.repairSongName("dedication 01 - frag1 mangled", "frag1"), "dedication 01 - frag1", "preserve inner separators");
eq(T.repairSongName("fine", "fine"), "fine", "no marker");

// --- full title build ---
eq(
  T.buildTitle({ date: "26-10", take: "02", rating: "iiiN", styleCode: "artjam", songName: "fine" }),
  "26-10 02-iiiN artjam - fine",
  "buildTitle"
);

if (failed) {
  console.error("\n" + failed + " check(s) failed.");
  process.exit(1);
}
console.log("\nAll title checks passed.");
