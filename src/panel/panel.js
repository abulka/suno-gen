"use strict";

(function () {
  const T = globalThis.SunoGenTitle;
  const Flow = globalThis.SunoGenCoverFlow;
  const $ = (id) => document.getElementById(id);

  let state = {
    presets: [],
    settings: {},
    batch: {
      songName: "",
      date: "",
      take: "01",
      rating: "iiiN",
      workspace: "",
      autoWorkspace: true,
      globalTake: true
    },
    sources: []
  };
  let editingId = null;
  let recording = false;
  let diagnosticsBlob = "";
  let batchRunning = false;
  let batchCallActive = false;
  let activeJobTitles = new Set();
  let lastStatusByTitle = new Map();
  let pickMode = false;
  let pickMultiple = false;
  let exportingCatalog = false;
  let repairGroups = [];
  let repairApplying = false;
  let repairScanning = false;

  // ---------- storage ----------

  async function load() {
    const data = await chrome.storage.local.get(["presets", "settings", "lastBatch"]);
    state.presets = Array.isArray(data.presets) ? data.presets : [];
    state.settings = data.settings || {};
    if (data.lastBatch) {
      if (data.lastBatch.batch) state.batch = Object.assign(state.batch, data.lastBatch.batch);
      if (Array.isArray(data.lastBatch.sources)) {
        state.sources = data.lastBatch.sources;
      } else if (data.lastBatch.source) {
        state.sources = [data.lastBatch.source];
      }
    }
    // Older batches stored a leaked processing marker as the song name
    // ("mangled", "mangled-8be1", "seqout mangled2"). Recompute those now that
    // title.js understands markers; leave deliberate custom names alone.
    state.sources = state.sources.map((source) => {
      if (!source || !source.title) return source;
      const stored = String(source.songName || "").trim();
      const looksDerivedOrLeaked = !stored || T.stripProcessingMarker(stored) !== stored;
      if (!looksDerivedOrLeaked) return source;
      const titleHasMarker = T.stripProcessingMarker(source.title) !== String(source.title).trim();
      if (!titleHasMarker) return source;
      const derived = T.deriveSongName(source.title);
      if (!derived) return source;
      return Object.assign({}, source, { songName: derived });
    });
    if (!state.batch.date) state.batch.date = T.todayYYM();
    if (!state.batch.rating) state.batch.rating = state.settings.rating || "iiiN";
    if (state.batch.autoWorkspace === undefined) {
      state.batch.autoWorkspace = state.settings.autoDeriveWorkspace !== false;
    }
    if (state.batch.globalTake === undefined) state.batch.globalTake = true;
  }

  async function savePresets() {
    await chrome.storage.local.set({ presets: state.presets });
  }

  async function saveBatch() {
    state.batch = readBatchFromDom();
    await chrome.storage.local.set({ lastBatch: { batch: state.batch, sources: state.sources } });
  }

  async function saveSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    await chrome.storage.local.set({ settings: state.settings });
  }

  // ---------- download folder scan (File System Access) ----------

  const FS_DB = "sunogen-fs";
  const FS_STORE = "handles";
  const FS_INDEX = "scanIndex";
  const READ_HEAD = 64 * 1024;
  const READ_TAIL = 64 * 1024;
  const MP3_TAG_CAP = 256 * 1024;
  const MAX_FILES = 20000;
  const MAX_DEPTH = 12;
  const SCAN_CONCURRENCY = 6;

  let scanState = null;
  let downloadScanTimer = null;

  let fsDbPromise = null;

  function idbOpen() {
    if (!fsDbPromise) {
      fsDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(FS_DB, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(FS_STORE)) db.createObjectStore(FS_STORE);
          if (!db.objectStoreNames.contains(FS_INDEX)) db.createObjectStore(FS_INDEX);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          fsDbPromise = null;
          reject(req.error);
        };
      });
    }
    return fsDbPromise;
  }

  async function idbGet(store, key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(store, key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readwrite").objectStore(store).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  let folderHasHandle = false;
  let folderConnected = false;

  /**
   * Drive the folder card from one place. Two states only: the folder is
   * connected (Chrome currently allows access) or not. If Chrome has forgotten
   * the grant, the status line simply tells you to reconnect.
   */
  function setFolderState(connected, text) {
    folderConnected = !!connected;
    const statusEl = $("dl-folder-status");
    const pill = $("dl-status-pill");
    if (statusEl) statusEl.textContent = text || "";
    if (pill) {
      pill.textContent = connected ? "connected" : "not connected";
      pill.className = "pill " + (connected ? "pill-ok" : "pill-warn");
    }
    updateFolderButtons();
  }

  /**
   * Label the primary button and show/disable the folder actions. The primary
   * button is dimmed while connected (state and action shouldn't contradict);
   * "Change folder…" is shown only when a folder is linked.
   */
  function applyFolderButtons(hasHandle) {
    folderHasHandle = !!hasHandle;
    updateFolderButtons();
  }

  function updateFolderButtons() {
    const btn = $("dl-folder");
    const change = $("dl-folder-change");
    if (btn) {
      btn.textContent = folderHasHandle ? "Reconnect download folder" : "Connect download folder";
      btn.disabled = scanState || (folderHasHandle && folderConnected);
    }
    if (change) {
      change.hidden = !folderHasHandle;
      change.disabled = !!scanState;
    }
  }

  function formatLastScan(rec) {
    if (!rec || !rec.at) return "";
    const parts = [];
    if (rec.matched != null) parts.push("matched " + rec.matched + " clip(s)");
    if (rec.total != null) parts.push("scanned " + rec.total);
    return "Last scan " + new Date(rec.at).toLocaleString() + (parts.length ? " · " + parts.join(" · ") : "");
  }

  function setScanning(on) {
    const scanBtn = $("dl-scan");
    const cancelBtn = $("dl-cancel");
    const rebuildBtn = $("dl-rebuild");
    if (scanBtn) scanBtn.disabled = on;
    if (rebuildBtn) rebuildBtn.disabled = on;
    if (cancelBtn) cancelBtn.hidden = !on;
    updateFolderButtons();
  }

  async function loadScanRecord() {
    const rec = await idbGet(FS_INDEX, "downloadFolder");
    return {
      rootName: (rec && rec.rootName) || null,
      files: (rec && rec.files) || {}
    };
  }

  async function saveScanIndex(rootName, files) {
    await idbSet(FS_INDEX, "downloadFolder", {
      rootName: rootName || null,
      files: files,
      updatedAt: Date.now()
    });
  }

  async function clearScanIndex() {
    await idbSet(FS_INDEX, "downloadFolder", { rootName: null, files: {}, updatedAt: Date.now() });
  }

  /** Drop authoritative on-disk facts (used when the granted folder changes). */
  async function dropDiskFacts() {
    const store = await chrome.storage.local.get("downloadedClips");
    const current = store.downloadedClips || {};
    let changed = false;
    for (const id of Object.keys(current)) {
      if (current[id].disk) {
        delete current[id].disk;
        if (!current[id].history) delete current[id];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ downloadedClips: current });
  }

  async function loadTitleMap() {
    const store = await chrome.storage.local.get(["clipTitles", "titleAliases"]);
    const map = new Map();
    // Old titles first; current titles win if the same text is ever reused.
    for (const [title, id] of Object.entries(store.titleAliases || {})) {
      if (title && id) map.set(String(title).trim().toLowerCase(), id);
    }
    for (const [id, title] of Object.entries(store.clipTitles || {})) {
      if (title) map.set(String(title).trim().toLowerCase(), id);
    }
    return map;
  }

  /** Enumerate audio files under the granted folder (metadata only). */
  async function collectFiles(handle, state) {
    const Meta = globalThis.SunoGenAudioMeta;
    const files = [];
    let count = 0;
    let truncated = false;
    async function walk(dir, prefix, depth) {
      if (state.cancelled || depth > MAX_DEPTH) return;
      for await (const entry of dir.values()) {
        if (state.cancelled) return;
        const path = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.kind === "directory") {
          await walk(entry, path, depth + 1);
        } else {
          count++;
          if (count > MAX_FILES) {
            truncated = true;
            return;
          }
          if (Meta.AUDIO_EXT.test(entry.name)) files.push({ entry: entry, path: path });
        }
      }
    }
    await walk(handle, handle.name, 0);
    return { files: files, truncated: truncated };
  }

  /**
   * Read only what is needed to find the clip id: 16 bytes to sniff the
   * container, then the head (ID3 tag if MP3, else 64 KB), with a tail read
   * only as a fallback.
   */
  async function readHeadTail(file, known) {
    const Meta = globalThis.SunoGenAudioMeta;
    const size = file.size;
    const sniff = new Uint8Array(await file.slice(0, Math.min(16, size)).arrayBuffer());
    let headLen = READ_HEAD;
    const tag = Meta.id3TagSize(sniff);
    if (tag > 0) headLen = Math.min(tag + 10, MP3_TAG_CAP);
    const head = new Uint8Array(await file.slice(0, Math.min(headLen, size)).arrayBuffer());
    const headText = Meta.decode(head);
    let id = Meta.idFromText(headText, known);
    if (id) return id;
    const tailStart = Math.max(0, size - READ_TAIL);
    if (tailStart > head.length) {
      const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
      id = Meta.idFromText(headText + "\n" + Meta.decode(tail), known);
    }
    return id || null;
  }

  async function runPool(items, worker, concurrency, state) {
    let next = 0;
    const runners = [];
    for (let k = 0; k < concurrency; k++) {
      runners.push(
        (async () => {
          while (next < items.length) {
            if (state.cancelled) return;
            const i = next++;
            await worker(items[i]);
          }
        })()
      );
    }
    await Promise.all(runners);
  }

  async function scanDownloadFolder() {
    const Meta = globalThis.SunoGenAudioMeta;
    if (scanState) return;
    const handle = await idbGet(FS_STORE, "downloadFolder");
    if (!handle) {
      applyFolderButtons(false);
      logLine("No download folder connected.", "err");
      setFolderState(false, "no folder connected");
      return;
    }
    try {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") {
        setFolderState(false, 'Not connected — click Reconnect (choose "Allow on every visit")');
        return;
      }
    } catch (err) {
      setFolderState(false, "permission error — see log");
      return;
    }

    const state = { cancelled: false };
    scanState = state;
    setScanning(true);
    setFolderState(true, "scanning…");

    try {
      const titleMap = await loadTitleMap();
      const rec = await loadScanRecord();
      const index = new Map(Object.entries(rec.files));
      const store = await chrome.storage.local.get(["clipTitles", "downloadedClips"]);
      const known = new Set([
        ...Object.keys(store.clipTitles || {}),
        ...Object.keys(store.downloadedClips || {})
      ]);

      const { files, truncated } = await collectFiles(handle, state);
      const found = new Map();
      let processed = 0;
      let readCount = 0;
      let reusedCount = 0;
      const total = files.length;

      await runPool(
        files,
        async (item) => {
          if (state.cancelled) return;
          try {
            const file = await item.entry.getFile();
            const size = file.size;
            const mtime = file.lastModified;
            const prev = index.get(item.path);
            const cached = prev && prev.size === size && prev.mtime === mtime;
            let id = cached ? prev.id : null;
            if (id) {
              reusedCount++;
            } else {
              id = Meta.matchTitle(titleMap, Meta.stemOf(item.path));
              if (id) {
                reusedCount++;
              } else if (cached) {
                reusedCount++;
              } else {
                readCount++;
                id = await readHeadTail(file, known);
              }
              index.set(item.path, { size: size, mtime: mtime, id: id || null });
            }
            if (id) {
              known.add(id);
              const hit = found.get(id);
              if (hit) hit.count++;
              else found.set(id, { path: item.path, count: 1 });
            }
          } catch (err) {
            /* skip unreadable file */
          }
          processed++;
          if (processed % 40 === 0 || processed === total) {
            setFolderState(
              true,
              "scanning " + processed + "/" + total + " · " + readCount + " read · matched " + found.size
            );
          }
        },
        SCAN_CONCURRENCY,
        state
      );

      if (state.cancelled) {
        logLine("Folder scan cancelled.");
        renderDownloadsFolder().catch(() => {});
        return;
      }

      const present = new Set(files.map((f) => f.path));
      for (const path of Array.from(index.keys())) if (!present.has(path)) index.delete(path);
      await saveScanIndex(handle.name, Object.fromEntries(index));

      // The folder scan is authoritative for "on disk": drop disk facts whose
      // file is gone, but leave Chrome-history facts untouched.
      const after = await chrome.storage.local.get("downloadedClips");
      const current = after.downloadedClips || {};
      let changed = false;
      for (const id of Object.keys(current)) {
        if (current[id].disk && !found.has(id)) {
          delete current[id].disk;
          if (!current[id].history) delete current[id];
          changed = true;
        }
      }
      for (const [id, hit] of found) {
        const entry = current[id] || {};
        const prev = entry.disk;
        if (!prev || prev.path !== hit.path || prev.count !== hit.count) {
          entry.disk = { at: Date.now(), path: hit.path, count: hit.count };
          current[id] = entry;
          changed = true;
        }
      }
      if (changed) await chrome.storage.local.set({ downloadedClips: current });

      const summary =
        "scanned " + total + " · " + readCount + " read · " + reusedCount + " reused · matched " +
        found.size + " clip(s)" + (truncated ? " (file cap hit)" : "");
      setFolderState(true, "Last scan " + new Date().toLocaleString() + " · " + summary);
      logLine("Folder scan: " + summary, "ok");
      try {
        await chrome.storage.local.set({
          lastScan: {
            at: Date.now(),
            total: total,
            read: readCount,
            reused: reusedCount,
            matched: found.size,
            rootName: handle.name
          }
        });
      } catch (err) {
        /* ignore */
      }
    } finally {
      scanState = null;
      setScanning(false);
    }
  }

  async function rebuildDownloadIndex() {
    if (scanState) return;
    await clearScanIndex();
    logLine("Rebuilding folder index…");
    setFolderState(true, "rebuilding…");
    await scanDownloadFolder();
  }

  async function connectDownloadFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      logLine("File System Access API is unavailable here — open the panel as a tab and retry.", "err");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: "sunogen-downloads", mode: "read" });
      const rec = await loadScanRecord();
      if (rec.rootName && rec.rootName !== handle.name) {
        // A genuinely different folder invalidates both the id cache and disk facts.
        await clearScanIndex();
        await dropDiskFacts();
      }
      await idbSet(FS_STORE, "downloadFolder", handle);
      applyFolderButtons(true);
      await scanDownloadFolder();
    } catch (err) {
      if (String((err && err.name) || "") !== "AbortError") {
        logLine("Folder connect failed: " + err, "err");
      }
    }
  }

  /**
   * Single source of truth for the folder card: reads the stored handle, its
   * current permission, and the last persisted scan summary, then paints the
   * card. Runs before an auto-scan, so the user always sees the last known state
   * even if a rescan is skipped or still running.
   */
  async function renderDownloadsFolder() {
    let handle = null;
    try {
      handle = await idbGet(FS_STORE, "downloadFolder");
    } catch (err) {
      /* ignore */
    }
    applyFolderButtons(!!handle);
    if (!handle) {
      setFolderState(false, "no folder connected");
      return;
    }
    let perm = "prompt";
    try {
      perm = await handle.queryPermission({ mode: "read" });
    } catch (err) {
      /* ignore */
    }
    let last = null;
    try {
      const store = await chrome.storage.local.get("lastScan");
      last = store.lastScan || null;
    } catch (err) {
      /* ignore */
    }
    if (perm === "granted") {
      setFolderState(true, formatLastScan(last) || "connected");
    } else {
      setFolderState(false, 'Not connected — click Reconnect (choose "Allow on every visit")');
    }
  }

  /**
   * Rescan on panel-open / download-complete. These paths have no user gesture,
   * so this never calls `requestPermission` itself: if Chrome has forgotten the
   * grant it just shows the plain "not connected" state (no nagging). Clicking
   * Reconnect re-asks and scans.
   */
  async function autoScanDownloadFolder() {
    if (scanState) return;
    let handle;
    try {
      handle = await idbGet(FS_STORE, "downloadFolder");
    } catch (err) {
      return;
    }
    if (!handle) return;
    let perm;
    try {
      perm = await handle.queryPermission({ mode: "read" });
    } catch (err) {
      return;
    }
    if (perm !== "granted") {
      await renderDownloadsFolder();
      return;
    }
    await scanDownloadFolder();
  }

  /** Debounce rescans triggered by a completed download (may arrive in bursts). */
  function scheduleDownloadScan() {
    if (downloadScanTimer) clearTimeout(downloadScanTimer);
    downloadScanTimer = setTimeout(() => {
      downloadScanTimer = null;
      autoScanDownloadFolder().catch(() => {});
    }, 2500);
  }

  // ---------- messaging ----------

  async function getTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  function isSunoUrl(url) {
    return /^https:\/\/([a-z0-9-]+\.)?suno\.com\//.test(url || "");
  }

  const CONTENT_FILES = [
    "src/shared/title.js",
    "src/content/selectors.js",
    "src/content/cover-flow.js",
    "src/content/catalog.js",
    "src/content/content.js",
    "src/content/row-indicators.js"
  ];

  // Injects into a tab that was already open when the extension was loaded.
  async function injectContent(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false },
      files: CONTENT_FILES
    });
    // Manifest CSS is only applied on page load; a tab open across an extension
    // reload needs it re-inserted or the badges render at 0×0.
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tabId, allFrames: false },
        files: ["src/content/row-indicators.css"]
      });
    } catch (err) {
      console.warn("[SunoGen] indicator CSS injection failed", err);
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: false },
        world: "MAIN",
        files: ["src/inject/page-hook.js"]
      });
    } catch (err) {
      console.warn("[SunoGen] MAIN-world hook injection failed", err);
    }
  }

  async function sendToContent(type, extra) {
    const tab = await getTab();
    if (!tab || !isSunoUrl(tab.url)) throw new Error("Active tab is not a suno.com page.");
    const message = Object.assign({ type: type }, extra || {});
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, message);
      if (resp !== undefined) return resp;
    } catch (err) {
      const text = String((err && err.message) || err);
      if (
        !/Receiving end|Could not establish connection|message channel|Extension context/i.test(text)
      ) {
        throw err;
      }
    }
    await injectContent(tab.id);
    const retry = await chrome.tabs.sendMessage(tab.id, message);
    if (retry === undefined) throw new Error("Page did not respond — reload the Suno tab.");
    return retry;
  }

  // Reads the persisted recorder trace from every Suno tab and returns the
  // longest one (works even if the page navigated mid-recording).
  async function readRecording() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const sunoTabs = tabs.filter((t) => isSunoUrl(t.url));
    let best = { steps: [] };
    for (const tab of sunoTabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          func: (key) => {
            try {
              return JSON.parse(sessionStorage.getItem(key) || '{"steps":[]}');
            } catch (err) {
              return { steps: [] };
            }
          },
          args: ["sunogen-recording"]
        });
        const rec = results && results[0] && results[0].result;
        if (rec && Array.isArray(rec.steps) && rec.steps.length >= best.steps.length) {
          best = rec;
        }
      } catch (err) {
        /* skip tab */
      }
    }
    return best;
  }

  // ---------- rendering ----------

  /**
   * Pings the active Suno tab to re-sync an already-armed Pick mode on boot.
   * No longer paints a status pill (the topbar is title-only); failures are
   * just logged to the console.
   */
  function syncPageState() {
    getTab()
      .then(async (tab) => {
        if (!tab || !isSunoUrl(tab.url)) return;
        try {
          const res = await sendToContent("SUNOGEN_PING");
          if (res && res.pick) {
            pickMode = !!res.pick.active;
            pickMultiple = !!res.pick.multiple;
            updatePickStatus();
          }
        } catch (err) {
          console.warn("[SunoGen] ping failed", err);
        }
      })
      .catch(() => {});
  }

  function renderBatchFields() {
    $("date").value = state.batch.date;
    $("take").value = state.batch.take;
    $("rating").value = state.batch.rating;
    $("auto-workspace").checked = state.batch.autoWorkspace;
    $("take-global").checked = state.batch.globalTake !== false;
    renderSources();
    syncWorkspace();
    updatePickStatus();
  }

  /**
   * The DOM is the source of truth for what will be submitted, so a stale
   * cached value can never disagree with what the panel shows.
   */
  function readBatchFromDom() {
    const autoWorkspace = $("auto-workspace").checked;
    return {
      // With one source the field is authoritative; with many, names are
      // derived per source (see title.js:uniqueSourceNames).
      songName: state.sources.length === 1 ? $("song-name").value : "",
      date: $("date").value,
      take: $("take").value,
      rating: $("rating").value,
      // Auto workspace is derived per source in buildJobs, so leave it blank.
      workspace: autoWorkspace ? "" : $("workspace").value,
      autoWorkspace: autoWorkspace,
      globalTake: $("take-global").checked
    };
  }

  function syncWorkspace() {
    const input = $("workspace");
    const auto = $("auto-workspace").checked;
    input.readOnly = auto;
    if (auto) {
      if (state.sources.length > 1) {
        input.value = "(per song)";
      } else {
        const songName =
          state.sources.length === 1
            ? T.uniqueSourceNames(state.sources)[0] || ""
            : $("song-name").value;
        input.value = T.buildWorkspace({ date: $("date").value, songName: songName });
      }
    }
    updateDestInfo();
  }

  function updateDestInfo() {
    const el = $("dest-info");
    if (!el) return;
    const auto = $("auto-workspace").checked;
    el.innerHTML = "";
    el.appendChild(document.createTextNode("Destination: "));
    const strong = document.createElement("strong");
    let note;
    if (auto && state.sources.length > 1) {
      strong.textContent = "one per song";
      note = "  (auto: {date} {song})";
    } else if (auto) {
      const songName =
        state.sources.length === 1
          ? T.uniqueSourceNames(state.sources)[0] || ""
          : $("song-name").value;
      strong.textContent =
        T.buildWorkspace({ date: $("date").value, songName: songName }) || "(none)";
      note = "  (auto from date + name)";
    } else {
      strong.textContent = $("workspace").value || "(none)";
      note = "  (manual, all songs)";
    }
    el.appendChild(strong);
    el.appendChild(document.createTextNode(note));
  }

  function renderSources() {
    const list = $("source-list");
    if (!list) return;
    list.innerHTML = "";
    const names = T.uniqueSourceNames(state.sources);
    state.sources.forEach((src, i) => {
      const row = document.createElement("div");
      row.className = "source-item";

      const name = document.createElement("span");
      name.className = "src-name";
      name.textContent = src.title || src.clipId || "untitled";
      name.title = name.textContent;
      row.appendChild(name);

      const derived = document.createElement("span");
      derived.className = "src-derived";
      derived.textContent = "→ " + names[i];
      row.appendChild(derived);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.title = "Remove";
      del.textContent = "×";
      del.addEventListener("click", () => removeSource(i));
      row.appendChild(del);

      list.appendChild(row);
    });
    if (!state.sources.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No sources yet.";
      list.appendChild(empty);
    }
    syncSongNameField();
  }

  function syncSongNameField() {
    const input = $("song-name");
    const multi = state.sources.length > 1;
    input.disabled = multi;
    input.placeholder = multi ? "(derived per song)" : "happy song";
    if (document.activeElement === input) return; // don't clobber while typing
    if (multi) input.value = "";
    else if (state.sources.length === 1) input.value = T.uniqueSourceNames(state.sources)[0] || "";
    else input.value = state.batch.songName || "";
  }

  function addSource(source) {
    if (!source) return false;
    const id = source.clipId || source.title;
    if (id && state.sources.some((s) => (s.clipId || s.title) === id)) {
      logLine("Already added: " + (source.title || id));
      return false;
    }
    state.sources.push(Object.assign({}, source, { songName: T.deriveSongName(source.title) }));
    saveBatch();
    renderSources();
    syncWorkspace();
    renderPreview();
    updateRunEnabled();
    updatePickStatus();
    return true;
  }

  function removeSource(i) {
    state.sources.splice(i, 1);
    saveBatch();
    renderSources();
    syncWorkspace();
    renderPreview();
    updateRunEnabled();
    updatePickStatus();
  }

  function clearSources() {
    state.sources = [];
    saveBatch();
    renderSources();
    syncWorkspace();
    renderPreview();
    updateRunEnabled();
    updatePickStatus();
    logLine("Cleared sources.");
  }

  function updatePickStatus() {
    const el = $("pick-status");
    if (el) {
      if (pickMode) {
        el.textContent =
          "Picking" + (pickMultiple ? " (multiple)" : "") + "… click a song. Esc to stop.";
        el.className = "pick-status active";
      } else if (state.sources.length) {
        el.textContent = state.sources.length + " source(s) selected";
        el.className = "muted pick-status";
      } else {
        el.textContent = "";
        el.className = "muted pick-status";
      }
    }
    const btn = $("pick-multiple");
    if (btn) btn.textContent = pickMode && pickMultiple ? "Stop picking" : "+ Pick multiple";
  }

  function renderPresets() {
    const list = $("preset-list");
    list.innerHTML = "";
    if (!state.presets.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No presets yet. Add one.";
      list.appendChild(empty);
      return;
    }
    for (const preset of state.presets) {
      const row = document.createElement("div");
      row.className = "preset";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = preset.selected !== false;
      cb.addEventListener("change", () => {
        preset.selected = cb.checked;
        savePresets();
        renderPreview();
        updateRunEnabled();
      });

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = preset.name || "(unnamed)";
      const sub = document.createElement("div");
      sub.className = "sub";
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = preset.styleCode || "----";
      sub.appendChild(code);
      sub.appendChild(document.createTextNode("  " + (preset.stylePrompt || "no style prompt")));
      if (preset.workspaceOverride) {
        sub.appendChild(document.createTextNode("  → " + preset.workspaceOverride));
      }
      meta.appendChild(name);
      meta.appendChild(sub);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "icon-btn";
      edit.title = "Edit";
      edit.textContent = "✎";
      edit.addEventListener("click", () => openEditor(preset.id));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.title = "Delete";
      del.textContent = "🗑";
      del.addEventListener("click", () => {
        state.presets = state.presets.filter((p) => p.id !== preset.id);
        savePresets();
        renderPresets();
        renderPreview();
        updateRunEnabled();
      });

      row.appendChild(cb);
      row.appendChild(meta);
      row.appendChild(edit);
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  function currentConfig() {
    return {
      sources: state.sources.map((s) => Object.assign({}, s)),
      source: state.sources[0] || null,
      batch: readBatchFromDom(),
      presets: state.presets.map((p) => Object.assign({}, p)),
      settings: state.settings
    };
  }

  function renderPreview() {
    const el = $("preview");
    el.innerHTML = "";
    let jobs = [];
    try {
      jobs = Flow.buildJobs(currentConfig());
    } catch (err) {
      jobs = [];
    }
    if (!jobs.length) {
      el.className = "preview muted";
      el.textContent = "Pick source song(s), select presets, fill the batch fields.";
      return;
    }
    el.className = "preview";
    const summary = document.createElement("div");
    summary.className = "muted";
    summary.textContent =
      jobs.length + " job(s) · " + state.sources.length + " song(s)";
    el.appendChild(summary);
    let lastGroup = null;
    for (const job of jobs) {
      const group = job.songName || "(song)";
      if (group !== lastGroup) {
        lastGroup = group;
        const head = document.createElement("div");
        head.className = "job-group";
        head.textContent = group;
        el.appendChild(head);
      }
      const row = document.createElement("div");
      row.className = "job";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = job.title;
      const ws = document.createElement("div");
      ws.className = "ws" + (job.workspaceIsOverride ? " ov" : "");
      ws.textContent = "→ " + job.workspace + (job.workspaceIsOverride ? "  (override)" : "");
      row.appendChild(title);
      row.appendChild(ws);
      el.appendChild(row);
    }
  }

  function updateRunEnabled() {
    const ready =
      state.sources.length > 0 &&
      state.presets.some((p) => p.selected !== false) &&
      (state.sources.length > 1 || !!($("song-name").value || "").trim());
    $("run-batch").disabled = !ready || batchCallActive || repairApplying;
    const scan = $("repair-scan");
    if (scan) scan.disabled = repairScanning || repairApplying || batchCallActive;
    const apply = $("repair-apply");
    if (apply) {
      apply.disabled =
        repairScanning || repairApplying || batchCallActive || repairRunCount() === 0;
    }
    const cancel = $("repair-cancel");
    if (cancel) cancel.disabled = !repairApplying;
    const reload = $("repair-reload");
    if (reload) reload.disabled = repairScanning || repairApplying || batchCallActive;
  }

  function renderAll() {
    renderBatchFields();
    renderPresets();
    renderPreview();
    renderSettings();
    updateRunEnabled();
  }

  function renderSettings() {
    setChecked("dl-badge-unlock", state.settings.showUnlockBadge !== false);
    setChecked("dl-badge-history", state.settings.showHistoryBadge !== false);
    setChecked("dl-badge-disk", state.settings.showDiskBadge !== false);
  }

  function setChecked(id, value) {
    const el = $(id);
    if (el) el.checked = value;
  }

  async function armPick(multiple) {
    try {
      await sendToContent("SUNOGEN_START_PICK", { multiple: multiple });
      pickMode = true;
      pickMultiple = !!multiple;
      updatePickStatus();
      logLine(
        multiple
          ? "Pick mode (multiple) — click songs to add; Esc or Stop when done."
          : "Pick mode armed — click a song on the page."
      );
    } catch (err) {
      logLine(String((err && err.message) || err), "err");
    }
  }

  async function disarmPick() {
    try {
      await sendToContent("SUNOGEN_CANCEL_PICK");
    } catch (err) {
      /* ignore */
    }
    pickMode = false;
    pickMultiple = false;
    updatePickStatus();
  }

  // ---------- title repair ----------

  function setRepairStatus(text) {
    const el = $("repair-status");
    if (el) el.textContent = text;
  }

  function repairRunCount() {
    return repairGroups.reduce(
      (n, g) => n + (g.enabled && String(g.newTitle || "").trim() ? g.ids.length : 0),
      0
    );
  }

  /**
   * Search results -> grouped old→new proposals. The derived name comes from
   * the cover's source clip (`metadata.cover_clip_id`), mirroring buildJobs.
   * A name that merely ends in a marker keeps the user's formatting; a name
   * that is only the marker falls back to the derived source name.
   */
  function buildRepairGroups(rows) {
    const sourceById = new Map();
    for (const row of rows) {
      if (!row || !row.sourceId || !row.sourceTitle) continue;
      if (!sourceById.has(row.sourceId)) {
        sourceById.set(row.sourceId, { clipId: row.sourceId, title: row.sourceTitle });
      }
    }
    const sourceList = [...sourceById.values()];
    const names = T.uniqueSourceNames(sourceList);
    const nameById = new Map(sourceList.map((s, i) => [s.clipId, names[i]]));

    const groups = new Map();
    for (const row of rows) {
      if (!row || !row.title) continue;
      const parts = T.splitTitle(row.title);
      if (!parts.head) continue; // not one of our generated titles
      const derived = row.sourceId
        ? nameById.get(row.sourceId) || T.deriveSongName(row.sourceTitle)
        : "";
      const name = T.repairSongName(parts.songName, derived);
      const newTitle = name ? T.joinTitle(parts.head, name) : "";
      if (newTitle && newTitle === row.title) continue;
      const key = row.title + "\u0000" + newTitle;
      let group = groups.get(key);
      if (!group) {
        group = {
          oldTitle: row.title,
          newTitle: newTitle,
          enabled: !!newTitle,
          ids: [],
          sourceTitle: row.sourceTitle || "",
          unresolved: !name
        };
        groups.set(key, group);
      }
      group.ids.push(row.id);
    }
    return [...groups.values()].sort((a, b) => a.oldTitle.localeCompare(b.oldTitle));
  }

  function renderRepairGroups() {
    const list = $("repair-list");
    if (!list) return;
    list.innerHTML = "";
    if (!repairGroups.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No title changes proposed.";
      list.appendChild(empty);
    }
    repairGroups.forEach((group) => {
      const row = document.createElement("div");
      row.className = "repair-row" + (group.enabled ? "" : " disabled");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = group.enabled;
      cb.disabled = repairApplying;
      cb.addEventListener("change", () => {
        group.enabled = cb.checked;
        row.className = "repair-row" + (group.enabled ? "" : " disabled");
        updateRunEnabled();
      });

      const body = document.createElement("div");
      body.className = "repair-body";

      const old = document.createElement("div");
      old.className = "repair-old";
      old.textContent = group.oldTitle;
      body.appendChild(old);

      const input = document.createElement("input");
      input.type = "text";
      input.value = group.newTitle;
      input.placeholder = group.unresolved ? "Type the corrected name…" : "Corrected title";
      input.disabled = repairApplying;
      input.addEventListener("input", () => {
        group.newTitle = input.value;
        if (!input.value.trim()) {
          group.enabled = false;
          cb.checked = false;
          row.className = "repair-row disabled";
        } else if (group.unresolved && !group.enabled) {
          group.enabled = true;
          cb.checked = true;
          row.className = "repair-row";
        }
        updateRunEnabled();
      });
      body.appendChild(input);

      const note = document.createElement("div");
      note.className = "repair-note" + (group.unresolved ? " warn" : "");
      note.textContent = group.unresolved
        ? "No source clip resolved — edit the title manually."
        : group.sourceTitle
        ? "from " + group.sourceTitle
        : "";
      if (note.textContent) body.appendChild(note);

      const count = document.createElement("span");
      count.className = "repair-count";
      count.textContent = group.ids.length + "×";
      count.title = group.ids.length + " clip(s) share this title";

      row.appendChild(cb);
      row.appendChild(body);
      row.appendChild(count);
      list.appendChild(row);
    });
    updateRunEnabled();
  }

  async function scanTitleRepairs() {
    if (repairScanning || repairApplying || batchCallActive) return;
    const term = (($("repair-term") || {}).value || "").trim() || "mangled";
    repairScanning = true;
    repairGroups = [];
    $("repair-panel").hidden = true;
    renderRepairGroups();
    setRepairStatus('Searching Suno for "' + term + '"…');
    updateRunEnabled();
    try {
      const res = await sendToContent("SUNOGEN_SCAN_TITLE_REPAIRS", { term: term });
      if (!res || !res.ok) throw new Error((res && res.error) || "No response from the Suno tab.");
      repairGroups = buildRepairGroups(res.rows || []);
      const changed = repairGroups.reduce((n, g) => n + g.ids.length, 0);
      $("repair-panel").hidden = repairGroups.length === 0;
      setRepairStatus(
        repairGroups.length
          ? "Found " + repairGroups.length + " title(s) to fix across " + changed +
            " clip(s). Review, uncheck any, then rename."
          : "No titles need changing."
      );
      logLine(
        "Title scan: scanned " + (res.scanned || 0) + " matching clip(s) · " +
          repairGroups.length + " title(s) / " + changed + " clip(s) to repair.",
        "ok"
      );
    } catch (err) {
      setRepairStatus("Scan failed: " + String((err && err.message) || err));
      logLine("Title repair scan failed: " + String((err && err.message) || err), "err");
    } finally {
      repairScanning = false;
      renderRepairGroups();
    }
  }

  async function applyTitleRepairs() {
    if (repairApplying || repairScanning || batchCallActive) return;
    const items = [];
    const aliases = [];
    for (const group of repairGroups) {
      const title = String(group.newTitle || "").trim();
      if (!group.enabled || !title) continue;
      for (const id of group.ids) {
        items.push({ id: id, title: title });
        aliases.push({ id: id, title: group.oldTitle });
      }
    }
    if (!items.length) {
      logLine("No title changes selected.", "err");
      return;
    }
    const ok = window.confirm(
      "Rename " + items.length + " clip(s) on Suno?\n\nOnly titles change; audio and metadata stay as-is."
    );
    if (!ok) return;

    repairApplying = true;
    setRepairStatus("Renaming 0/" + items.length + "…");
    renderRepairGroups();
    updateRunEnabled();
    try {
      const res = await sendToContent("SUNOGEN_RENAME_CLIPS", { items: items, aliases: aliases });
      if (!res || !res.ok) throw new Error((res && res.error) || "No response from the Suno tab.");
      const renamed = Number(res.renamed) || 0;
      const failed = Number(res.failed) || 0;
      const okIds = new Set((res.results || []).filter((r) => r.ok).map((r) => r.id));
      repairGroups = repairGroups
        .map((g) =>
          Object.assign({}, g, { ids: g.ids.filter((id) => !okIds.has(id)) })
        )
        .filter((g) => g.ids.length);
      setRepairStatus(
        "Renamed " + renamed + " clip(s)" + (failed ? " · " + failed + " failed" : "") +
          ". Suno's workspace view caches titles — click Reload Suno page."
      );
      logLine(
        "Renamed " + renamed + " clip title(s)" + (failed ? ", " + failed + " failed" : "") + ".",
        failed ? "err" : "ok"
      );
    } catch (err) {
      setRepairStatus("Rename failed: " + String((err && err.message) || err));
      logLine(String((err && err.message) || err), "err");
    } finally {
      repairApplying = false;
      renderRepairGroups();
    }
  }

  async function cancelTitleRepairs() {
    try {
      await sendToContent("SUNOGEN_CANCEL_TITLE_REPAIRS");
    } catch (err) {
      /* ignore */
    }
    if (repairApplying) setRepairStatus("Stopping after the current clip…");
  }

  // ---------- preset editor ----------

  function openEditor(id) {
    editingId = id || null;
    const preset = id ? state.presets.find((p) => p.id === id) : null;
    $("editor-title").textContent = preset ? "Edit preset" : "New preset";
    $("p-name").value = preset ? preset.name : "";
    $("p-code").value = preset ? preset.styleCode : "";
    $("p-style").value = preset ? preset.stylePrompt : "";
    $("p-workspace").value = preset ? preset.workspaceOverride || "" : "";
    $("p-lyrics").value = preset ? preset.lyrics || "" : "";
    $("editor-card").hidden = false;
    $("p-name").focus();
  }

  function closeEditor() {
    editingId = null;
    $("editor-card").hidden = true;
  }

  function saveEditor() {
    const payload = {
      name: $("p-name").value.trim(),
      styleCode: $("p-code").value.trim().replace(/\s+/g, "").slice(0, 8),
      stylePrompt: $("p-style").value,
      lyrics: $("p-lyrics").value,
      workspaceOverride: $("p-workspace").value.trim()
    };
    if (!payload.name) {
      $("p-name").focus();
      return;
    }
    if (editingId) {
      const p = state.presets.find((x) => x.id === editingId);
      Object.assign(p, payload);
    } else {
      state.presets.push(
        Object.assign({ id: crypto.randomUUID(), selected: true }, payload)
      );
    }
    savePresets();
    closeEditor();
    renderPresets();
    renderPreview();
    updateRunEnabled();
  }

  // ---------- log ----------

  function logLine(text, cls) {
    const log = $("log");
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * Log a generation status once. Two channels report statuses (the polled
   * `.clip-row[data-clip-status]` monitor and the MAIN-world network hook), so
   * filter to the current batch's job titles and dedupe by title+status.
   */
  function logStatus(title, status, opts) {
    const key = String(title || "").trim();
    if (!key || !status) return;
    if (opts && opts.fromPage && !batchRunning) return;
    if (activeJobTitles.size && !activeJobTitles.has(key)) return;
    if (lastStatusByTitle.get(key) === status) return;
    lastStatusByTitle.set(key, status);
    logLine("  " + key + " → " + status, status === "complete" ? "ok" : undefined);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function runDiagnose() {
    try {
      const tab = await getTab();
      if (!tab || !isSunoUrl(tab.url)) throw new Error("Active tab is not a suno.com page.");
      // Inject the latest code first so we never read a stale selector map.
      await injectContent(tab.id);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: () => {
          const Sg = globalThis.SunoGenSelectors;
          if (!Sg) return { error: "SunoGen selectors not loaded" };
          return { report: Sg.describe(), fingerprint: Sg.fingerprint() };
        }
      });
      const data = (results && results[0] && results[0].result) || {};
      if (data.error) throw new Error(data.error);
      logLine("Selector report:\n" + JSON.stringify(data.report, null, 2));
      const fp = data.fingerprint || { elements: [] };
      logLine("Fingerprint: " + fp.count + " elements on " + fp.url, "ok");
      diagnosticsBlob = JSON.stringify(
        { capturedAt: new Date().toISOString(), report: data.report, fingerprint: fp },
        null,
        2
      );
    } catch (err) {
      logLine(String((err && err.message) || err), "err");
    }
  }

  // ---------- events ----------

  function wire() {
    const onBatchInput = () => {
      if (state.sources.length === 1) state.sources[0].songName = $("song-name").value;
      renderSources();
      syncWorkspace();
      saveBatch();
      renderPreview();
      updateRunEnabled();
    };
    $("song-name").addEventListener("input", onBatchInput);
    $("date").addEventListener("input", onBatchInput);
    $("take").addEventListener("input", onBatchInput);
    $("rating").addEventListener("input", onBatchInput);
    $("workspace").addEventListener("input", onBatchInput);
    $("auto-workspace").addEventListener("change", onBatchInput);
    $("take-global").addEventListener("change", onBatchInput);

    $("add-preset").addEventListener("click", () => openEditor(null));
    $("cancel-edit").addEventListener("click", closeEditor);
    $("save-preset").addEventListener("click", saveEditor);
    $("refresh-preview").addEventListener("click", renderPreview);

    $("p-code").addEventListener("input", (e) => {
      const cleaned = e.target.value.replace(/\s+/g, "").slice(0, 8);
      if (cleaned !== e.target.value) e.target.value = cleaned;
    });

    $("pick-source").addEventListener("click", () => armPick(false));
    $("pick-multiple").addEventListener("click", () => {
      if (pickMode && pickMultiple) disarmPick();
      else armPick(true);
    });
    $("clear-sources").addEventListener("click", clearSources);

    $("repair-scan").addEventListener("click", () => scanTitleRepairs());
    $("repair-apply").addEventListener("click", () => applyTitleRepairs());
    $("repair-cancel").addEventListener("click", () => cancelTitleRepairs());
    $("repair-reload").addEventListener("click", async () => {
      try {
        const tab = await getTab();
        if (!tab || !isSunoUrl(tab.url)) throw new Error("Active tab is not a suno.com page.");
        await chrome.tabs.reload(tab.id, { bypassCache: true });
        logLine("Reloaded the Suno tab to show the repaired titles.", "ok");
      } catch (err) {
        logLine(String((err && err.message) || err), "err");
      }
    });

    $("diagnose").addEventListener("click", () => runDiagnose());

    $("dl-badge-unlock").addEventListener("change", (e) =>
      saveSettings({ showUnlockBadge: e.target.checked })
    );
    $("dl-badge-history").addEventListener("change", (e) =>
      saveSettings({ showHistoryBadge: e.target.checked })
    );
    $("dl-badge-disk").addEventListener("change", (e) =>
      saveSettings({ showDiskBadge: e.target.checked })
    );

    $("dl-folder").addEventListener("click", async () => {
      let handle = null;
      try {
        handle = await idbGet(FS_STORE, "downloadFolder");
      } catch (err) {
        /* ignore */
      }
      if (handle) await scanDownloadFolder();
      else await connectDownloadFolder();
    });
    $("dl-folder-change").addEventListener("click", () => connectDownloadFolder());
    $("dl-scan").addEventListener("click", () => scanDownloadFolder());
    $("dl-rebuild").addEventListener("click", () => rebuildDownloadIndex());
    $("dl-cancel").addEventListener("click", () => {
      if (scanState) scanState.cancelled = true;
    });

    $("export-catalog").addEventListener("click", async () => {
      const status = $("export-status");
      const btn = $("export-catalog");
      const setStatus = (text) => {
        if (status) status.textContent = text;
      };
      if (exportingCatalog) return;
      exportingCatalog = true;
      if (btn) btn.disabled = true;
      try {
        setStatus("Reading the workspace list from Suno…");
        const store = await chrome.storage.local.get(["presets", "downloadedClips"]);
        let collected = { workspaces: [], source: null, warning: null };
        try {
          const res = await sendToContent("SUNOGEN_COLLECT_WORKSPACES");
          if (res && res.ok) collected = res;
          else collected.warning = (res && res.error) || "No response from the Suno tab.";
        } catch (err) {
          collected.warning = String((err && err.message) || err);
        }
        const workspaces = (collected.workspaces || [])
          .filter((w) => w && w.name)
          .map((w) => ({
            id: w.id,
            name: w.name,
            clipCount: w.clipCount,
            createdAt: w.createdAt,
            lastUpdatedAt: w.lastUpdatedAt
          }));
        const presets = (store.presets || []).map((p) => ({
          id: p.id,
          name: p.name,
          styleCode: p.styleCode,
          stylePrompt: p.stylePrompt,
          workspaceOverride: p.workspaceOverride || ""
        }));
        const downloadedClips = Object.entries(store.downloadedClips || {})
          .map(([clipId, entry]) => ({
            clipId,
            path: (entry && entry.disk && entry.disk.path) || "",
            count: entry && entry.disk ? entry.disk.count : undefined,
            at: entry && entry.disk ? entry.disk.at : undefined
          }))
          .filter((c) => c.path);
        const payload = {
          schema: "suno-catalog/v1",
          exportedAt: new Date().toISOString(),
          presets,
          workspaces,
          downloadedClips
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "suno-catalog.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        const parts = [
          `Exported ${presets.length} presets, ${workspaces.length} workspaces, ${downloadedClips.length} on-disk clips.`
        ];
        if (collected.source === "api") {
          parts.push("Workspaces read from Suno's project API (complete list).");
        } else if (collected.source === "dom") {
          parts.push("Workspaces scraped from the picker — may be incomplete.");
        } else if (collected.warning) {
          parts.push("No workspace list: " + collected.warning);
        }
        if (collected.warning && collected.source === "dom") parts.push(collected.warning);
        if (!workspaces.length && !collected.warning) {
          parts.push("Open a Suno page with the create form and export again.");
        }
        setStatus(parts.join(" "));
        logLine(
          "Catalog exported (" + workspaces.length + " workspaces" + (collected.source ? " via " + collected.source : "") + ").",
          workspaces.length ? "ok" : "err"
        );
      } catch (err) {
        setStatus("Export failed: " + String((err && err.message) || err));
        logLine("Catalog export failed: " + String((err && err.message) || err), "err");
      } finally {
        exportingCatalog = false;
        if (btn) btn.disabled = false;
      }
    });

    const copyLog = async () => {
      const text =
        $("log").innerText +
        (diagnosticsBlob ? "\n\n=== DIAGNOSTICS ===\n" + diagnosticsBlob : "");
      const ok = await copyText(text);
      logLine(ok ? "Log copied to clipboard." : "Clipboard blocked.", ok ? "ok" : "err");
    };
    $("copy-log").addEventListener("click", copyLog);

    $("copy-diag").addEventListener("click", async () => {
      if (!diagnosticsBlob) {
        logLine("No diagnostics yet — click Diagnose or copy a trace first.", "err");
        return;
      }
      const ok = await copyText(diagnosticsBlob);
      logLine(ok ? "Diagnostics copied to clipboard." : "Clipboard blocked.", ok ? "ok" : "err");
    });

    $("reload-ext").addEventListener("click", () => {
      logLine("Reloading extension…");
      chrome.runtime.reload();
    });

    $("record-flow").addEventListener("click", async () => {
      const btn = $("record-flow");
      if (!recording) {
        try {
          await sendToContent("SUNOGEN_RECORD_START");
          recording = true;
          btn.textContent = "Stop recording";
          logLine(
            "Recording… on the page do the cover flow slowly: click ⋯ on the song → open the Create submenu → click Cover. Then press Stop."
          );
        } catch (err) {
          logLine(String((err && err.message) || err), "err");
        }
        return;
      }
      try {
        try {
          await sendToContent("SUNOGEN_RECORD_STOP");
        } catch (err) {
          console.warn("[SunoGen] stop signal failed, reading trace directly", err);
        }
        recording = false;
        btn.textContent = "Record flow";
        const recordingData = await readRecording();
        const steps = (recordingData && recordingData.steps) || [];
        diagnosticsBlob = JSON.stringify({ capturedAt: new Date().toISOString(), recording: recordingData }, null, 2);
        logLine("Recorded " + steps.length + " steps. Use Copy diagnostics to grab it.", "ok");
      } catch (err) {
        logLine(String((err && err.message) || err), "err");
      }
    });

    $("run-batch").addEventListener("click", async () => {
      if (batchCallActive || repairApplying) {
        logLine("A batch or title repair is already running — ignoring this click.", "err");
        return;
      }
      batchCallActive = true;
      updateRunEnabled();
      try {
        // Clicking Generate while multi-pick is still armed is a common way to
        // accidentally start the batch twice / keep adding sources mid-run.
        // Stale panel state is covered too: ask the page whether pick mode is
        // really active and disarm it before building the config.
        let pagePickActive = pickMode || pickMultiple;
        try {
          const ping = await sendToContent("SUNOGEN_PING");
          pagePickActive = pagePickActive || !!(ping && ping.pick && ping.pick.active);
        } catch (err) {
          /* the run call below reports a dead tab */
        }
        if (pagePickActive) {
          await disarmPick();
          logLine("Stopped source picking before running the batch.");
          // Let any already-dispatched source-picked message land before the
          // snapshot is built.
          await new Promise((resolve) => setTimeout(resolve, 120));
        }

        const config = currentConfig();
        config.dryRun = $("dry-run").checked;
        logLine("Starting batch (" + (config.dryRun ? "dry run" : "live") + ")…");
        batchRunning = !config.dryRun;
        const res = await sendToContent("SUNOGEN_RUN_BATCH", { config: config });
        if (config.dryRun && res.results) {
          res.results.forEach((j) => logLine("  preview: " + j.title));
        }
        logLine("Batch call returned.");
      } catch (err) {
        logLine(String(err.message || err), "err");
      } finally {
        batchRunning = false;
        batchCallActive = false;
        updateRunEnabled();
      }
    });
  }

  function onRuntimeMessage(msg) {
    if (!msg) return;
    if (msg.type === "SUNOGEN_DOWNLOADED") {
      scheduleDownloadScan();
      return;
    }
    if (msg.type !== "SUNOGEN_EVENT") return;
    if (msg.event === "source-picked") {
      if (batchCallActive) {
        logLine("Ignored source added while the batch is running: " + (msg.source.title || msg.source.clipId), "err");
        return;
      }
      const added = addSource(msg.source);
      if (!pickMultiple) {
        pickMode = false;
        updatePickStatus();
      }
      if (added) logLine("Added source: " + (msg.source.title || msg.source.clipId), "ok");
    } else if (msg.event === "pick-armed") {
      pickMode = true;
      pickMultiple = !!msg.multiple;
      updatePickStatus();
    } else if (msg.event === "pick-cancelled") {
      pickMode = false;
      pickMultiple = false;
      updatePickStatus();
      logLine(msg.reason === "batch-started" ? "Pick mode stopped for the batch." : "Pick cancelled.");
    } else if (msg.event === "pick-miss") {
      logLine(msg.message || "No song card detected.", "err");
    } else if (msg.event === "title-repair-progress") {
      if (!repairScanning) return;
      if (msg.phase === "search") {
        setRepairStatus(
          msg.total
            ? "Searching Suno… " + msg.done + "/" + msg.total + " matching clip(s)"
            : "Searching Suno… " + (msg.done || 0)
        );
      } else if (msg.phase === "sources") {
        setRepairStatus(
          "Resolving source clips… " + (msg.done || 0) + "/" + (msg.total || 0)
        );
      }
    } else if (msg.event === "title-rename-progress") {
      if (!repairApplying) return;
      setRepairStatus("Renaming " + (msg.done || 0) + "/" + (msg.total || 0) + "…");
      if (msg.result && !msg.result.ok && msg.result.error !== "cancelled") {
        logLine("  rename failed: " + msg.result.title + " — " + msg.result.error, "err");
      }
    } else if (msg.event === "job-start") {
      if (msg.index === 0) {
        activeJobTitles = new Set();
        lastStatusByTitle = new Map();
      }
      activeJobTitles.add(msg.job.title);
      logLine("[" + (msg.index + 1) + "/" + msg.total + "] " + msg.job.title + "  → " + msg.job.workspace);
    } else if (msg.event === "job-submitted") {
      logLine("  submitted → " + msg.job.workspace, "ok");
    } else if (msg.event === "job-error") {
      logLine("  ERROR: " + msg.error, "err");
    } else if (msg.event === "job-preview") {
      logLine("  preview: " + msg.job.title);
    } else if (msg.event === "monitor-start") {
      logLine("Waiting for " + msg.count + " generation(s)…");
    } else if (msg.event === "job-status") {
      logStatus(msg.title, msg.status);
    } else if (msg.event === "batch-complete") {
      logLine("Batch complete.");
    } else if (msg.event === "catalog-progress") {
      if (!exportingCatalog) return;
      const status = $("export-status");
      if (!status) return;
      const label = msg.source === "dom" ? "Reading the workspace picker" : "Reading workspaces from Suno";
      status.textContent = msg.total
        ? `${label}… ${msg.done}/${msg.total}`
        : `${label}… ${msg.done || 0}`;
    } else if (msg.event === "page") {
      renderPageEvent(msg.payload);
    }
  }

  function renderPageEvent(payload) {
    if (!payload) return;
    if (payload.event === "hook-ready") {
      return;
    }
    if (payload.clips && payload.clips.length) {
      payload.clips.forEach((c) => {
        logStatus(c.title || c.id || "clip", c.status, { fromPage: true });
      });
    }
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // ---------- boot ----------

  load().then(async () => {
    wire();
    renderAll();
    try {
      const tab = await getTab();
      if (tab && isSunoUrl(tab.url)) await injectContent(tab.id);
    } catch (err) {
      console.warn("[SunoGen] initial inject skipped", err);
    }
    syncPageState();
    renderDownloadsFolder()
      .then(() => autoScanDownloadFolder())
      .catch(() => {});
    if (!state.sources.length) {
      logLine("Pick source song(s), choose presets, then Generate batch.");
    }
    readRecording()
      .then((rec) => {
        if (rec && rec.active) {
          recording = true;
          $("record-flow").textContent = "Stop recording";
          logLine("Recording already in progress on the page.");
        }
      })
      .catch(() => {});
  });
})();
