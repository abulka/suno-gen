/**
 * SunoGen content script (isolated world).
 *
 * Responsibilities:
 *   - receive commands from the side panel
 *   - run click-to-pick source mode on the page
 *   - execute batches via SunoGenCoverFlow
 *   - relay generation-status events captured by the MAIN-world page hook
 */
(function () {
  "use strict";

  const S = globalThis.SunoGenSelectors;
  const Flow = globalThis.SunoGenCoverFlow;
  console.log("[SunoGen] content script loaded on", location.href);

  // Pick mode state lives on globalThis so a re-injected copy reuses the same
  // listeners/state, and in sessionStorage so it survives SPA navigation/reload.
  const PICK_KEY = "sunogen-pick";

  function pickStore() {
    if (!globalThis.__sunogenPick) {
      globalThis.__sunogenPick = { active: false, multiple: false, overlay: null, onClick: null, onKey: null };
    }
    return globalThis.__sunogenPick;
  }

  function readPickPersist() {
    try {
      return JSON.parse(sessionStorage.getItem(PICK_KEY) || '{"active":false,"multiple":false}');
    } catch (err) {
      return { active: false, multiple: false };
    }
  }

  function writePickPersist(st) {
    try {
      sessionStorage.setItem(PICK_KEY, JSON.stringify(st));
    } catch (err) {
      /* ignore */
    }
  }

  function emit(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({}, payload, { type: "SUNOGEN_EVENT" }));
    } catch (err) {
      // panel may be closed; ignore
    }
  }

  function clipIdFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/(?:song|clip)\/([a-zA-Z0-9-]+)/);
    return m ? m[1] : null;
  }

  function extractSourceFromCard(card) {
    if (!card) return null;
    const row = card.closest(".clip-row") || card.closest("[data-testid='clip-row']") || card;
    const link = row.querySelector("a[href*='/song/'], a[href*='/clip/']");
    const url = link ? link.href : null;
    const title =
      (row.getAttribute("aria-label") || "").trim() ||
      (row.textContent || "").trim().slice(0, 200);
    const clipId =
      row.getAttribute("data-clip-id") ||
      row.getAttribute("data-id") ||
      clipIdFromUrl(url) ||
      title;
    if (!clipId && !title) return null;
    return { clipId: clipId, title: title, url: url, status: row.getAttribute("data-clip-status") };
  }

  function cardFromEventTarget(target) {
    if (!target || !target.closest) return null;
    // Only real clip rows count. Do NOT match a bare [data-clip-id]: while
    // navigating workspaces in pick-multiple mode, workspace/folder rows may be
    // tagged by another extension and must not be treated as song cards.
    return target.closest(".clip-row") || target.closest("[data-testid='clip-row']") || null;
  }

  function onPickClick(ev) {
    const pick = pickStore();
    if (!pick.active) return;
    const card = cardFromEventTarget(ev.target);
    const source = extractSourceFromCard(card);
    if (!source) {
      // Not a song card. In multiple mode this is likely navigating between
      // workspaces — let it through silently. Single mode nudges once.
      if (!pick.multiple) emit({ event: "pick-miss", message: "Click directly on a song card." });
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    emit({ event: "source-picked", source });
    if (!pick.multiple) stopPick();
  }

  function onPickKey(ev) {
    if (!pickStore().active) return;
    if (ev.key === "Escape") {
      stopPick();
      emit({ event: "pick-cancelled" });
    }
  }

  function renderPickOverlay(pick) {
    if (pick.overlay && pick.overlay.parentNode) pick.overlay.parentNode.removeChild(pick.overlay);
    const el = document.createElement("div");
    el.id = "sunogen-pick-overlay";
    el.textContent = pick.multiple
      ? "Pick (multiple) — click songs to add · Esc / Stop when done"
      : "Click a song to use as the cover source (Esc to cancel)";
    Object.assign(el.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#111",
      color: "#fff",
      padding: "10px 16px",
      borderRadius: "8px",
      font: "14px system-ui, sans-serif",
      boxShadow: "0 4px 20px rgba(0,0,0,.4)",
      pointerEvents: "none"
    });
    document.body.appendChild(el);
    pick.overlay = el;
  }

  function startPick(multiple) {
    const pick = pickStore();
    pick.multiple = !!multiple;
    if (!pick.active) {
      pick.active = true;
      pick.onClick = pick.onClick || onPickClick;
      pick.onKey = pick.onKey || onPickKey;
      document.addEventListener("click", pick.onClick, true);
      document.addEventListener("keydown", pick.onKey, true);
      document.documentElement.style.cursor = "crosshair";
    }
    renderPickOverlay(pick);
    writePickPersist({ active: true, multiple: pick.multiple });
    emit({ event: "pick-armed", multiple: pick.multiple });
  }

  function stopPick() {
    const pick = pickStore();
    pick.active = false;
    pick.multiple = false;
    if (pick.onClick) document.removeEventListener("click", pick.onClick, true);
    if (pick.onKey) document.removeEventListener("keydown", pick.onKey, true);
    document.documentElement.style.cursor = "";
    if (pick.overlay && pick.overlay.parentNode) pick.overlay.parentNode.removeChild(pick.overlay);
    pick.overlay = null;
    writePickPersist({ active: false, multiple: false });
  }

  // Resume pick mode if the page reloaded/re-injected mid-pick.
  {
    const persisted = readPickPersist();
    if (persisted.active) startPick(persisted.multiple);
  }

  // Relay generation-status events from the MAIN-world hook (install once).
  // Also stash the latest download metadata on globalThis: content scripts are
  // re-injected whenever the panel opens, which would otherwise wipe a fresh
  // row-indicators instance's in-memory copy and drop the unlock badges.
  if (!globalThis.__sunogenClipMeta) globalThis.__sunogenClipMeta = new Map();
  if (!globalThis.__sunogenPageHooksInstalled) {
    globalThis.__sunogenPageHooksInstalled = true;
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!data || data.source !== "sunogen-page") return;
      emit({ event: "page", payload: data.payload });
      if (data.payload && data.payload.event === "clip-meta" && Array.isArray(data.payload.items)) {
        for (const item of data.payload.items) {
          if (item && item.id) globalThis.__sunogenClipMeta.set(item.id, item);
        }
        try {
          document.dispatchEvent(
            new CustomEvent("sunogen:clip-meta", { detail: { items: data.payload.items } })
          );
        } catch (err) {
          /* ignore */
        }
        // Feed the service worker the clip title -> id map so downloads started
        // via blob: URLs (whose UUID is random) can still be matched by filename.
        try {
          chrome.runtime.sendMessage({ type: "SUNOGEN_CLIP_TITLES", items: data.payload.items });
        } catch (err) {
          /* extension may be reloading */
        }
      }
    });
  }

  // ---------- click/hover recorder (for mapping menus) ----------

  const REC_KEY = "sunogen-recording";
  let recorder = null;

  function readRec() {
    try {
      return JSON.parse(sessionStorage.getItem(REC_KEY) || '{"active":false,"steps":[]}');
    } catch (err) {
      return { active: false, steps: [] };
    }
  }

  function writeRec(rec) {
    try {
      sessionStorage.setItem(REC_KEY, JSON.stringify(rec));
    } catch (err) {
      /* ignore */
    }
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function menuSnapshot() {
    const menus = Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible);
    return menus.map((menuEl) => ({
      menu: S.describeElement(menuEl),
      items: Array.from(
        menuEl.querySelectorAll("button,[role='menuitem'],[role='menuitemradio']")
      )
        .filter(isVisible)
        .map((n) => S.describeElement(n))
    }));
  }

  function installRecorder() {
    if (globalThis.__sunogenRecorder) {
      recorder = globalThis.__sunogenRecorder;
      return;
    }
    if (recorder) return;
    let lastHoverPath = "";

    const push = (step) => {
      const current = readRec();
      current.active = true;
      current.steps.push(step);
      writeRec(current);
    };

    const onClick = (ev) => {
      const t = ev.target;
      const target =
        (t && t.closest && t.closest("button,[role='button'],[role='menuitem'],a,[data-testid]")) ||
        t;
      let desc = null;
      try {
        desc = S.describeElement(target);
      } catch (err) {
        return;
      }
      push({ t: Date.now(), action: "click", url: location.href, el: desc });
      setTimeout(() => {
        push({ t: Date.now(), action: "after-click-menus", menus: menuSnapshot() });
      }, 400);
    };

    const onOver = (ev) => {
      const t = ev.target;
      const el = t && t.closest && t.closest("[role='menuitem'],[role='menu'] button");
      if (!el) return;
      let desc = null;
      try {
        desc = S.describeElement(el);
      } catch (err) {
        return;
      }
      if (desc.path === lastHoverPath) return;
      lastHoverPath = desc.path;
      push({ t: Date.now(), action: "hover", url: location.href, el: desc });
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("mouseover", onOver, true);
    recorder = { onClick: onClick, onOver: onOver };
    globalThis.__sunogenRecorder = recorder;
    emit({ event: "record-started" });
  }

  function startRecording() {
    writeRec({ active: true, steps: [] });
    installRecorder();
  }

  function stopRecording() {
    const rec = readRec();
    if (recorder) {
      document.removeEventListener("click", recorder.onClick, true);
      document.removeEventListener("mouseover", recorder.onOver, true);
      recorder = null;
    }
    globalThis.__sunogenRecorder = null;
    writeRec({ active: false, steps: rec.steps });
    return { steps: rec.steps };
  }

  // resume recording automatically if the page navigated mid-recording
  if (readRec().active) installRecorder();

  const HANDLERS = {
    SUNOGEN_PING: () => ({
      ok: true,
      url: location.href,
      isSuno: /(^|\.)suno\.com$/.test(location.hostname),
      selectorsReady: !!S,
      pick: readPickPersist()
    }),

    SUNOGEN_START_PICK: (msg) => {
      startPick(msg && msg.multiple);
      return { ok: true, multiple: !!(msg && msg.multiple) };
    },

    SUNOGEN_CANCEL_PICK: () => {
      stopPick();
      return { ok: true };
    },

    SUNOGEN_DIAGNOSE: async (msg) => {
      const delay = Number(msg && msg.delayMs) || 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { ok: true, report: S.describe(), fingerprint: S.fingerprint() };
    },

    SUNOGEN_RECORD_START: () => {
      startRecording();
      return { ok: true };
    },

    SUNOGEN_RECORD_STOP: () => ({ ok: true, recording: stopRecording() }),

    SUNOGEN_PREVIEW: (msg) => ({ ok: true, jobs: Flow.buildJobs(msg.config) }),

    SUNOGEN_RUN_BATCH: async (msg) => {
      const results = await Flow.runBatch(msg.config, (evt) => {
        const event = evt.type;
        const rest = Object.assign({}, evt);
        delete rest.type;
        emit(Object.assign({ event: event }, rest));
      });
      return { ok: true, results: results };
    }
  };

  // Always replace any prior handler so a re-injection picks up the new code
  // (a stale handler from before an extension reload would otherwise answer).
  if (globalThis.__sunogenHandler) {
    try {
      chrome.runtime.onMessage.removeListener(globalThis.__sunogenHandler);
    } catch (err) {
      /* ignore */
    }
  }

  const handler = (msg, sender, sendResponse) => {
    if (!msg || !msg.type || !HANDLERS[msg.type]) return false;
    Promise.resolve()
      .then(() => HANDLERS[msg.type](msg))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  };
  globalThis.__sunogenHandler = handler;
  chrome.runtime.onMessage.addListener(handler);
})();
