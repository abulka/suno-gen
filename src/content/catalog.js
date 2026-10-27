/**
 * SunoGen catalogue helpers (isolated world).
 *
 * Currently: the complete workspace list for the "Export catalog JSON" tool.
 *
 * Suno calls workspaces "projects". The create panel's "Save to..." picker
 * loads them lazily, 20 at a time as you scroll, and only while the popover is
 * open — so scraping its DOM silently truncates big accounts (a 215-workspace
 * account exported 100). We therefore read the same endpoint the picker talks
 * to, `/a/api/project/me`, paging until every row is in, and fall back to the
 * picker DOM only if that endpoint is unavailable.
 *
 * Auth: the endpoint wants the Clerk session JWT, which Suno also keeps in the
 * JS-readable `__session` cookie. Reading it at export time (rather than
 * replaying a captured `Authorization` header) means the token is always fresh.
 */
(function (root) {
  "use strict";

  const API_PATH = "/a/api/project/me";
  const API_QUERY = "sort=max_created_at_last_updated_clip&show_trashed=false&exclude_shared=false";
  const PAGE_SIZE = 20; // rows per page, as returned by the API
  const MAX_PAGES = 100; // safety net (2000 workspaces)
  const CONCURRENCY = 4;
  const REQUEST_TIMEOUT_MS = 15000;

  // --- title repair (library search + metadata rename) ---
  const SEARCH_PATH = "/a/api/search/";
  const SEARCH_PAGE_SIZE = 20; // the endpoint caps `size` at 20
  const MAX_SEARCH_PAGES = 100; // safety net (2000 matching clips)
  const CLIP_PATH = "/a/api/clip/";
  const RENAME_PATH = (id) => "/a/api/gen/" + encodeURIComponent(id) + "/set_metadata/";
  const SOURCE_CONCURRENCY = 4;
  const RENAME_DELAY_MS = 220;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function S() {
    return root.SunoGenSelectors || null;
  }

  function isVisible(el) {
    const s = S();
    if (s && s.isVisible) return s.isVisible(el);
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function sessionToken() {
    try {
      const m = (root.document.cookie || "").match(/(?:^|;\s*)__session=([^;]*)/);
      if (!m) return null;
      const token = decodeURIComponent(m[1]);
      return token && token.split(".").length === 3 ? token : null;
    } catch (err) {
      return null;
    }
  }

  /** Project row → catalogue entry (only the fields the importer understands). */
  function toEntry(w) {
    if (!w || !w.name) return null;
    const entry = {
      id: w.id ? String(w.id) : undefined,
      name: String(w.name).trim(),
      clipCount: Number(w.clip_count) || 0
    };
    if (w.created_at) entry.createdAt = String(w.created_at);
    if (w.last_updated_clip) entry.lastUpdatedAt = String(w.last_updated_clip);
    return entry;
  }

  function sortEntries(list) {
    return list.sort((a, b) =>
      String(b.lastUpdatedAt || "").localeCompare(String(a.lastUpdatedAt || ""))
    );
  }

  async function fetchPage(page) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    const headers = { Accept: "application/json" };
    const token = sessionToken();
    if (token) headers.Authorization = "Bearer " + token;
    try {
      const res = await fetch(API_PATH + "?" + API_QUERY + "&page=" + page, {
        headers: headers,
        credentials: "same-origin",
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      return {
        total: Number(json && json.num_total_results) || 0,
        projects: json && Array.isArray(json.projects) ? json.projects : []
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Page through Suno's project list. Page 1 tells us the total, so the rest can
   * be fetched a few at a time.
   */
  async function collectFromApi(onProgress) {
    const byId = new Map();
    const addAll = (list) => {
      for (const w of list) {
        if (!w || !w.id || byId.has(w.id) || !w.name) continue;
        byId.set(w.id, w);
      }
    };

    const first = await fetchPage(1);
    addAll(first.projects);
    const total = first.total || byId.size;
    // Trust the API's own page size rather than assuming PAGE_SIZE forever.
    const pageSize = first.projects.length || PAGE_SIZE;
    const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / pageSize)));
    if (onProgress) onProgress({ source: "api", done: byId.size, total: total, page: 1, pages: pageCount });

    let next = 2;
    while (next <= pageCount) {
      const batch = [];
      while (batch.length < CONCURRENCY && next <= pageCount) batch.push(next++);
      const results = await Promise.all(
        batch.map((p) =>
          fetchPage(p).catch((err) => ({ error: err, projects: [], total: total }))
        )
      );
      let progressed = false;
      for (const r of results) {
        const before = byId.size;
        addAll(r.projects || []);
        if (byId.size > before) progressed = true;
      }
      if (onProgress) {
        onProgress({ source: "api", done: byId.size, total: total, page: batch[batch.length - 1], pages: pageCount });
      }
      // Every page in the batch failed or repeated rows: stop rather than spin.
      if (!progressed) break;
      await sleep(60);
    }

    return {
      workspaces: sortEntries([...byId.values()].map(toEntry).filter(Boolean)),
      total: total
    };
  }

  // --- DOM fallback: read the "Save to..." picker, scrolling it to load more ---

  function pickerDialog() {
    const s = S();
    const input = s && s.find ? s.find("workspaceSearchInput") : null;
    if (input && isVisible(input)) {
      let node = input;
      while (node && node !== root.document.body) {
        if (node.getAttribute && node.getAttribute("role") === "dialog") return node;
        node = node.parentElement;
      }
      return input.closest("[role='dialog']") || input.parentElement;
    }
    const dialogs = [...root.document.querySelectorAll("[role='dialog']")];
    return dialogs.find((d) => isVisible(d) && d.querySelector("input")) || null;
  }

  function listContainer(dialog) {
    const scroller = [...dialog.querySelectorAll("*")].find((el) => {
      const cs = root.getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4;
    });
    return scroller || dialog;
  }

  /** Parse one list row: `<name> (N clips)` or `<name>` + `N songs · ...`. */
  function parseEntry(el) {
    if (!el) return null;
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 160) return null;
    const legacy = text.match(/^(.+?)\s*\((\d+)\s+clips?\)$/i);
    if (legacy) return { name: legacy[1].trim(), clipCount: Number(legacy[2]) };
    const modern = text.match(/^(.+?)\s+(\d+)\s+songs?\s*·/i);
    if (modern) return { name: modern[1].trim(), clipCount: Number(modern[2]) };
    return null;
  }

  async function collectFromDom(onProgress) {
    const s = S();
    if (!s) throw new Error("Selector helpers are not loaded.");

    let openedPicker = false;
    let dialog = pickerDialog();
    if (!dialog) {
      const trigger = s.findWorkspaceTrigger();
      if (!trigger) {
        throw new Error(
          "No workspace picker on this page — open a Suno page with the create form and try again."
        );
      }
      s.clickEl(trigger);
      openedPicker = true;
      for (let i = 0; i < 30 && !dialog; i++) {
        await sleep(200);
        dialog = pickerDialog();
      }
    }
    if (!dialog) throw new Error("Workspace picker did not open.");

    // A leftover search filter would hide entries.
    const input = s.find("workspaceSearchInput");
    if (input && isVisible(input) && input.value) {
      s.setNativeValue(input, "");
      await sleep(300);
    }

    const container = listContainer(dialog);
    const seen = new Map();
    const read = () => {
      for (const child of container.children) {
        const entry = parseEntry(child);
        if (!entry || !entry.name) continue;
        seen.set(entry.name.toLowerCase(), entry);
      }
      if (onProgress) onProgress({ source: "dom", done: seen.size });
    };

    container.scrollTop = 0;
    await sleep(150);
    read();

    let stalls = 0;
    for (let round = 0; round < 80 && stalls < 2; round++) {
      const before = seen.size;
      container.scrollTop = container.scrollHeight;
      let grew = false;
      for (let i = 0; i < 10; i++) {
        await sleep(150);
        read();
        if (seen.size > before) {
          grew = true;
          break;
        }
      }
      if (!grew) {
        stalls++;
        // Nudge off the bottom: Suno's list only fetches when it's re-entered.
        container.scrollTop = Math.max(0, container.scrollTop - container.clientHeight);
        await sleep(200);
        read();
        if (seen.size > before) stalls = 0;
      } else {
        stalls = 0;
      }
    }

    if (openedPicker) {
      try {
        const active = root.document.activeElement || root.document.body;
        active.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
        await sleep(200); // let the popover's exit animation finish
      } catch (err) {
        /* ignore */
      }
    }

    return {
      workspaces: sortEntries([...seen.values()]),
      total: seen.size,
      openedPicker: openedPicker
    };
  }

  /**
   * Full workspace list, API first, picker DOM as a fallback.
   * Resolves `{ workspaces, source, total, openedPicker?, warning? }`.
   */
  async function collectWorkspaces(options) {
    const onProgress = options && options.onProgress;
    let apiError = null;
    try {
      const res = await collectFromApi(onProgress);
      if (res.workspaces.length) {
        return { workspaces: res.workspaces, total: res.total, source: "api" };
      }
      apiError = new Error("empty workspace list");
    } catch (err) {
      apiError = err;
    }

    const dom = await collectFromDom(onProgress);
    return {
      workspaces: dom.workspaces,
      total: dom.total,
      source: "dom",
      openedPicker: dom.openedPicker,
      warning:
        "Suno's workspace API was unavailable (" +
        String((apiError && apiError.message) || apiError) +
        "); read the picker instead, which may be incomplete."
    };
  }

  // --- title repair ---------------------------------------------------------
  //
  // The user's `mangled` marker sometimes leaked into generated titles. Suno's
  // cover clips keep `metadata.cover_clip_id` pointing at the source upload, so
  // we can map a bad title back to its source and rebuild a correct one.

  function jsonHeaders() {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const token = sessionToken();
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  async function fetchJson(path, options) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetch(
        path,
        Object.assign(
          {
            credentials: "same-origin",
            headers: jsonHeaders(),
            signal: controller ? controller.signal : undefined
          },
          options || {}
        )
      );
      let body = null;
      try {
        body = await res.json();
      } catch (err) {
        body = null;
      }
      if (!res.ok) {
        const detail =
          body && body.detail ? ": " + JSON.stringify(body.detail).slice(0, 300) : "";
        throw new Error("HTTP " + res.status + detail);
      }
      return body;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One page of Suno's library search (it caps size at 20). */
  async function fetchSearchPage(term, fromIndex) {
    const json = await fetchJson(SEARCH_PATH, {
      method: "POST",
      body: JSON.stringify({
        search_queries: [
          {
            name: "library_song",
            search_type: "library_song",
            term: term,
            from_index: fromIndex,
            size: SEARCH_PAGE_SIZE,
            rank_by: "most_recent"
          }
        ]
      })
    });
    const page = json && json.result && json.result.library_song;
    return {
      hits: page && Array.isArray(page.result) ? page.result : [],
      total: Number(page && page.total_hits) || 0
    };
  }

  /** Every library clip whose title (or metadata) matches `term`. */
  async function searchLibrarySongs(term, onProgress) {
    const q = String(term || "").trim();
    if (!q) throw new Error("Enter a search term (e.g. mangled).");
    const byId = new Map();
    let total = 0;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const from = page * SEARCH_PAGE_SIZE;
      const res = await fetchSearchPage(q, from);
      total = res.total || total;
      for (const clip of res.hits) {
        if (clip && clip.id && !byId.has(clip.id)) byId.set(clip.id, clip);
      }
      if (onProgress) onProgress({ done: byId.size, total: total || byId.size, page: page + 1 });
      if (res.hits.length < SEARCH_PAGE_SIZE) break;
      if (total && from + res.hits.length >= total) break;
      await sleep(80);
    }
    return { clips: [...byId.values()], total: total || byId.size };
  }

  async function fetchClip(id) {
    return fetchJson(CLIP_PATH + encodeURIComponent(id), { method: "GET" });
  }

  /**
   * Candidate rows for the repair tool: generated cover clips (not uploads) with
   * a song-name separator, plus the title of the clip they cover.
   */
  async function collectTitleRepairs(term, onProgress) {
    const search = await searchLibrarySongs(term, (p) => {
      if (onProgress) onProgress({ phase: "search", done: p.done, total: p.total });
    });

    const candidates = search.clips.filter((clip) => {
      const meta = clip && clip.metadata && typeof clip.metadata === "object" ? clip.metadata : {};
      if (meta.type === "upload" || meta.type === "upsample") return false;
      return String((clip && clip.title) || "").indexOf(" - ") !== -1;
    });

    // Search results normally carry metadata.cover_clip_id; fetch the clip once
    // for the rare row where they do not.
    const metaById = new Map();
    for (const clip of candidates) metaById.set(clip.id, clip.metadata || {});
    for (const clip of candidates) {
      const meta = metaById.get(clip.id) || {};
      if (meta.cover_clip_id || meta.edited_clip_id) continue;
      try {
        const full = await fetchClip(clip.id);
        metaById.set(clip.id, (full && full.metadata) || {});
      } catch (err) {
        /* leave it unresolved; the panel will offer manual editing */
      }
    }

    const sourceIds = [
      ...new Set(
        candidates
          .map((c) => metaById.get(c.id))
          .map((m) => m && (m.cover_clip_id || m.edited_clip_id))
          .filter(Boolean)
      )
    ];

    const sourceTitles = new Map();
    let done = 0;
    const queue = sourceIds.slice();
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const full = await fetchClip(id);
          sourceTitles.set(id, String((full && full.title) || ""));
        } catch (err) {
          sourceTitles.set(id, null);
        }
        done++;
        if (onProgress) onProgress({ phase: "sources", done: done, total: sourceIds.length });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SOURCE_CONCURRENCY, queue.length) }, worker)
    );

    const rows = candidates.map((clip) => {
      const meta = metaById.get(clip.id) || {};
      const sourceId = meta.cover_clip_id || meta.edited_clip_id || null;
      return {
        id: clip.id,
        title: String(clip.title || ""),
        sourceId: sourceId,
        sourceTitle: sourceId ? sourceTitles.get(sourceId) || "" : ""
      };
    });

    return { rows: rows, scanned: search.clips.length, totalHits: search.total };
  }

  /** Rename one clip. Retries throttling / transient server errors. */
  async function renameClip(id, title) {
    const clean = String(title || "").trim();
    if (!id || !clean) throw new Error("Missing clip id or title.");
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const json = await fetchJson(RENAME_PATH(id), {
          method: "POST",
          body: JSON.stringify({ title: clean })
        });
        if (json && json.error_type) {
          throw new Error("Suno rejected the title: " + json.error_type);
        }
        return json;
      } catch (err) {
        lastError = err;
        const msg = String((err && err.message) || err);
        if (!/HTTP (429|5\d\d)/.test(msg) || attempt === 2) break;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastError || new Error("Rename failed.");
  }

  /** Rename a list of `{ id, title }`, reporting progress as it goes. */
  async function renameClips(items, onProgress, shouldStop) {
    const list = Array.isArray(items) ? items : [];
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      if (shouldStop && shouldStop()) {
        results.push({ id: item.id, title: item.title, ok: false, error: "cancelled" });
        continue;
      }
      try {
        await renameClip(item.id, item.title);
        results.push({ id: item.id, title: item.title, ok: true });
      } catch (err) {
        results.push({
          id: item.id,
          title: item.title,
          ok: false,
          error: String((err && err.message) || err)
        });
      }
      if (onProgress) {
        onProgress({
          done: i + 1,
          total: list.length,
          result: results[results.length - 1]
        });
      }
      if (i < list.length - 1) await sleep(RENAME_DELAY_MS);
    }
    return {
      results: results,
      renamed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length
    };
  }

  root.SunoGenCatalog = {
    collectWorkspaces: collectWorkspaces,
    searchLibrarySongs: searchLibrarySongs,
    collectTitleRepairs: collectTitleRepairs,
    renameClip: renameClip,
    renameClips: renameClips,
    internals: {
      collectFromApi: collectFromApi,
      collectFromDom: collectFromDom,
      parseEntry: parseEntry,
      pickerDialog: pickerDialog,
      listContainer: listContainer,
      sessionToken: sessionToken,
      fetchJson: fetchJson,
      fetchSearchPage: fetchSearchPage,
      fetchClip: fetchClip
    }
  };
})(globalThis);
