/**
 * SunoGen shared naming helpers.
 *
 * Title template:   {date} {take}-{rating} {styleCode} - {songName}
 * Example:          "26-9 01-iiiN qhvy - happy song"
 *
 * Usage:
 *   date     -> "26-9"  (year last-2 + "-" + month, no zero padding on month)
 *   take     -> "01"    (2-digit, shared across all styles of one song idea)
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

  function normalizeTake(take) {
    if (take === undefined || take === null || take === "") return "01";
    const n = parseInt(String(take).replace(/[^0-9]/g, ""), 10);
    if (isNaN(n)) return "01";
    return pad2(n);
  }

  function buildTitle(cfg) {
    const date = (cfg.date || "").trim();
    const take = normalizeTake(cfg.take);
    const rating = (cfg.rating || "iiiN").trim();
    const styleCode = (cfg.styleCode || "").trim().replace(/\s+/g, "").slice(0, 8);
    const songName = (cfg.songName || "").trim();
    return date + " " + take + "-" + rating + " " + styleCode + " - " + songName;
  }

  function buildWorkspace(cfg) {
    const date = (cfg.date || "").trim();
    const songName = (cfg.songName || "").trim();
    return (date + " " + songName).trim();
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
    buildTitle: buildTitle,
    buildWorkspace: buildWorkspace,
    resolveWorkspace: resolveWorkspace
  };
})(globalThis);
