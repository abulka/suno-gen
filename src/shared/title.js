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
   * Trailing "mangled" markers are the user's own processing tags (the audio
   * was filtered/EQ'd to pass Suno's originality gate), not part of the song
   * name: "2026-06-28 fine - mangled" is the song "fine", and
   * "2026-07-24 seqout mangled2" is "seqout".
   *
   * `uniqueSourceNames` may also have appended a short clip-id suffix to an
   * old, wrongly derived name ("mangled-8be1"), so tolerate that too. The
   * captured group is separated by a dash or whitespace so a name that merely
   * contains "mangled" is left alone.
   */
  const MARKER_RE = /(?:^|[\s\-–—])(mangled\d*)(?:[-_][0-9a-z]{4,8})?$/i;

  /**
   * Fragment markers ("frag1", "frag2", "fragment1") indicate a fragment of a
   * longer idea; they are not the song name. Without this, a source like
   * "multiple guitars - maton arrives - frag1" derives to just "frag1" and the
   * descriptive part is lost.
   */
  const FRAGMENT_RE = /(?:^|[\s\-–—])(frag(?:ment)?\d+)(?:[-_][0-9a-z]{4,8})?$/i;

  /** True when the whole value is just a processing marker. */
  function isProcessingMarker(text) {
    return /^mangled\d*(?:[-_][0-9a-z]{4,8})?$/i.test(String(text || "").trim());
  }

  /** True when the whole value is just a fragment marker. */
  function isFragmentMarker(text) {
    return /^frag(?:ment)?\d+(?:[-_][0-9a-z]{4,8})?$/i.test(String(text || "").trim());
  }

  function stripByRe(text, re) {
    const s = String(text || "").trim();
    const m = s.match(re);
    if (!m) return s;
    return s
      .slice(0, m.index)
      .replace(/[\s\-–—]+$/, "")
      .trim();
  }

  /**
   * Remove a trailing processing marker (and an optional clip-id suffix):
   *   "mangled-8be1"                  -> ""
   *   "mangled2"                      -> ""
   *   "seqout mangled2"               -> "seqout"
   *   "farm v2 mangled"               -> "farm v2"
   */
  function stripProcessingMarker(text) {
    return stripByRe(text, MARKER_RE);
  }

  /** Remove a trailing fragment marker (and an optional clip-id suffix). */
  function stripFragmentMarker(text) {
    return stripByRe(text, FRAGMENT_RE);
  }

  /** Strip any trailing processing/fragment markers, repeatedly. */
  function stripTrailingMarker(text) {
    let s = String(text || "").trim();
    for (let i = 0; i < 5; i++) {
      const next = stripFragmentMarker(stripProcessingMarker(s));
      if (next === s) break;
      s = next;
    }
    return s;
  }

  /** True when applying either marker strip changes the value. */
  function hasTrailingMarker(text) {
    const s = String(text || "").trim();
    return stripTrailingMarker(s) !== s;
  }

  /**
   * Derive a song name from a picked source's title.
   *
   * Rule: strip trailing processing/fragment markers. If a marker was removed,
   * keep the whole remaining descriptive name ("multiple guitars - maton
   * arrives - frag1" -> "multiple guitars - maton arrives"). Otherwise the last
   * " - " segment is the song name ("70s nu jam - truck" -> "truck").
   *
   *   "2026-07-28 arlie · bb7c68e4-…"          -> "arlie"
   *   "2026-08-28 70s nu jam - truck"          -> "truck"
   *   "2026-08-28 01-iii2 gm art jam - truck (x)"-> "truck (x)"
   *   "26-9 06-iiiN artjam - truZ"             -> "truZ"
   *   "2026-06-28 fine - mangled"              -> "fine"
   *   "2026-06-28 - anne - mangled"            -> "anne"
   *   "2026-07-24 seqout mangled2"             -> "seqout"
   *   "multiple guitars - maton arrives - frag1"   -> "multiple guitars - maton arrives"
   *   "post a30p dedication 01 - frag1 mangled"    -> "post a30p dedication 01"
   */
  function deriveSongName(rawTitle) {
    let s = String(rawTitle || "").trim();
    const dot = s.indexOf("·");
    if (dot !== -1) s = s.slice(0, dot).trim();
    s = s.replace(/\s+[0-9a-f]{8}-[0-9a-f-]{8,}$/i, "").trim();

    // Split on the song-name separator only. Dates use plain hyphens, so they
    // survive this step.
    const parts = s.split(" - ").map((p) => p.trim()).filter(Boolean);
    let droppedMarker = false;

    // Peel trailing marker/fragment segments (and markers inside the last
    // segment, e.g. "frag1 mangled").
    while (parts.length) {
      const last = parts[parts.length - 1];
      if (isProcessingMarker(last) || isFragmentMarker(last)) {
        parts.pop();
        droppedMarker = true;
        continue;
      }
      const stripped = stripTrailingMarker(last);
      if (stripped !== last) {
        droppedMarker = true;
        if (!stripped || isProcessingMarker(stripped) || isFragmentMarker(stripped)) {
          parts.pop();
        } else {
          parts[parts.length - 1] = stripped;
        }
        continue;
      }
      break;
    }

    if (!parts.length) return "";

    if (!droppedMarker && parts.length > 1) {
      return parts[parts.length - 1].trim();
    }

    s = parts.join(" - ");
    // Strip a leading source date (with an optional following separator) and
    // an old take/rating prefix.
    s = s.replace(/^\d{4}-\d{1,2}-\d{1,2}\s*(?:[-–—]\s*)?/, "");
    s = s.replace(/^\d{1,2}-\d{1,2}\s+/, "");
    if (!s) return "";
    s = stripTrailingMarker(s);
    s = s.replace(/^\d{1,2}-[A-Za-z0-9]+\s*/, "");
    s = s.replace(/^\d{1,2}\s+/, "");
    return s.trim();
  }

  /** Split a full title into its generated head and song-name part. */
  function splitTitle(title) {
    const s = String(title || "");
    const i = s.indexOf(" - ");
    if (i === -1) return { head: "", songName: s.trim() };
    return { head: s.slice(0, i).trim(), songName: s.slice(i + 3).trim() };
  }

  function joinTitle(head, songName) {
    const h = String(head || "").trim();
    const n = String(songName || "").trim();
    if (!h) return n;
    if (!n) return h;
    return h + " - " + n;
  }

  /**
   * Repair an existing song-name part (used by the bulk title repair tool).
   * Prefer stripping the marker from the old name because that preserves any
   * user formatting ("post a30p 70s - dedication 01 - frag1 mangled" ->
   * "dedication 01"). If the old name was only a marker/fragment
   * ("mangled-8be1", "frag1-767f"), fall back to the name derived from the
   * cover's source clip.
   */
  function repairSongName(oldSongName, derivedName) {
    const cleaned = stripTrailingMarker(oldSongName);
    if (cleaned && !isProcessingMarker(cleaned) && !isFragmentMarker(cleaned)) {
      return cleaned;
    }
    return String(derivedName || "").trim() || cleaned;
  }

  function buildWorkspace(cfg) {
    const date = (cfg.date || "").trim();
    const songName = (cfg.songName || "").trim();
    return (date + " " + songName).trim();
  }

  /** The name to use for a source: explicit override, else derived, else title. */
  function sourceName(source) {
    let override = (source && source.songName && String(source.songName).trim()) || "";
    // A stored name that is only a leaked processing/fragment marker
    // ("mangled", "mangled-8be1", "frag1") is not a real override; derive from
    // the title instead so a stale panel state can never reintroduce it. A
    // marker left at the end of a real name is stripped too.
    if (override) {
      override = stripTrailingMarker(override);
      if (!override || isProcessingMarker(override) || isFragmentMarker(override)) override = "";
    }
    return String(override || deriveSongName(source && source.title) || (source && source.title) || "").trim();
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
    isProcessingMarker: isProcessingMarker,
    isFragmentMarker: isFragmentMarker,
    stripProcessingMarker: stripProcessingMarker,
    stripFragmentMarker: stripFragmentMarker,
    stripTrailingMarker: stripTrailingMarker,
    hasTrailingMarker: hasTrailingMarker,
    deriveSongName: deriveSongName,
    splitTitle: splitTitle,
    joinTitle: joinTitle,
    repairSongName: repairSongName,
    sourceName: sourceName,
    uniqueSourceNames: uniqueSourceNames,
    buildTitle: buildTitle,
    buildWorkspace: buildWorkspace,
    resolveWorkspace: resolveWorkspace
  };
})(globalThis);
