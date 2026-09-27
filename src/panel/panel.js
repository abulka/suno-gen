"use strict";

(function () {
  const T = globalThis.SunoGenTitle;
  const Flow = globalThis.SunoGenCoverFlow;
  const $ = (id) => document.getElementById(id);

  let state = {
    presets: [],
    settings: {},
    batch: { songName: "", date: "", take: "01", rating: "iiiN", workspace: "", autoWorkspace: true },
    source: null
  };
  let editingId = null;
  let recording = false;
  let diagnosticsBlob = "";
  let batchRunning = false;
  let activeJobTitles = new Set();
  let lastStatusByTitle = new Map();

  // ---------- storage ----------

  async function load() {
    const data = await chrome.storage.local.get(["presets", "settings", "lastBatch"]);
    state.presets = Array.isArray(data.presets) ? data.presets : [];
    state.settings = data.settings || {};
    if (data.lastBatch && data.lastBatch.batch) {
      state.batch = Object.assign(state.batch, data.lastBatch.batch);
      state.source = data.lastBatch.source || null;
    }
    if (!state.batch.date) state.batch.date = T.todayYYM();
    if (!state.batch.rating) state.batch.rating = state.settings.rating || "iiiN";
    if (state.batch.autoWorkspace === undefined) {
      state.batch.autoWorkspace = state.settings.autoDeriveWorkspace !== false;
    }
  }

  async function savePresets() {
    await chrome.storage.local.set({ presets: state.presets });
  }

  async function saveBatch() {
    state.batch = readBatchFromDom();
    await chrome.storage.local.set({ lastBatch: { batch: state.batch, source: state.source } });
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
          await sendToContent("SUNOGEN_PING");
          el.textContent = "connected";
          el.className = "pill pill-ok";
        } catch (err) {
          el.textContent = "no connection";
          el.className = "pill pill-err";
          console.warn("[SunoGen] ping failed", err);
        }
      })
      .catch(() => {});
  }

  function renderBatchFields() {
    $("song-name").value = state.batch.songName;
    $("date").value = state.batch.date;
    $("take").value = state.batch.take;
    $("rating").value = state.batch.rating;
    $("auto-workspace").checked = state.batch.autoWorkspace;
    syncWorkspace();
    renderSource();
  }

  /**
   * The DOM is the source of truth for what will be submitted, so a stale
   * cached value can never disagree with what the panel shows.
   */
  function readBatchFromDom() {
    const songName = $("song-name").value;
    const date = $("date").value;
    const autoWorkspace = $("auto-workspace").checked;
    const workspace = autoWorkspace
      ? T.buildWorkspace({ date: date, songName: songName })
      : $("workspace").value;
    return {
      songName: songName,
      date: date,
      take: $("take").value,
      rating: $("rating").value,
      workspace: workspace,
      autoWorkspace: autoWorkspace
    };
  }

  function syncWorkspace() {
    const input = $("workspace");
    const auto = $("auto-workspace").checked;
    if (auto) {
      input.value = T.buildWorkspace({
        date: $("date").value,
        songName: $("song-name").value
      });
    }
    input.readOnly = auto;
    updateDestInfo();
  }

  function updateDestInfo() {
    const el = $("dest-info");
    if (!el) return;
    const auto = $("auto-workspace").checked;
    const ws = auto
      ? T.buildWorkspace({ date: $("date").value, songName: $("song-name").value })
      : $("workspace").value;
    el.innerHTML = "";
    el.appendChild(document.createTextNode("Destination: "));
    const strong = document.createElement("strong");
    strong.textContent = ws || "(none)";
    el.appendChild(strong);
    el.appendChild(
      document.createTextNode(auto ? "  (auto from date + name)" : "  (manual)")
    );
  }

  function renderSource() {
    const el = $("source-info");
    if (state.source && state.source.clipId) {
      el.textContent = (state.source.title || "untitled") + "  ·  " + state.source.clipId;
      el.className = "source-info";
    } else {
      el.textContent = "No source selected";
      el.className = "source-info muted";
    }
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
      source: state.source,
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
      el.textContent = "Select presets and fill the batch fields.";
      return;
    }
    el.className = "preview";
    for (const job of jobs) {
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
      !!state.source &&
      !!$("song-name").value.trim() &&
      state.presets.some((p) => p.selected !== false);
    $("run-batch").disabled = !ready;
  }

  function renderAll() {
    renderBatchFields();
    renderPresets();
    renderPreview();
    updateRunEnabled();
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

    $("add-preset").addEventListener("click", () => openEditor(null));
    $("cancel-edit").addEventListener("click", closeEditor);
    $("save-preset").addEventListener("click", saveEditor);
    $("refresh-preview").addEventListener("click", renderPreview);

    $("p-code").addEventListener("input", (e) => {
      const cleaned = e.target.value.replace(/\s+/g, "").slice(0, 8);
      if (cleaned !== e.target.value) e.target.value = cleaned;
    });

    $("pick-source").addEventListener("click", async () => {
      try {
        await sendToContent("SUNOGEN_START_PICK");
        logLine("Pick mode armed — click a song on the page.");
      } catch (err) {
        logLine(String(err.message || err), "err");
      }
    });

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
      state.source = msg.source;
      const derived = T.deriveSongName(msg.source.title);
      if (derived) $("song-name").value = derived;
      syncWorkspace();
      saveBatch();
      renderSource();
      renderPreview();
      updateRunEnabled();
      logLine("Source set: " + (msg.source.title || msg.source.clipId), "ok");
      if (derived) logLine("  song name → " + derived);
    } else if (msg.event === "pick-armed") {
      // already announced by the button handler
    } else if (msg.event === "pick-cancelled") {
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
    if (!state.source) {
      logLine("Pick a source song, choose presets, then Generate batch.");
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
