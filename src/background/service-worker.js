"use strict";

const STORAGE_KEYS = ["presets", "settings", "lastBatch"];

const DOWNLOADED_KEY = "downloadedClips";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const DEFAULT_SETTINGS = {
  delayMs: 4000,
  maxConcurrent: 3,
  rating: "iiiN",
  autoDeriveWorkspace: true,
  showUnlockBadge: true,
  showDiskBadge: true,
  showHistoryBadge: true
};

const DEFAULT_PRESETS = [
  {
    id: "seed-qhvy",
    name: "QH Vibe",
    styleCode: "qhvy",
    stylePrompt: "",
    workspaceOverride: "",
    instrumental: false
  }
];

async function seedDefaults() {
  const current = await chrome.storage.local.get(STORAGE_KEYS);
  const patch = {};
  if (!Array.isArray(current.presets)) patch.presets = DEFAULT_PRESETS;
  if (!current.settings || typeof current.settings !== "object") {
    patch.settings = DEFAULT_SETTINGS;
  } else {
    patch.settings = Object.assign({}, DEFAULT_SETTINGS, current.settings);
  }
  await chrome.storage.local.set(patch);
}

async function enablePanelOnActionClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("[SunoGen] setPanelBehavior failed", err);
  }
}

/**
 * Local "downloaded to disk" tracking. Suno Manager only watched live
 * chrome.downloads events, so it forgot everything on reinstall; matching the
 * clip UUID in the signed download URL lets us also backfill from Chrome's
 * download history. Records are per-profile and stay in storage.local.
 *
 * Downloads may arrive via a blob: URL (the UUID there is random), so UUIDs are
 * only trusted from http(s) URLs; otherwise the title -> id map collected from
 * the feed is used to match the suggested filename.
 */
const TITLES_KEY = "clipTitles";
const titleToId = new Map();

function stemOf(filename) {
  return String(filename || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.(mp3|wav|m4a|mp4|flac|ogg|aac|opus)$/i, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim()
    .toLowerCase();
}

function uuidFromUrls(item) {
  const hay = `${item.url || ""} ${item.finalUrl || ""}`
    .replace(/blob:[^\s]+/gi, " ")
    .replace(/data:[^\s]+/gi, " ");
  const m = hay.match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

function identifyDownload(item) {
  if (!item) return null;
  const hay = `${item.url || ""} ${item.finalUrl || ""}`;
  const uuid = uuidFromUrls(item);
  const looksSuno = /suno/i.test(hay) || /\/clip\/[0-9a-f-]{8}/i.test(hay);
  if (uuid && looksSuno) return uuid;
  // Filename fallback covers blob: downloads (whose URL carries a random UUID)
  // and signed URLs that omit "suno". Titles may have been prefixed by another
  // extension (e.g. "<artist> - <title>"), so suffix matching is allowed too.
  const stem = stemOf(item.filename);
  if (stem) {
    if (titleToId.has(stem)) return titleToId.get(stem);
    const suffixed = matchTitleSuffix(stem);
    if (suffixed) return suffixed;
  }
  if (uuid && /suno/i.test(item.referrer || "")) return uuid;
  return null;
}

function matchTitleSuffix(stem) {
  for (const [title, id] of titleToId) {
    if (title.length < 6) continue;
    if (stem === title) return id;
    if (stem.endsWith(title)) {
      const prefix = stem.slice(0, stem.length - title.length);
      if (prefix.endsWith(" - ") || prefix === "- ") return id;
    }
  }
  return null;
}

async function recordHistory(id, info) {
  const store = await chrome.storage.local.get(DOWNLOADED_KEY);
  const current = store[DOWNLOADED_KEY] || {};
  const entry = current[id] || {};
  if (entry.history) return false;
  entry.history = Object.assign({ at: Date.now() }, info);
  current[id] = entry;
  await chrome.storage.local.set({ [DOWNLOADED_KEY]: current });
  return true;
}

/**
 * Tell the side panel (if open) that a new download finished so it can rescan
 * the connected folder and surface the on-disk badge. The panel is the only
 * context holding the File System Access handle, so it owns the scan.
 */
function notifyDownloaded(id) {
  try {
    const p = chrome.runtime.sendMessage({ type: "SUNOGEN_DOWNLOADED", id: id });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (err) {
    /* no panel open */
  }
}

async function loadClipTitles() {
  try {
    const store = await chrome.storage.local.get(TITLES_KEY);
    const map = store[TITLES_KEY] || {};
    for (const id of Object.keys(map)) {
      const title = map[id];
      if (title) titleToId.set(String(title).trim().toLowerCase(), id);
    }
  } catch (err) {
    /* ignore */
  }
}

async function rememberClipTitles(items) {
  if (!Array.isArray(items) || !items.length) return;
  const store = await chrome.storage.local.get(TITLES_KEY);
  const map = store[TITLES_KEY] || {};
  let changed = false;
  for (const item of items) {
    if (!item || !item.id || !item.title) continue;
    const key = String(item.title).trim().toLowerCase();
    if (!key) continue;
    titleToId.set(key, item.id);
    if (map[item.id] !== item.title) {
      map[item.id] = item.title;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [TITLES_KEY]: map });
  // Titles just became available: retry the history backfill so downloads the
  // user made before installing (or before the feed loaded) get matched.
  scheduleBackfill();
}

let backfillTimer = null;
function scheduleBackfill() {
  if (backfillTimer) return;
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    backfillDownloads();
  }, 1500);
}

async function backfillDownloads() {
  let items = [];
  try {
    items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 3000 });
  } catch (err) {
    return;
  }
  const store = await chrome.storage.local.get(DOWNLOADED_KEY);
  const current = store[DOWNLOADED_KEY] || {};
  let changed = false;
  for (const item of items) {
    if (!item) continue;
    const id = identifyDownload(item);
    if (!id) continue;
    const entry = current[id] || {};
    if (entry.history) continue;
    const at = item.startTime ? Date.parse(item.startTime) : Date.now();
    entry.history = { at: Number.isFinite(at) ? at : Date.now(), filename: item.filename || null };
    current[id] = entry;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [DOWNLOADED_KEY]: current });
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || !delta.state || delta.state.current !== "complete") return;
    chrome.downloads
      .search({ id: delta.id })
      .then((items) => {
        const item = items && items[0];
        const id = identifyDownload(item);
        if (!id) return;
        return recordHistory(id, { filename: item.filename || null }).then((changed) => {
          if (changed) notifyDownloaded(id);
        });
      })
      .catch(() => {});
  });
}

async function initDownloadTracking() {
  await loadClipTitles();
  await backfillDownloads();
}

// Warm the title map as soon as the worker spins up so live downloads match.
loadClipTitles();

chrome.runtime.onInstalled.addListener(() => {
  seedDefaults();
  enablePanelOnActionClick();
  initDownloadTracking();
});

chrome.runtime.onStartup.addListener(() => {
  enablePanelOnActionClick();
  initDownloadTracking();
});

/**
 * Relay a message from a content script to the side panel (and vice versa is
 * handled directly by the panel). Kept here so future work has a single place
 * to fan out notifications.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "SUNOGEN_GET_TAB") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => sendResponse({ ok: true, tab: tabs[0] || null }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "SUNOGEN_CLIP_TITLES") {
    rememberClipTitles(msg.items)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
