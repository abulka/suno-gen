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
  let activeJobTitles = new Set();
  let lastStatusByTitle = new Map();
  let pickMode = false;
  let pickMultiple = false;

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
    "src/content/content.js"
  ];

  // Injects into a tab that was already open when the extension was loaded.
  async function injectContent(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false },
      files: CONTENT_FILES
    });
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

  function updatePageStatus() {
    const el = $("page-status");
    getTab()
      .then(async (tab) => {
        if (!tab) return;
        if (!isSunoUrl(tab.url)) {
          el.textContent = "not on suno.com";
          el.className = "pill pill-warn";
          return;
        }
        try {
          const res = await sendToContent("SUNOGEN_PING");
          el.textContent = "connected";
          el.className = "pill pill-ok";
          if (res && res.pick) {
            pickMode = !!res.pick.active;
            pickMultiple = !!res.pick.multiple;
            updatePickStatus();
          }
        } catch (err) {
          el.textContent = "no connection";
          el.className = "pill pill-err";
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
    $("run-batch").disabled = !ready;
  }

  function renderAll() {
    renderBatchFields();
    renderPresets();
    renderPreview();
    updateRunEnabled();
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

    $("diagnose").addEventListener("click", () => runDiagnose());

    const copyLog = async () => {
      const text =
        $("log").innerText +
        (diagnosticsBlob ? "\n\n=== DIAGNOSTICS ===\n" + diagnosticsBlob : "");
      const ok = await copyText(text);
      logLine(ok ? "Log copied to clipboard." : "Clipboard blocked.", ok ? "ok" : "err");
    };
    $("copy-log").addEventListener("click", copyLog);
    $("copy-log-top").addEventListener("click", copyLog);

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
      const config = currentConfig();
      config.dryRun = $("dry-run").checked;
      logLine("Starting batch (" + (config.dryRun ? "dry run" : "live") + ")…");
      batchRunning = !config.dryRun;
      try {
        const res = await sendToContent("SUNOGEN_RUN_BATCH", { config: config });
        if (config.dryRun && res.results) {
          res.results.forEach((j) => logLine("  preview: " + j.title));
        }
        logLine("Batch call returned.");
      } catch (err) {
        logLine(String(err.message || err), "err");
      } finally {
        batchRunning = false;
      }
    });
  }

  function onRuntimeMessage(msg) {
    if (!msg || msg.type !== "SUNOGEN_EVENT") return;
    if (msg.event === "source-picked") {
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
      logLine("Pick cancelled.");
    } else if (msg.event === "pick-miss") {
      logLine(msg.message || "No song card detected.", "err");
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
    updatePageStatus();
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
