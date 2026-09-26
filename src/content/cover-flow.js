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
    if (S.find("menuCover")) return true;
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
      if (S.find("menuCover")) return true;
      try {
        S.clickEl(trigger);
      } catch (err) {
        /* ignore */
      }
      await sleep(450);
      if (S.find("menuCover")) return true;
    }
    return false;
  }

  /**
   * Make sure the source row is present in the DOM. After a submission the
   * library list re-renders and virtualizes, so the source can drop out; fall
   * back to filtering the clip search to bring it back.
   */
  async function ensureSourceRow(title) {
    let row = S.findClipRow(title);
    if (row) return row;

    // After a submission Suno re-renders/virtualizes the list; go back to the
    // Library (client-side route, no reload) so the source is queryable again.
    const lib = S.find("libraryTab");
    if (lib && S.isVisible(lib)) {
      S.clickEl(lib);
      await sleep(1200);
      row = S.findClipRow(title);
      if (row) return row;
    }

    const search = S.find("clipSearchInput");
    if (search && S.isVisible(search)) {
      S.setNativeValue(search, title);
      row = await S.waitFor(() => S.findClipRow(title), { timeout: 10000, interval: 300 }).catch(
        () => null
      );
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
        row = S.findClipRow(title);
      }
    }
    return row;
  }

  /** Open the clip menu for the source row and click Cover. */
  async function openCoverForSource(source) {
    if (!source || !source.title) {
      throw new Error("No source track title. Pick a source again.");
    }
    await S.waitFor(() => document.querySelector(".clip-row, [data-testid='clip-row']"), {
      timeout: 12000
    }).catch(() => {
      throw new Error("No clip rows on screen. Open Library/create list first.");
    });

    const row = await ensureSourceRow(source.title);
    if (!row) throw new Error("Could not find a clip row titled '" + source.title + "'.");

    const more =
      S.findIn(row, "moreOptionsButton") || row.querySelector("[aria-label='More options']");
    if (!more) throw new Error("No 'More options' button found in the clip row.");

    S.clickEl(more);
    await S.waitFor(
      () =>
        document.querySelector("[data-context-menu='true'], [role='menu'], button[aria-label='Cover']"),
      { timeout: 6000 }
    ).catch(() => null);

    if (!(await revealCoverMenuItem())) {
      throw new Error("Cover menu item did not appear. Record the flow and update selectors.");
    }

    S.clickEl(S.find("menuCover"));
    await sleep(700);
    await clickKeepCurrentIfPresent();
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

  /** Best-effort model selection; silently keeps the current model if unsure. */
  async function selectModel(model) {
    if (!model) return;
    const btn = S.find("modelButton");
    if (!btn) return;
    const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_]/g, "");
    const wanted = norm(model);
    if (norm(btn.textContent) === wanted) return;
    S.clickEl(btn);
    await sleep(500);
    const match = await S.waitFor(
      () => {
        const nodes = document.querySelectorAll(
          "button,[role='menuitem'],[role='option'],[role='menuitemradio']"
        );
        for (const n of nodes) {
          if (!isVisible(n) || n === btn) continue;
          const t = norm(n.textContent);
          if (t && t.length <= 40 && t.startsWith(wanted)) return n;
        }
        return null;
      },
      { timeout: 2500 }
    ).catch(() => null);
    if (match) {
      S.clickEl(match);
    } else {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    }
    await sleep(300);
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

  /** Get Suno into cover mode for `source` and the Advanced form ready. */
  async function ensureCoverContext(source) {
    await openCoverForSource(source);
    await ensureAdvancedMode();
    await S.waitForKey("styleInput", { timeout: 15000 });
    await waitForCoverData();
    return true;
  }

  // ---------- batch ----------

  function buildJobs(config) {
    const { batch, presets } = config;
    return presets
      .filter((p) => p.selected !== false)
      .map((preset) => ({
        presetId: preset.id,
        presetName: preset.name,
        styleCode: preset.styleCode,
        title: T.buildTitle({
          date: batch.date,
          take: batch.take,
          rating: batch.rating,
          styleCode: preset.styleCode,
          songName: batch.songName
        }),
        workspace: T.resolveWorkspace(batch, preset),
        workspaceIsOverride: !!(preset.workspaceOverride && preset.workspaceOverride.trim())
      }));
  }

  /**
   * Poll the visible clip rows for our job titles until they finish.
   * Rows expose data-clip-status (queued / streaming / complete / error).
   */
  async function monitorJobs(jobs, emit, timeoutMs) {
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

    if (!jobs.length) throw new Error("No presets selected.");
    if (config.dryRun) {
      for (const job of jobs) log({ type: "job-preview", job: job });
      return jobs;
    }

    const results = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const preset = config.presets.find((p) => p.id === job.presetId);
      log({ type: "job-start", index: i, total: jobs.length, job: job });
      try {
        // Re-attach the cover each time; Create may reset the form.
        await ensureCoverContext(config.source);
        await selectModel(preset.model || settings.defaultModel);
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
      await monitorJobs(jobs, log, settings.monitorTimeoutMs);
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
      fillStyle: fillStyle,
      fillTitle: fillTitle,
      fillLyrics: fillLyrics,
      selectModel: selectModel,
      selectWorkspace: selectWorkspace,
      clickCreate: clickCreate,
      monitorJobs: monitorJobs
    }
  };
})(globalThis);
