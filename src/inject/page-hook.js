/**
 * SunoGen MAIN-world page hook.
 *
 * Runs in the page's own JS context so it can read network responses that the
 * isolated content script cannot. It never sends data anywhere; it only
 * forwards a small summary back to the content script via window.postMessage.
 *
 * Emits two payload shapes:
 *   - { url, clips:[{id,title,status}], at }          generation status changes
 *   - { event:"clip-meta", items:[{id,title,unlocked,known,hasStem,upload}], at }
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
  // Remember the last download metadata per clip id so we only emit on change.
  const lastMeta = new Map();

  function interesting(url) {
    if (!url) return false;
    const u = String(url);
    return API_HINTS.some((h) => u.includes(h));
  }

  function statusFrom(url, json) {
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
    if (!changed.length) return;
    post({ url: url, clips: changed, at: Date.now() });
  }

  /**
   * Collect every clip's download metadata. `is_download_unlocked` is Suno's
   * authoritative "you already own this download" flag; `known` tells the UI
   * whether Suno actually reported it (absent vs explicitly false).
   */
  function clipMetaFrom(json) {
    const found = [];
    const pushClip = (node) => {
      if (!node || typeof node !== "object") return;
      const id = node.id || node.clip_id;
      if (typeof id !== "string" || id.length < 8) return;
      const meta = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
      const raw = node.is_download_unlocked;
      found.push({
        id: id,
        title: node.title || meta.title || null,
        unlocked: raw === true,
        known: typeof raw === "boolean",
        hasStem: meta.has_stem === true,
        upload: meta.type === "upload"
      });
    };

    if (json && Array.isArray(json.clips)) {
      json.clips.forEach(pushClip);
    } else {
      const visit = (node, depth) => {
        if (!node || depth > 5) return;
        if (Array.isArray(node)) {
          node.forEach((n) => visit(n, depth + 1));
          return;
        }
        if (typeof node !== "object") return;
        if (typeof node.is_download_unlocked === "boolean") pushClip(node);
        for (const key of Object.keys(node)) visit(node[key], depth + 1);
      };
      visit(json, 0);
    }

    const changed = [];
    for (const c of found) {
      const sig = c.unlocked + "|" + c.known + "|" + c.hasStem + "|" + c.upload + "|" + (c.title || "");
      if (lastMeta.get(c.id) === sig) continue;
      lastMeta.set(c.id, sig);
      changed.push(c);
    }
    if (lastMeta.size > 5000) lastMeta.clear();
    if (!changed.length) return;
    post({ event: "clip-meta", items: changed, at: Date.now() });
  }

  function handle(url, text) {
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return;
    }
    if (!json) return;
    statusFrom(url, json);
    clipMetaFrom(json);
  }

  function handleObject(url, json) {
    if (!json || typeof json !== "object") return;
    statusFrom(url, json);
    clipMetaFrom(json);
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
          clone
            .text()
            .then((text) => handle(url, text))
            .catch(() => {});
        } catch (err) {
          /* ignore */
        }
        return res;
      });
    };
  }

  // Fallback for responses our fetch wrapper missed: read the result of Suno's
  // own body parsing. Handlers dedupe, so double handling is harmless.
  const nativeJson = typeof Response !== "undefined" && Response.prototype.json;
  if (nativeJson) {
    Response.prototype.json = function () {
      const p = nativeJson.apply(this, arguments);
      const url = this.url;
      if (interesting(url)) {
        p.then((data) => handleObject(url, data), () => {});
      }
      return p;
    };
  }

  const nativeText = typeof Response !== "undefined" && Response.prototype.text;
  if (nativeText) {
    Response.prototype.text = function () {
      const p = nativeText.apply(this, arguments);
      const url = this.url;
      if (interesting(url)) {
        p.then((body) => handle(url, body), () => {});
      }
      return p;
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
          handle(this.__sunogenUrl, this.responseText);
        } catch (err) {
          /* ignore */
        }
      });
      return origSend.apply(this, arguments);
    };
  }

  post({ event: "hook-ready" });
})();
