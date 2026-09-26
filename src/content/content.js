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

  let pickActive = false;
  let pickOverlay = null;

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
    return (
      target.closest(".clip-row") ||
      target.closest("[data-testid='clip-row']") ||
      target.closest("[data-clip-id]") ||
      null
    );
  }

  function onPickClick(ev) {
    if (!pickActive) return;
    const card = cardFromEventTarget(ev.target);
    const source = extractSourceFromCard(card);
    if (!source) {
      emit({ event: "pick-miss", message: "Click directly on a song card." });
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    stopPick();
    emit({ event: "source-picked", source });
  }

  function startPick() {
    if (pickActive) return;
    pickActive = true;
    pickOverlay = document.createElement("div");
    pickOverlay.id = "sunogen-pick-overlay";
    pickOverlay.textContent = "Click a song to use as the cover source (Esc to cancel)";
    Object.assign(pickOverlay.style, {
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
    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("click", onPickClick, true);
    document.addEventListener("keydown", onPickKey, true);
    document.body.appendChild(pickOverlay);
    emit({ event: "pick-armed" });
  }

  function onPickKey(ev) {
    if (ev.key === "Escape") {
      stopPick();
      emit({ event: "pick-cancelled" });
    }
  }

  function stopPick() {
    pickActive = false;
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onPickKey, true);
    document.documentElement.style.cursor = "";
    if (pickOverlay && pickOverlay.parentNode) pickOverlay.parentNode.removeChild(pickOverlay);
    pickOverlay = null;
  }

  // Relay generation-status events from the MAIN-world hook (install once).
  if (!globalThis.__sunogenPageHooksInstalled) {
    globalThis.__sunogenPageHooksInstalled = true;
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!data || data.source !== "sunogen-page") return;
      emit({ event: "page", payload: data.payload });
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
      selectorsReady: !!S
    }),

    SUNOGEN_START_PICK: () => {
      startPick();
      return { ok: true };
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
