/**
 * Exercise the SHIPPING songs collector (src/content/catalog.js) against live
 * Suno, then assert the `suno-songs/v1` contract the workflow app relies on.
 *
 *   node tools/probe-songs.js            # full library + assertions
 *   node tools/probe-songs.js --pages=3  # first N feed pages only (no assertions)
 *
 * Assertions (exit code 1 on failure):
 *   - songCount === songs.length
 *   - every song has boolean isLiked / isDisliked
 *   - likedAt is null or a parseable ISO timestamp
 *   - counts.liked + counts.disliked <= songCount
 *   - filters echo is present and mentions disliked:"Any"
 *   - rows are sorted (project name → createdAt → id)
 *   - sum(workspace clip counts) is within 5% of songCount (soft check: the
 *     clip counts are Suno's cached aggregates, so this can drift)
 */
import { connect, sunoPage, looksLoggedOut, writeJson } from "./lib.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const targetUrl = urlArg ? urlArg.slice("--url=".length) : "https://suno.com/create";
const pagesArg = process.argv.find((a) => a.startsWith("--pages="));
const maxPages = pagesArg ? Number(pagesArg.split("=")[1]) : 0;

const { ctx } = await connect();
const page = await sunoPage(ctx, targetUrl);
if (await looksLoggedOut(page)) {
  console.error("Not logged in.");
  process.exit(1);
}
for (const f of ["shared/title.js", "content/selectors.js", "content/catalog.js"]) {
  await page.addScriptTag({ path: path.join(SRC, f) });
}

const out = await page.evaluate(async (maxPages) => {
  const C = globalThis.SunoGenCatalog;
  const progress = [];
  const t0 = Date.now();
  let res;
  if (maxPages > 0) {
    const seen = new Map();
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const r = await C.internals.fetchFeedPage(cursor);
      for (const c of r.clips) {
        const s = C.internals.toSong(c);
        if (s && !seen.has(s.id)) seen.set(s.id, s);
      }
      cursor = r.cursor;
      if (!r.hasMore || !r.clips.length || !cursor) break;
    }
    res = {
      songs: [...seen.values()].sort(C.internals.compareSongs),
      songCount: seen.size,
      pages: maxPages,
      complete: false,
      filters: C.internals.filterEcho(),
      counts: { liked: 0, disliked: 0 },
      incompleteReason: "probe limited to " + maxPages + " pages"
    };
    for (const s of res.songs) {
      if (s.isLiked) res.counts.liked++;
      if (s.isDisliked) res.counts.disliked++;
    }
  } else {
    res = await C.collectSongs({ expected: 0, onProgress: (p) => progress.push(p) });
  }

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/;
  const cmp = C.internals.compareSongs;
  return {
    ms: Date.now() - t0,
    count: res.songs.length,
    songCount: res.songCount,
    pages: res.pages,
    complete: res.complete,
    incompleteReason: res.incompleteReason || null,
    filters: res.filters,
    counts: res.counts,
    withWorkspace: res.songs.filter((s) => s.project).length,
    orphans: res.songs.filter((s) => !s.project).map((s) => s.id),
    uploads: res.songs.filter((s) => s.type === "upload").length,
    bytes: JSON.stringify(res.songs).length,
    progressCount: progress.length,
    lastProgress: progress[progress.length - 1] || null,
    first: res.songs[0],
    orphanSample: res.songs.find((s) => !s.project) || null,
    // contract checks, evaluated in the page so they use the shipping code
    failures: [
      res.songCount === res.songs.length ? null : "songCount !== songs.length",
      res.songs.every((s) => typeof s.isLiked === "boolean") ? null : "isLiked not boolean on every song",
      res.songs.every((s) => typeof s.isDisliked === "boolean") ? null : "isDisliked not boolean on every song",
      res.songs.every((s) => s.likedAt === null || iso.test(String(s.likedAt)))
        ? null
        : "likedAt not null/ISO",
      res.counts.liked + res.counts.disliked <= res.songCount ? null : "counts exceed songCount",
      res.songs.every((s) => s.project === null || (s.project && s.project.id && s.project.name))
        ? null
        : "project malformed",
      res.songs.every((s, i) => i === 0 || cmp(res.songs[i - 1], s) <= 0) ? null : "not sorted",
      res.filters && res.filters.disliked === "Any" ? null : "filters echo missing/wrong"
    ].filter(Boolean),
    sorted: res.songs.every((s, i) => i === 0 || cmp(res.songs[i - 1], s) <= 0)
  };
}, maxPages);

// Soft check: workspace clip counts are Suno's cached aggregates.
let workspaceDelta = null;
if (!maxPages) {
  const ws = await page.evaluate(async () => {
    const C = globalThis.SunoGenCatalog;
    const res = await C.collectWorkspaces({ onProgress: () => {} });
    return res.workspaces.reduce((n, w) => n + (Number(w.clipCount) || 0), 0);
  });
  workspaceDelta = {
    sumWorkspaceClips: ws,
    songCount: out.songCount,
    diff: ws - out.songCount,
    pct: Math.round(((ws - out.songCount) / (ws || 1)) * 1000) / 10
  };
}

const file = writeJson("songs-probe.json", { ...out, workspaceDelta });
console.log(
  JSON.stringify(
    {
      ms: out.ms,
      count: out.count,
      songCount: out.songCount,
      pages: out.pages,
      complete: out.complete,
      filters: out.filters,
      counts: out.counts,
      sorted: out.sorted,
      withWorkspace: out.withWorkspace,
      orphans: out.orphans.length,
      uploads: out.uploads,
      kb: Math.round(out.bytes / 1024),
      progressEvents: out.progressCount,
      lastProgress: out.lastProgress,
      workspaceDelta
    },
    null,
    2
  )
);
console.log("first song:", JSON.stringify(out.first));
console.log("orphan:", JSON.stringify(out.orphanSample));
console.log("Wrote", file);

if (!maxPages && out.failures.length) {
  console.error("\nCONTRACT FAILURES:");
  out.failures.forEach((f) => console.error(" - " + f));
  process.exit(1);
}
if (workspaceDelta && Math.abs(workspaceDelta.pct) > 5) {
  console.warn(
    "\nWARN: sum(workspace clip counts) differs from songCount by " +
      workspaceDelta.diff +
      " (" +
      workspaceDelta.pct +
      "%) — expected a small gap from stems/studio/trashed clips."
  );
}
console.log("all contract assertions passed");
process.exit(0);
