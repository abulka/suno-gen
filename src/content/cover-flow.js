/**
 * SunoGen cover-flow: drive Suno's Create/Cover UI from a batch config.
 *
 * Confirmed flow (live Suno, Sep 2026):
 *   .clip-row[aria-label] -> button[aria-label="More options"]
 *     -> hover a context-menu trigger (Remix) -> button[aria-label="Cover"]
 *     -> Advanced form: [data-testid=create-form-styles-wrapper] textarea,
 *        input[placeholder="Song Title (Optional)"],
 *        div[contenteditable][aria-label="Lyrics editor"],
 *        "Save to..." workspace picker, button[aria-label="Create song"]
 */
(function (root) {
  "use strict";

  const S = root.SunoGenSelectors;
  const T = root.SunoGenTitle;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    return S.isVisible(el);
  }

  // ---------- cover invocation ----------

  /** Hover/click each submenu trigger in the open clip menu until Cover shows. */
  async function revealCoverMenuItem() {
    if (S.findMenuCover()) return true;
    const menus = Array.from(
      document.querySelectorAll("[data-context-menu='true'], [role='menu']")
    ).filter(isVisible);
    const roots = menus.length ? menus : [document.body];
    const triggers = [];
    for (const rootEl of roots) {
      for (const b of rootEl.querySelectorAll(
        "button[data-context-menu-trigger='true'], [aria-haspopup='menu']"
      )) {
        if (isVisible(b)) triggers.push(b);
      }
    }
    for (const trigger of triggers) {
      S.hoverEl(trigger);
      await sleep(450);
      if (S.findMenuCover()) return true;
      try {
        S.clickEl(trigger);
      } catch (err) {
        /* ignore */
      }
      await sleep(450);
      if (S.findMenuCover()) return true;
    }
    return false;
  }

  /** Type into the clip search (full title, then distinctive fragments). */
  async function searchForClipRow(search, wanted) {
    S.setNativeValue(search, "");
    await sleep(250);
    const queries = [];
    const add = (q) => {
      const v = String(q || "").trim();
      if (v && !queries.includes(v)) queries.push(v);
    };
    add(wanted);
    // Without the date prefix ("glasses v2 - mangled") and without the marker
    // ("2026-06-14 glasses v2"). Suno's search sometimes ranks a long, exact
    // title below other matches, so give it several distinctive probes.
    add(wanted.replace(/^\d{4}-\d{1,2}-\d{1,2}\s+/, ""));
    add(T.deriveSongName(wanted));
    add(T.stripProcessingMarker(wanted));
    for (const len of [32, 24, 16, 10]) {
      if (wanted.length > len) add(wanted.slice(0, len));
    }
    for (const q of queries) {
      S.setNativeValue(search, q);
      await sleep(400);
      const row = await S.waitFor(() => S.findClipRow(wanted) || S.findClipRow(q), {
        timeout: 8000,
        interval: 300
      }).catch(() => null);
      if (row) return row;
    }
    return null;
  }

  /**
   * Make sure the source row is present in the DOM. The active tab can be on a
   * create/workspace view with an unrelated or empty clip list, and after a
   * submission the list re-renders/virtualizes; navigate to the Library and
   * filter the clip search to bring the source back.
   */
  async function ensureSourceRow(title, attempt) {
    const retry = attempt || 0;
    let row = S.findClipRow(title);
    if (row) return row;

    const wanted = String(title).trim();
    const onLibrary = () => /^\/me(\/|$)/.test(location.pathname);

    // After a submission Suno re-renders/virtualizes the list; go back to the
    // Library (client-side route, no reload) so the source is queryable again.
    // NB: don't wait on `.clip-row` alone — the create page has rows too, so it
    // would resolve before the navigation actually happens.
    const lib = S.find("libraryTab");
    if (lib && S.isVisible(lib)) {
      if (!onLibrary()) {
        S.clickEl(lib);
        await S.waitFor(() => (onLibrary() ? true : null), {
          timeout: 10000,
          interval: 200
        }).catch(() => null);
      }
      const search = await S.waitFor(
        () => {
          const el = S.find("clipSearchInput");
          return el && S.isVisible(el) ? el : null;
        },
        { timeout: 8000, interval: 250 }
      ).catch(() => null);
      await sleep(400);
      row = S.findClipRow(wanted);
      if (row) return row;
      if (search) {
        row = await searchForClipRow(search, wanted);
        if (row) return row;
      }
    }

    // No Library tab / route unchanged: still try whatever search box is up.
    const fallbackSearch = S.find("clipSearchInput");
    if (fallbackSearch && S.isVisible(fallbackSearch)) {
      row = await searchForClipRow(fallbackSearch, wanted);
      if (row) return row;
    }

    // Last resort: scroll the list to load more rows, re-checking as we go.
    const first = document.querySelector(".clip-row");
    const scroller =
      (first && first.closest("[class*='overflow']")) || document.scrollingElement;
    if (scroller) {
      for (let i = 0; i < 8 && !row; i++) {
        scroller.scrollTop = i === 0 ? 0 : scroller.scrollTop + 800;
        await sleep(500);
        row = S.findClipRow(wanted);
      }
    }
    if (!row && retry < 1) {
      const search = S.find("clipSearchInput");
      if (search && S.isVisible(search)) S.setNativeValue(search, "");
      await sleep(1500);
      return ensureSourceRow(title, retry + 1);
    }
    return row;
  }

  /** Open the clip menu for the source row and click Cover. */
  async function openCoverForSource(source) {
    if (!source || !source.title) {
      throw new Error("No source track title. Pick a source again.");
    }

    const closeMenu = () => {
      try {
        const target = document.activeElement || document.body;
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      } catch (err) {
        /* ignore */
      }
    };

    let lastError = null;
    // Menus occasionally fail to render on the first click (Suno re-renders the
    // row after each Create). Retry the whole row/menu path once instead of
    // skipping the song.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await ensureSourceRow(source.title);
      if (!row) {
        lastError = new Error("Could not find a clip row titled '" + source.title + "'.");
        await sleep(1500);
        continue;
      }

      const more =
        S.findIn(row, "moreOptionsButton") || row.querySelector("[aria-label='More options']");
      if (!more) {
        lastError = new Error("No 'More options' button found in the clip row.");
        await sleep(800);
        continue;
      }

      closeMenu();
      await sleep(300);
      S.clickEl(more);
      const menuOpened = await S.waitFor(
        () => {
          const menus = Array.from(
            document.querySelectorAll("[data-context-menu='true'], [role='menu']")
          ).filter(isVisible);
          return menus.length ? true : null;
        },
        { timeout: 6000 }
      ).catch(() => null);

      if (menuOpened && (await revealCoverMenuItem())) {
        const coverItem = S.findMenuCover();
        if (coverItem) {
          S.clickEl(coverItem);
          await sleep(700);
          await clickKeepCurrentIfPresent();
          return true;
        }
        lastError = new Error("Cover menu item vanished before it could be clicked.");
      } else {
        lastError = new Error(
          "Cover menu item did not appear. Record the flow and update selectors."
        );
      }

      closeMenu();
      await sleep(1200);
    }

    throw lastError || new Error("Could not open the Cover menu.");
  }

  // ---------- dialogs ----------

  async function clickTextButton(pattern, timeout) {
    return S.waitFor(
      () => {
        const nodes = document.querySelectorAll("button,[role='button']");
        for (const n of nodes) {
          if (!isVisible(n)) continue;
          if (pattern.test((n.textContent || "").trim())) return n;
        }
        return null;
      },
      { timeout: timeout || 2500 }
    ).catch(() => null);
  }

  async function clickKeepCurrentIfPresent() {
    const btn = await clickTextButton(/^keep current$/i, 2500);
    if (btn) {
      S.clickEl(btn);
      await sleep(500);
      return true;
    }
    return false;
  }

  async function dismissOverwriteDialog() {
    const btn = await S.waitFor(
      () => {
        const dialogs = Array.from(
          document.querySelectorAll("[role='dialog'],[role='alertdialog']")
        ).filter(isVisible);
        const roots = dialogs.length ? dialogs : [document.body];
        for (const rootEl of roots) {
          for (const n of rootEl.querySelectorAll("button,[role='button']")) {
            if (!isVisible(n)) continue;
            const t = (n.textContent || "").trim().toLowerCase();
            if (/^(overwrite|replace|yes|continue|confirm|ok)\b/.test(t)) return n;
          }
        }
        return null;
      },
      { timeout: 1200 }
    ).catch(() => null);
    if (btn) {
      S.clickEl(btn);
      await sleep(400);
      return true;
    }
    return false;
  }

  // ---------- form filling ----------

  async function ensureAdvancedMode() {
    const tab = S.find("advancedTab");
    if (!tab || !isVisible(tab)) return;
    if (tab.getAttribute("aria-selected") !== "true") {
      S.clickEl(tab);
      await sleep(500);
    }
  }

  async function setField(key, value) {
    const el = await S.waitForKey(key, { timeout: 8000 });
    S.setNativeValue(el, value);
    await sleep(300);
    const again = S.find(key);
    if (again && again !== el && again.value !== value) {
      S.setNativeValue(again, value);
      await sleep(300);
    }
  }

  async function fillStyle(stylePrompt) {
    if (!stylePrompt) return;
    await setField("styleInput", stylePrompt);
  }

  async function fillTitle(title) {
    await setField("titleInput", title);
  }

  function setContentEditable(el, text) {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (err) {
      ok = false;
    }
    if (!ok || !(el.textContent || "").includes(text)) {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text
        })
      );
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
      );
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillLyrics(text) {
    if (!text) return;
    const toggle = S.find("lyricsToggle");
    if (toggle && isVisible(toggle) && toggle.getAttribute("aria-expanded") === "false") {
      S.clickEl(toggle);
      await sleep(450);
    }
    await dismissOverwriteDialog();
    const editor = await S.waitForKey("lyricsEditor", { timeout: 6000 }).catch(() => null);
    if (!editor) throw new Error("Lyrics editor not found.");
    setContentEditable(editor, text);
    await sleep(600);
    const again = S.find("lyricsEditor");
    const current = ((again || editor).textContent || "").toLowerCase();
    if (!current.includes(String(text).toLowerCase())) {
      setContentEditable(again || editor, text);
      await sleep(400);
    }
    await dismissOverwriteDialog();
  }

  function workspacePillMatches(name) {
    const trigger = S.findWorkspaceTrigger();
    if (!trigger) return false;
    return (trigger.textContent || "").trim().toLowerCase() === String(name).trim().toLowerCase();
  }

  /**
   * Pick or create the target workspace and VERIFY the "Save to..." pill
   * actually changed. Suno defaults covers to the source's workspace, so a
   * silent failure would submit generations to the wrong place.
   */
  async function selectWorkspace(name) {
    if (!name) return;
    const target = String(name).trim();

    for (let attempt = 0; attempt < 2; attempt++) {
      // The picker may already be open from a prior attempt; toggling the
      // trigger would close it, so only click when it's not visible.
      let input = S.find("workspaceSearchInput");
      if (!input || !S.isVisible(input)) {
        const trigger = S.findWorkspaceTrigger();
        if (!trigger) throw new Error("Workspace 'Save to...' control not found.");
        S.clickEl(trigger);
        input = await S.waitForKey("workspaceSearchInput", { timeout: 6000 }).catch(() => null);
      }
      if (!input || !S.isVisible(input)) throw new Error("Workspace picker did not open.");

      S.setNativeValue(input, target);
      // Wait for the filtered list (or the create-new button) to update.
      await S.waitFor(
        () => {
          const opt = S.findWorkspaceOption(target);
          const btn = S.find("createWorkspaceButton");
          return opt || (btn && S.isVisible(btn)) ? true : null;
        },
        { timeout: 4000, interval: 200 }
      ).catch(() => null);

      const option = S.findWorkspaceOption(target);
      if (option) {
        S.clickEl(option);
        await sleep(500);
      } else {
        const createBtn = S.find("createWorkspaceButton");
        if (!createBtn || !S.isVisible(createBtn)) {
          throw new Error(
            "Workspace '" + target + "' not found and no create-new button appeared."
          );
        }
        S.clickEl(createBtn);
        await sleep(1000);
      }

      if (workspacePillMatches(target)) return true;
      await sleep(400);
    }
    throw new Error(
      "Workspace did not switch to '" + target + "' — stopping before spending credits."
    );
  }

  async function clickCreate() {
    const btn = await S.waitForKey("createButton", { timeout: 8000 });
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      await sleep(600);
    }
    S.clickEl(btn);
    await sleep(600);
  }

  /**
   * Suno populates the form from the cover source asynchronously; wait until the
   * style/title fields have content (or a short grace period passes) before we
   * write our own values, otherwise Suno overwrites them.
   */
  async function waitForCoverData(timeout) {
    await S.waitFor(
      () => {
        const title = S.find("titleInput");
        const style = S.find("styleInput");
        return (title && title.value) || (style && style.value) ? true : null;
      },
      { timeout: timeout || 4000, interval: 200 }
    ).catch(() => null);
    await sleep(500);
  }

  /** Distinctive, lowercased fragments of a source's title/id for matching. */
  function sourceTokens(source) {
    const raw = (source && source.title) || "";
    const parts = [source && source.clipId, raw].concat(
      String(raw).split(/[·|\-–,]/)
    );
    const seen = new Set();
    for (const p of parts) {
      const t = String(p || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (t.length >= 4) seen.add(t);
    }
    return Array.from(seen);
  }

  /**
   * Guard against submitting a cover against the WRONG audio. Suno keeps the
   * previously loaded track if the Cover menu item didn't actually apply, so
   * confirm the create panel's loaded-source chip references the picked source
   * before we fill/ Create. Best-effort: if no chip is readable, don't block.
   */
  async function verifyLoadedSource(source, timeout) {
    if (!source || !source.title) return true;
    const tokens = sourceTokens(source);
    if (!tokens.length) return true;
    const matches = () => {
      const chip = S.loadedCoverText();
      if (!chip) return null; // unknown yet
      const low = chip.toLowerCase();
      return tokens.some((tok) => low.includes(tok)) ? true : false;
    };
    const deadline = Date.now() + (timeout || 4000);
    let sawChip = false;
    while (Date.now() < deadline) {
      const r = matches();
      if (r === true) return true;
      if (r === false) sawChip = true;
      await sleep(400);
    }
    if (!sawChip) return true;
    throw new Error(
      "Loaded cover source does not match the picked source ('" +
        source.title +
        "'). Aborting before Create to avoid generating the wrong audio."
    );
  }

  /** Get Suno into cover mode for `source` and the Advanced form ready. */
  async function ensureCoverContext(source) {
    await openCoverForSource(source);
    await ensureAdvancedMode();
    await S.waitForKey("styleInput", { timeout: 15000 });
    await waitForCoverData();
    await verifyLoadedSource(source);
    return true;
  }

  // ---------- batch ----------

  function buildJobs(config) {
    const { batch, presets } = config;
    const sources =
      Array.isArray(config.sources) && config.sources.length
        ? config.sources
        : config.source
        ? [config.source]
        : [];
    const selected = presets.filter((p) => p.selected !== false);
    const names = T.uniqueSourceNames(sources);
    const globalTake = batch.globalTake !== false;
    const jobs = [];
    let jobIndex = 0;

    sources.forEach((source, sourceIndex) => {
      const songName = names[sourceIndex];
      // Auto workspace is derived PER SOURCE; manual means one workspace for all.
      const wsBatch = {
        date: batch.date,
        songName: songName,
        workspace:
          batch.autoWorkspace === false
            ? batch.workspace
            : T.buildWorkspace({ date: batch.date, songName: songName })
      };
      selected.forEach((preset, presetIndex) => {
        // Suno always makes 2 clips per Create; step the take by 2. Global mode
        // keeps counting across songs, otherwise it resets per song.
        const offset = (globalTake ? jobIndex : presetIndex) * 2;
        jobs.push({
          presetId: preset.id,
          presetName: preset.name,
          styleCode: preset.styleCode,
          source: source,
          sourceIndex: sourceIndex,
          songName: songName,
          title: T.buildTitle({
            date: batch.date,
            take: T.offsetTake(batch.take, offset),
            rating: batch.rating,
            styleCode: preset.styleCode,
            songName: songName
          }),
          workspace: T.resolveWorkspace(wsBatch, preset),
          workspaceIsOverride: !!(preset.workspaceOverride && preset.workspaceOverride.trim())
        });
        jobIndex++;
      });
    });
    return jobs;
  }

  /**
   * Feed-based monitor: reads the library feed (not just visible rows) so
   * off-screen clips, missing siblings and error statuses are all accounted
   * for. Returns a verification report, or null when the feed is unavailable
   * (caller falls back to DOM polling).
   */
  async function monitorJobsFeed(jobs, emit, timeoutMs, createdAfter) {
    const Catalog = root.SunoGenCatalog;
    if (!Catalog || typeof Catalog.recentClips !== "function") return null;

    const expected = new Map();
    for (const job of jobs) {
      const key = job.title.trim().toLowerCase();
      const entry = expected.get(key);
      if (entry) entry.expected += 2;
      else expected.set(key, { title: job.title.trim(), count: 0, expected: 2 });
    }
    const cutoff = (createdAfter || Date.now() - 15 * 60 * 1000) - 60 * 1000;
    const noClipGraceMs = 30000; // a Create should show up well within this
    const last = new Map();
    const started = Date.now();
    const limit = timeoutMs || 300000;
    let terminalRounds = 0;
    let emptyRounds = 0;
    let lastClips = [];

    while (Date.now() - started < limit) {
      let clips = null;
      try {
        clips = await Catalog.recentClips(400);
      } catch (err) {
        return null; // signed out / endpoint changed: use DOM polling
      }
      lastClips = clips;

      const byTitle = new Map();
      for (const clip of clips) {
        const key = String(clip.title || "").trim().toLowerCase();
        if (!expected.has(key)) continue;
        const created = clip.createdAt ? Date.parse(clip.createdAt) : 0;
        if (created && created < cutoff) continue; // older batch with same title
        const list = byTitle.get(key) || [];
        list.push(clip);
        byTitle.set(key, list);
      }

      if (!byTitle.size) {
        emptyRounds++;
        // Feed has nothing for this batch yet; give it a few rounds, then fall
        // back to DOM polling rather than waiting on an unrelated feed.
        if (emptyRounds >= 6) return null;
      } else {
        emptyRounds = 0;
      }

      let allTerminal = true;
      for (const [key, info] of expected) {
        const list = byTitle.get(key) || [];
        if (list.length > info.count) info.count = list.length;
        const statuses = list.map((c) => String(c.status || "").toLowerCase());
        let status = "submitted";
        if (!list.length) {
          status = Date.now() - started > noClipGraceMs ? "missing" : "submitted";
        } else if (statuses.some((s) => s === "error" || s === "failed")) {
          status = "error";
        } else if (statuses.every((s) => s === "complete")) {
          status = "complete";
        } else if (statuses.some((s) => s === "streaming")) {
          status = "streaming";
        } else {
          status = "queued";
        }

        if (last.get(key) !== status) {
          last.set(key, status);
          emit({ type: "job-status", title: info.title, status: status });
        }
        if (
          status !== "complete" &&
          status !== "error" &&
          status !== "failed" &&
          status !== "missing"
        ) {
          allTerminal = false;
        }
      }

      if (allTerminal) {
        // Every title we can see is terminal. Give late/failed siblings a grace
        // period to appear before calling the batch short.
        const short = [...expected.values()].some((v) => v.count < v.expected);
        if (!short) break;
        terminalRounds++;
        if (terminalRounds >= 6) break; // ~30 s
      } else {
        terminalRounds = 0;
      }
      await sleep(5000);
    }

    const report = [...expected.values()].map((v) => ({
      title: v.title,
      found: v.count,
      expected: v.expected
    }));
    const errors = [];
    for (const clip of lastClips) {
      if (!expected.has(String(clip.title || "").trim().toLowerCase())) continue;
      if (clip.status === "error" || clip.status === "failed" || clip.errorType) {
        errors.push({
          title: clip.title,
          status: clip.status,
          errorType: clip.errorType,
          errorMessage: clip.errorMessage
        });
      }
    }
    emit({ type: "batch-verify", jobs: report, errors: errors });
    return report;
  }

  /**
   * Poll the visible clip rows for our job titles until they finish.
   * Rows expose data-clip-status (queued / streaming / complete / error).
   */
  async function monitorJobs(jobs, emit, timeoutMs, createdAfter) {
    const feed = await monitorJobsFeed(jobs, emit, timeoutMs, createdAfter).catch(() => null);
    if (feed) return feed;

    const titleByKey = new Map(
      jobs.map((j) => [j.title.trim().toLowerCase(), j.title.trim()])
    );
    const wanted = new Set(titleByKey.keys());
    const last = new Map();
    const started = Date.now();
    let sawAny = false;
    const limit = timeoutMs || 300000;

    while (Date.now() - started < limit) {
      const statuses = new Map();
      for (const row of S.findAll("clipRow")) {
        const label = (row.getAttribute("aria-label") || "").trim().toLowerCase();
        if (!wanted.has(label)) continue;
        statuses.set(label, row.getAttribute("data-clip-status") || "unknown");
      }
      if (statuses.size) {
        sawAny = true;
        for (const [label, status] of statuses) {
          if (last.get(label) !== status) {
            last.set(label, status);
            emit({
              type: "job-status",
              title: titleByKey.get(label) || label,
              status: status
            });
          }
        }
        const values = Array.from(statuses.values());
        if (values.every((v) => v === "complete" || v === "error" || v === "failed")) break;
      } else if (sawAny || Date.now() - started > 45000) {
        break; // rows scrolled out of view; stop waiting
      }
      await sleep(5000);
    }
  }

  async function runBatch(config, emit) {
    const log = emit || (() => {});
    const settings = config.settings || {};
    const delay = Math.max(0, settings.delayMs || 4000);
    const jobs = buildJobs(config);

    if (!jobs.length) throw new Error("No source(s)/presets selected.");
    if (config.dryRun) {
      for (const job of jobs) log({ type: "job-preview", job: job });
      return jobs;
    }

    const results = [];
    const batchStarted = Date.now();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const preset = config.presets.find((p) => p.id === job.presetId);
      log({ type: "job-start", index: i, total: jobs.length, job: job });
      try {
        // Re-attach the cover for THIS job's source each time; Create may reset
        // the form and switching sources must actually swap the loaded audio.
        await ensureCoverContext(job.source);
        await fillStyle(preset.stylePrompt);
        await fillTitle(job.title);
        await fillLyrics(preset.lyrics || settings.lyricsText || "[instrumental]");
        await selectWorkspace(job.workspace);
        await clickCreate();
        log({ type: "job-submitted", index: i, job: job });
        results.push({ job: job, ok: true });
      } catch (err) {
        const message = String((err && err.message) || err);
        log({ type: "job-error", index: i, job: job, error: message });
        results.push({ job: job, ok: false, error: message });
      }
      if (i < jobs.length - 1) await sleep(delay);
    }

    if (results.some((r) => r.ok)) {
      log({ type: "monitor-start", count: results.filter((r) => r.ok).length });
      await monitorJobs(jobs, log, settings.monitorTimeoutMs, batchStarted);
    }
    // Leave the library search as we found it.
    try {
      const search = S.find("clipSearchInput");
      if (search && S.isVisible(search) && search.value) S.setNativeValue(search, "");
    } catch (err) {
      /* ignore */
    }
    log({ type: "batch-complete", results: results });
    return results;
  }

  root.SunoGenCoverFlow = {
    buildJobs: buildJobs,
    runBatch: runBatch,
    _internals: {
      openCoverForSource: openCoverForSource,
      ensureSourceRow: ensureSourceRow,
      revealCoverMenuItem: revealCoverMenuItem,
      ensureAdvancedMode: ensureAdvancedMode,
      ensureCoverContext: ensureCoverContext,
      verifyLoadedSource: verifyLoadedSource,
      fillStyle: fillStyle,
      fillTitle: fillTitle,
      fillLyrics: fillLyrics,
      selectWorkspace: selectWorkspace,
      clickCreate: clickCreate,
      monitorJobs: monitorJobs,
      monitorJobsFeed: monitorJobsFeed
    }
  };
})(globalThis);
