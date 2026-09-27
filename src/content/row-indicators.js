/**
 * SunoGen row download indicators.
 *
 * Adds small badges to each library clip row's cover showing independent facts:
 *   - unlock  (top-left, grey padlock)  Suno's `is_download_unlocked`: the
 *              download is already paid for, so re-download is free. Only shown
 *              when unlocked — locked clips get nothing (less noise).
 *   - seed    (top-left, purple sprout) the unlocked clip is your own upload
 *              (authored original), distinguished from a normal generation.
 *   - history (top-left, violet arrow)  a download for this clip was seen in
 *              Chrome's download history (weaker signal; can expire).
 *   - disk    (top-right, green tick)   a file for this clip was found on disk
 *              by the authoritative folder scan; tooltip shows the path.
 *
 * Data: `clip-meta` from the MAIN-world page hook relayed on the window, and
 * chrome.storage.local.downloadedClips written by the service worker (history)
 * and the panel's folder scan (disk). Rendering survives virtualization via a
 * debounced MutationObserver.
 */
(function () {
  "use strict";

  const KEY = "__sunogenRowIndicators";
  if (globalThis[KEY] && typeof globalThis[KEY].destroy === "function") {
    try {
      globalThis[KEY].destroy();
    } catch (err) {
      /* ignore */
    }
  }

  const S = globalThis.SunoGenSelectors;
  const DATA_KEY = "downloadedClips";
  const GROUP_CLASS = "sunogen-dl-badges";
  const DISK_CLASS = "sunogen-dl-disk";
  const BADGE_CLASS = "sunogen-dl-badge";

  const meta = new Map();
  const facts = new Map();
  let settings = { showUnlockBadge: true, showDiskBadge: true, showHistoryBadge: true };
  let scanTimer = null;
  let stopped = false;

  const ICON = {
    unlocked:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-.9"/></svg>',
    seed:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20v-7"/><path d="M12 13c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6z"/><path d="M12 13c0-2.8-2-5-5-5 0 2.8 2 5 5 5z"/></svg>',
    history:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
    disk:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
  };

  function clipIdFromRow(row) {
    const link = row.querySelector("a[href*='/song/'], a[href*='/clip/']");
    if (link) {
      const m = (link.getAttribute("href") || "").match(/\/(?:song|clip)\/([a-zA-Z0-9-]+)/);
      if (m) return m[1];
    }
    return row.getAttribute("data-clip-id") || row.getAttribute("data-id") || null;
  }

  function coverOf(row) {
    return S && S.findIn ? S.findIn(row, "clipCover") : row.querySelector(".clip-image-container, img");
  }

  function prepareRow(row) {
    if (getComputedStyle(row).position === "static") row.style.position = "relative";
  }

  function makeBadge(kind, title) {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS + " sunogen-dl-" + kind;
    badge.innerHTML = ICON[kind] || "";
    badge.title = title;
    return badge;
  }

  function basename(path) {
    const s = String(path || "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i === -1 ? s : s.slice(i + 1);
  }

  /** Left group: unlocked (or upload seed) + download-history, cover corner. */
  function renderLeft(row, info) {
    let group = row.querySelector(":scope > ." + GROUP_CLASS);
    const wanted = [];
    if (settings.showUnlockBadge && info.unlocked) {
      wanted.push(
        info.upload
          ? makeBadge("seed", "Your upload — unlocked (free re-download)")
          : makeBadge("unlocked", "Unlocked — re-download is free")
      );
    }
    if (settings.showHistoryBadge && info.history) {
      const name = basename(info.history.filename);
      wanted.push(
        makeBadge("history", "Download detected in Chrome history" + (name ? " · " + name : ""))
      );
    }

    if (!wanted.length) {
      if (group) group.remove();
      return;
    }
    if (!group) {
      prepareRow(row);
      group = document.createElement("div");
      group.className = GROUP_CLASS;
      row.appendChild(group);
    }
    group.innerHTML = "";
    wanted.forEach((b) => group.appendChild(b));

    const cover = coverOf(row);
    if (cover) {
      const cr = cover.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      if (cr.width) {
        group.style.left = Math.round(cr.left - rr.left + 4) + "px";
        group.style.top = Math.round(cr.top - rr.top + 4) + "px";
        return;
      }
    }
    group.style.left = "6px";
    group.style.top = "6px";
  }

  /** Right badge: on-disk (authoritative folder scan), anchored top-right. */
  function renderDisk(row, info) {
    let badge = row.querySelector(":scope > ." + DISK_CLASS);
    if (!settings.showDiskBadge || !info.disk) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      prepareRow(row);
      badge = document.createElement("span");
      badge.className = DISK_CLASS + " " + BADGE_CLASS + " sunogen-dl-disk";
      row.appendChild(badge);
    }
    const extra = info.disk.count > 1 ? " (+" + (info.disk.count - 1) + " more)" : "";
    badge.innerHTML = ICON.disk;
    badge.title = "On disk" + (info.disk.path ? ": " + info.disk.path : "") + extra;

    const cover = coverOf(row);
    if (cover) {
      const cr = cover.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      if (cr.width) {
        badge.style.top = Math.round(cr.top - rr.top + 4) + "px";
        badge.style.right = Math.round(rr.right - cr.right + 4) + "px";
        badge.style.left = "auto";
        return;
      }
    }
    badge.style.top = "6px";
    badge.style.right = "6px";
    badge.style.left = "auto";
  }

  function renderRow(row) {
    const id = clipIdFromRow(row);
    if (!id) return;
    const m = meta.get(id);
    const info = facts.get(id) || {};
    renderLeft(row, {
      unlocked: !!(m && m.unlocked),
      upload: !!(m && m.upload),
      history: info.history
    });
    renderDisk(row, { disk: info.disk });
  }

  function removeBadges() {
    document.querySelectorAll("." + GROUP_CLASS + ", ." + DISK_CLASS).forEach((n) => n.remove());
  }

  function scan() {
    if (stopped) return;
    if (!settings.showUnlockBadge && !settings.showDiskBadge && !settings.showHistoryBadge) {
      removeBadges();
      return;
    }
    const rows = S && S.findAll ? S.findAll("clipRow") : Array.from(document.querySelectorAll(".clip-row"));
    rows.forEach(renderRow);
  }

  function scheduleScan() {
    if (scanTimer || stopped) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 300);
  }

  function onWindowMessage(ev) {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== "sunogen-page" || !data.payload) return;
    const payload = data.payload;
    if (payload.event === "clip-meta" && Array.isArray(payload.items)) {
      for (const item of payload.items) {
        if (!item || !item.id) continue;
        meta.set(item.id, {
          title: item.title,
          unlocked: !!item.unlocked,
          known: item.known !== false,
          hasStem: !!item.hasStem,
          upload: !!item.upload
        });
      }
      scheduleScan();
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes[DATA_KEY]) {
      facts.clear();
      const value = changes[DATA_KEY].newValue || {};
      for (const id of Object.keys(value)) facts.set(id, value[id]);
      scheduleScan();
    }
    if (changes.settings) applySettings(changes.settings.newValue || {});
  }

  function applySettings(s) {
    settings = {
      showUnlockBadge: s.showUnlockBadge !== false,
      showDiskBadge: s.showDiskBadge !== false,
      showHistoryBadge: s.showHistoryBadge !== false
    };
    scan();
  }

  const observer = new MutationObserver(() => scheduleScan());

  async function init() {
    window.addEventListener("message", onWindowMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    try {
      const data = await chrome.storage.local.get([DATA_KEY, "settings"]);
      const value = data[DATA_KEY] || {};
      for (const id of Object.keys(value)) facts.set(id, value[id]);
      applySettings(data.settings || {});
    } catch (err) {
      /* ignore */
    }
    scan();
  }

  function destroy() {
    stopped = true;
    window.removeEventListener("message", onWindowMessage);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (err) {
      /* ignore */
    }
    observer.disconnect();
    if (scanTimer) clearTimeout(scanTimer);
    removeBadges();
  }

  globalThis[KEY] = {
    destroy: destroy,
    _internals: {
      scan: scan,
      renderRow: renderRow,
      clipIdFromRow: clipIdFromRow,
      applySettings: applySettings,
      meta: meta,
      facts: facts
    }
  };

  init();
})();
