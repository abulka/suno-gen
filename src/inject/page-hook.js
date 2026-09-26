/**
 * SunoGen MAIN-world page hook.
 *
 * Runs in the page's own JS context so it can read network responses that the
 * isolated content script cannot. It never sends data anywhere; it only
 * forwards a small summary back to the content script via window.postMessage.
 *
 * Phase 0/4: wire the parsed payloads into the panel's status monitor.
 */
(function () {
  "use strict";

  if (window.__sunogenHooked) return;
  window.__sunogenHooked = true;

  const API_HINTS = ["/api/", "studio-api", "feed", "generate", "clips"];
  const STATUS_HINTS = ["submitted", "queued", "streaming", "complete", "error", "failed"];

  function post(payload) {
    window.postMessage({ source: "sunogen-page", payload: payload }, "*");
  }

  // Remember the last status per clip id so each change is reported once.
  const lastStatus = new Map();

  function interesting(url) {
    if (!url) return false;
    const u = String(url);
    return API_HINTS.some((h) => u.includes(h));
  }

  function summarize(url, text) {
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return null;
    }
    const clips = [];
    const visit = (node, depth) => {
      if (!node || depth > 5) return;
      if (Array.isArray(node)) {
        node.forEach((n) => visit(n, depth + 1));
        return;
      }
      if (typeof node !== "object") return;
      const id = node.id || node.clip_id;
      const status = node.status || node.state;
      if (
        id &&
        typeof id === "string" &&
        id.length >= 8 &&
        status &&
        typeof status === "string" &&
        STATUS_HINTS.includes(status.toLowerCase())
      ) {
        const meta = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
        clips.push({ id: id, title: node.title || meta.title || null, status: status });
      }
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    };
    visit(json, 0);

    const changed = [];
    for (const c of clips) {
      const prev = lastStatus.get(c.id);
      if (prev === c.status) continue;
      lastStatus.set(c.id, c.status);
      // Don't announce pre-existing finished clips; only transitions matter.
      if (prev === undefined && c.status.toLowerCase() === "complete") continue;
      changed.push(c);
    }
    if (lastStatus.size > 2000) lastStatus.clear();
    if (!changed.length) return null;
    return { url: url, clips: changed, at: Date.now() };
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      const args = arguments;
      const req = args[0];
      const url = typeof req === "string" ? req : req && req.url;
      const p = origFetch.apply(this, args);
      if (!interesting(url)) return p;
      return p.then((res) => {
        try {
          const clone = res.clone();
          clone.text().then((text) => {
            const s = summarize(url, text);
            if (s) post(s);
          }).catch(() => {});
        } catch (err) {
          /* ignore */
        }
        return res;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__sunogenUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      this.addEventListener("load", () => {
        try {
          if (!interesting(this.__sunogenUrl)) return;
          const s = summarize(this.__sunogenUrl, this.responseText);
          if (s) post(s);
        } catch (err) {
          /* ignore */
        }
      });
      return origSend.apply(this, arguments);
    };
  }

  post({ event: "hook-ready" });
})();
