/**
 * SunoGen shared naming helpers.
 *
 * Title template:   {date} {take}-{rating} {styleCode} - {songName}
 * Example:          "26-9 01-iiiN qhvy - happy song"
 *
 * `take` and `rating` are optional: the "{take}-{rating}" segment collapses to
 * whichever is present (and disappears entirely when both are empty).
 *
 * `take` is the BASE for the first style; each subsequent style steps it by 2
 * (Suno always generates 2 clips per Create, so the 2nd is reserved for manual
 * editing): 06, 08, 10, …
 *
 * Usage:
 *   date     -> "26-9"  (year last-2 + "-" + month, no zero padding on month)
 *   take     -> "01"    (2-digit base, shared across all styles of one song idea)
 *   rating   -> "iiiN"  (literal; "iii" is the searchable prefix, N is edited later 1..5)
 *   styleCode-> "qhvy"  (per preset)
 *   songName -> "happy song"
 *
 * Default workspace: "{date} {songName}" e.g. "26-9 bird song"
 */
(function (root) {
  "use strict";

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function todayYYM(now) {
    const d = now ? new Date(now) : new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const m = d.getMonth() + 1;
    return yy + "-" + m;
  }

  /** "" when empty (take is optional), else 2-digit. */
  function normalizeTake(take) {
    if (take === undefined || take === null) return "";
    const s = String(take).trim();
    if (!s) return "";
    const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
    if (isNaN(n)) return "";
    return pad2(n);
  }

  /** Base take + offset (e.g. 06 -> 08), or "" when there is no take. */
  function offsetTake(take, offset) {
    const base = normalizeTake(take);
    if (!base) return "";
    return pad2(parseInt(base, 10) + (Number(offset) || 0));
  }

  function buildTitle(cfg) {
    const date = (cfg.date || "").trim();
    const take = normalizeTake(cfg.take);
    const rating = (cfg.rating || "").trim();
    const styleCode = (cfg.styleCode || "").trim().replace(/\s+/g, "").slice(0, 8);
    const songName = (cfg.songName || "").trim();
    const tr = [take, rating].filter(Boolean).join("-");
    const head = [date, tr, styleCode].filter(Boolean).join(" ");
    return songName ? head + " - " + songName : head;
  }

  /**
   * Derive a song name from a picked source's title.
   *   "2026-07-28 arlie · bb7c68e4-…"          -> "arlie"
   *   "2026-08-28 70s nu jam - truck"          -> "truck"
   *   "2026-08-28 01-iii2 gm art jam - truck (x)"-> "truck (x)"
   *   "26-9 06-iiiN artjam - truZ"             -> "truZ"
   */
  function deriveSongName(rawTitle) {
    let s = String(rawTitle || "").trim();
    const dot = s.indexOf("·");
    if (dot !== -1) s = s.slice(0, dot).trim();
    s = s.replace(/\s+[0-9a-f]{8}-[0-9a-f-]{8,}$/i, "").trim();
    s = s.replace(/^\d{4}-\d{1,2}-\d{1,2}\s+/, "");
    s = s.replace(/^\d{1,2}-\d{1,2}\s+/, "");
    const parts = s.split(" - ");
    if (parts.length > 1) return parts[parts.length - 1].trim();
    s = s.replace(/^\d{1,2}-[A-Za-z0-9]+\s*/, "");
    s = s.replace(/^\d{1,2}\s+/, "");
    return s.trim();
  }

  function buildWorkspace(cfg) {
    const date = (cfg.date || "").trim();
    const songName = (cfg.songName || "").trim();
    return (date + " " + songName).trim();
  }

  /** The name to use for a source: explicit override, else derived, else title. */
  function sourceName(source) {
    return String(
      (source && source.songName && String(source.songName).trim()) ||
        deriveSongName(source && source.title) ||
        (source && source.title) ||
        ""
    ).trim();
  }

  /**
   * Names for a list of sources, disambiguating collisions with a short clip-id
   * suffix (e.g. two "truck" sources -> "truck-a1b2", "truck-9f3c"). Stable so
   * the panel listing, preview and execution all agree.
   */
  function uniqueSourceNames(sources) {
    const list = Array.isArray(sources) ? sources : [];
    const base = list.map((s) => sourceName(s) || "song");
    const counts = new Map();
    base.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
    const used = new Set();
    return base.map((n, i) => {
      let name = n;
      if (counts.get(n) > 1) {
        const id = String((list[i] && list[i].clipId) || "")
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 4)
          .toLowerCase();
        name = id ? n + "-" + id : n + "-" + (i + 1);
      }
      let cand = name;
      let bump = 1;
      while (used.has(cand)) cand = name + "-" + ++bump;
      used.add(cand);
      return cand;
    });
  }

  /**
   * Resolve the workspace for a preset, in priority order:
   *   1. preset workspace override
   *   2. the batch's explicit workspace (manual or auto-derived in the panel)
   *   3. a fallback derived from date + song name
   */
  function resolveWorkspace(batch, preset) {
    if (preset && preset.workspaceOverride && preset.workspaceOverride.trim()) {
      return preset.workspaceOverride.trim();
    }
    if (batch && batch.workspace && String(batch.workspace).trim()) {
      return String(batch.workspace).trim();
    }
    return buildWorkspace(batch);
  }

  root.SunoGenTitle = {
    pad2: pad2,
    todayYYM: todayYYM,
    normalizeTake: normalizeTake,
    offsetTake: offsetTake,
    deriveSongName: deriveSongName,
    sourceName: sourceName,
    uniqueSourceNames: uniqueSourceNames,
    buildTitle: buildTitle,
    buildWorkspace: buildWorkspace,
    resolveWorkspace: resolveWorkspace
  };
})(globalThis);
