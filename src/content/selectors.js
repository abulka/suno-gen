/**
 * SunoGen DOM selector map + resilient lookup helpers.
 *
 * All Suno-specific selectors live here so UI changes are patched in one place.
 * Selector entries are ordered arrays of candidates; first match wins.
 * Candidate forms:
 *   - "css selector"
 *   - { text: "Create" }                       exact trimmed text (loose fallback)
 *   - { textMatch: /^v\d/ }                    regex against trimmed text
 *   - { aria: "More options" }                 aria-label exact/contains
 *   - { placeholder: "Search" }
 *   - { testid: "clip-row" }
 *   - { role: "button", name: "Create" }
 *   - { attr: { "data-testid": "x" } }         attribute match(es)
 * Any object candidate may also carry `attr: {...}` filters or `scope: "css"`.
 *
 * Confirmed against live suno.com, Sep 2026.
 */
(function (root) {
  "use strict";

  const CLICKABLE_SCOPE = "button,[role='button'],[role='menuitem'],[role='option'],a";
  const TEXT_SCOPE = CLICKABLE_SCOPE + ",div,span,li";

  const SELECTORS = {
    createPageRoot: ["main", "[data-testid='create-page']", "body"],

    // --- mode tabs on the create panel ---
    simpleTab: [{ aria: "Simple" }],
    advancedTab: [{ aria: "Advanced" }],
    soundsTab: [{ aria: "Sounds" }],

    // --- top toolbar ---
    addAudioButton: [{ aria: "Add audio - Browse, upload, or record audio" }, { aria: "Add audio" }],
    addVoiceButton: [{ aria: "Add Voice" }],
    addImageButton: [{ aria: "Add an image to your creation." }],
    addInspoButton: [{ aria: "Add inspiration from a playlist" }],

    // --- Advanced create form ---
    styleInput: [
      "[data-testid='create-form-styles-wrapper'] textarea",
      { placeholder: "german rap, latin percussion, surdo, powerful vocal, punk" },
      "textarea[placeholder*='style' i]"
    ],
    titleInput: [
      { placeholder: "Song Title (Optional)" },
      "input[placeholder*='Song Title' i]",
      "input[placeholder*='title' i]"
    ],
    lyricsToggle: [{ aria: "Lyrics" }, { text: "Lyrics" }],
    lyricsEditor: [
      { aria: "Lyrics editor" },
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']"
    ],
    createButton: [
      { aria: "Create song" },
      "button[aria-label='Create song']",
      { role: "button", name: "Create song" },
      { text: "Create" }
    ],

    // --- workspace "Save to..." picker ---
    workspaceSearchInput: [
      { placeholder: "Search or create..." },
      "input[placeholder*='workspace' i]"
    ],
    createWorkspaceButton: [{ aria: "Create new workspace" }],

    // --- library clip rows (native class; data-testid variant is injected by
    // another extension, kept only as a fallback) ---
    clipRow: ["div.clip-row[role='group']", ".clip-row", "[data-testid='clip-row']"],
    moreOptionsButton: [{ aria: "More options" }],
    clipSearchInput: [{ aria: "Search clips" }, { placeholder: "Search" }],
    libraryTab: [
      "a[data-testid='navbar-library-tab']",
      "a[href='/me']"
    ],

    // --- clip context menu (portals, appear on demand) ---
    // Scope these to the menu portal: the create panel also renders buttons
    // whose aria-label *contains* these words (e.g. "Change condition type
    // from Cover"), and a global match would click the wrong element.
    menuRoot: ["[data-context-menu='true']", "[role='menu']"],
    menuCover: [
      "[data-context-menu='true'] button[aria-label='Cover']",
      "[role='menu'] button[aria-label='Cover']"
    ],
    menuReusePrompt: [
      "[data-context-menu='true'] button[aria-label='Reuse Prompt']",
      "[role='menu'] button[aria-label='Reuse Prompt']"
    ],
    menuMashup: [
      "[data-context-menu='true'] button[aria-label='Mashup']",
      "[role='menu'] button[aria-label='Mashup']"
    ],
    menuSample: [
      "[data-context-menu='true'] button[aria-label='Sample this song']",
      "[role='menu'] button[aria-label='Sample this song']"
    ],
    menuInspiration: [
      "[data-context-menu='true'] button[aria-label='Use as Inspiration']",
      "[role='menu'] button[aria-label='Use as Inspiration']"
    ],

    processingMarker: [{ text: "Processing" }, { text: "Generating" }]
  };

  function matchesAttr(el, attrs) {
    for (const k of Object.keys(attrs)) {
      const want = attrs[k];
      const have = el.getAttribute(k);
      if (want === true) {
        if (have === null) return false;
      } else if (have !== want) {
        return false;
      }
    }
    return true;
  }

  function byText(text) {
    const wanted = String(text).trim().toLowerCase();
    const nodes = document.querySelectorAll(TEXT_SCOPE);
    for (const node of nodes) {
      const t = (node.textContent || "").trim().toLowerCase();
      if (t && t === wanted) return node;
    }
    for (const node of nodes) {
      const t = (node.textContent || "").trim().toLowerCase();
      if (t && t.includes(wanted)) return node;
    }
    return null;
  }

  function byTextMatch(re, scope) {
    const nodes = document.querySelectorAll(scope || CLICKABLE_SCOPE);
    let best = null;
    for (const node of nodes) {
      const t = (node.textContent || "").trim();
      if (!t || !re.test(t)) continue;
      if (!best || t.length < (best.textContent || "").trim().length) best = node;
    }
    return best;
  }

  function resolveOne(candidate) {
    if (!candidate) return null;
    if (typeof candidate === "string") return document.querySelector(candidate);

    if (candidate.textMatch) {
      const el = byTextMatch(candidate.textMatch, candidate.scope);
      if (el && (!candidate.attr || matchesAttr(el, candidate.attr))) return el;
      return null;
    }

    let el = null;
    if (candidate.text !== undefined) {
      el = byText(candidate.text);
    } else if (candidate.aria !== undefined) {
      el = document.querySelector(
        "[aria-label='" + candidate.aria + "'], [aria-label*='" + candidate.aria + "' i]"
      );
    } else if (candidate.placeholder !== undefined) {
      el = document.querySelector(
        "[placeholder='" + candidate.placeholder + "'], [placeholder*='" + candidate.placeholder + "' i]"
      );
    } else if (candidate.testid !== undefined) {
      el = document.querySelector("[data-testid='" + candidate.testid + "']");
    } else if (candidate.attr) {
      const parts = Object.keys(candidate.attr).map((k) => "[" + k + "]");
      el = document.querySelector(parts.join(""));
    } else if (candidate.role !== undefined) {
      const nodes = document.querySelectorAll("[role='" + candidate.role + "']");
      const name = (candidate.name || "").toLowerCase();
      for (const n of nodes) {
        const acc = (n.getAttribute("aria-label") || n.textContent || "").trim().toLowerCase();
        if (!name || acc === name || acc.includes(name)) {
          el = n;
          break;
        }
      }
    }

    if (el && candidate.attr && !matchesAttr(el, candidate.attr)) return null;
    return el;
  }

  function find(key) {
    const list = SELECTORS[key];
    if (!list) return null;
    for (const cand of list) {
      const el = resolveOne(cand);
      if (el) return el;
    }
    return null;
  }

  /** Find a known selector key inside a given root element. */
  function findIn(rootEl, key) {
    const list = SELECTORS[key];
    if (!rootEl || !list) return null;
    for (const cand of list) {
      if (typeof cand === "string") {
        const el = rootEl.querySelector(cand);
        if (el) return el;
      } else if (cand.aria !== undefined) {
        const el = rootEl.querySelector("[aria-label='" + cand.aria + "']");
        if (el) return el;
      } else if (cand.text !== undefined) {
        const nodes = rootEl.querySelectorAll(TEXT_SCOPE);
        for (const n of nodes) {
          if ((n.textContent || "").trim().toLowerCase() === String(cand.text).toLowerCase()) return n;
        }
      }
    }
    return null;
  }

  function findAll(key) {
    const list = SELECTORS[key];
    if (!list) return [];
    const out = new Set();
    for (const cand of list) {
      if (typeof cand === "string") {
        document.querySelectorAll(cand).forEach((n) => out.add(n));
      } else {
        const el = resolveOne(cand);
        if (el) out.add(el);
      }
    }
    return Array.from(out);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Find the clip row whose aria-label (title) matches, best-effort. */
  function findClipRow(title) {
    const rows = findAll("clipRow");
    if (!title) return rows[0] || null;
    const wanted = String(title).trim().toLowerCase();
    return (
      rows.find((r) => (r.getAttribute("aria-label") || "").trim().toLowerCase() === wanted) ||
      rows.find((r) => (r.getAttribute("aria-label") || "").toLowerCase().includes(wanted)) ||
      null
    );
  }

  /**
   * The "Save to... <workspace>" row in the create form; the clickable is the
   * workspace pill button next to the "Save to..." label.
   */
  function findWorkspaceTrigger() {
    const labels = Array.from(document.querySelectorAll("span,div")).filter(
      (el) => (el.textContent || "").trim() === "Save to..."
    );
    for (const label of labels) {
      let node = label.parentElement;
      for (let i = 0; i < 3 && node; i++) {
        const btn = node.querySelector("button");
        if (btn && isVisible(btn)) return btn;
        node = node.parentElement;
      }
    }
    return null;
  }

  /** Workspace list entries render as "<name> (N clips)". */
  function findWorkspaceOption(name) {
    const wanted = String(name).trim().toLowerCase();
    for (const btn of document.querySelectorAll("button")) {
      if (!isVisible(btn)) continue;
      const t = (btn.textContent || "").trim().toLowerCase();
      if (t.startsWith(wanted + " (") || t === wanted) return btn;
    }
    return null;
  }

  /**
   * Find the "Cover" item inside a *visible* context-menu portal.
   *
   * Important: never resolve this with a document-global aria-label match. In
   * cover mode the create panel renders a button with aria-label
   * "Change condition type from Cover", which a global `[aria-label*='Cover' i]`
   * lookup matches first (the panel precedes the portal in DOM order) — clicking
   * it leaves the previously loaded audio in place.
   */
  function findMenuCover() {
    const menus = Array.from(
      document.querySelectorAll("[data-context-menu='true'], [role='menu']")
    ).filter(isVisible);
    for (const rootEl of menus) {
      const exact = rootEl.querySelector("button[aria-label='Cover']");
      if (exact && isVisible(exact)) return exact;
      for (const n of rootEl.querySelectorAll("button,[role='menuitem']")) {
        if (!isVisible(n)) continue;
        const aria = (n.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = (n.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (aria === "cover" || text === "cover") return n;
      }
    }
    return null;
  }

  /**
   * Text of the create panel's loaded-source chip. Suno renders it as
   * "Audio<ConditionType>" immediately followed by the source title, e.g.
   * "AudioCover26-9 06-iiiN artjam - truKKKK00:00/04:47". Returns null when the
   * panel isn't in a cover/audio state (so callers can skip verification).
   */
  function loadedCoverText() {
    for (const el of document.querySelectorAll("div,span")) {
      if (el.children.length > 4) continue;
      const t = (el.textContent || "").trim();
      if (/^Audio\s*Cover/i.test(t) && isVisible(el)) return t;
    }
    return null;
  }

  function waitFor(getter, opts) {
    const options = opts || {};
    const timeout = options.timeout || 15000;
    const interval = options.interval || 150;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      (function poll() {
        let el = null;
        try {
          el = typeof getter === "function" ? getter() : getter;
        } catch (err) {
          el = null;
        }
        if (el) return resolve(el);
        if (Date.now() - started > timeout) {
          return reject(new Error("waitFor timed out after " + timeout + "ms"));
        }
        setTimeout(poll, interval);
      })();
    });
  }

  function waitForKey(key, opts) {
    return waitFor(() => find(key), opts);
  }

  function setNativeValue(el, value) {
    if (!el) throw new Error("setNativeValue: element is null");
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickEl(el) {
    if (!el) throw new Error("clickEl: element is null");
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  function hoverEl(el) {
    if (!el) throw new Error("hoverEl: element is null");
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + node.id;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function describeElement(el) {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === "style" || a.name === "class") continue;
      const v = a.value.length > 100 ? a.value.slice(0, 100) + "…" : a.value;
      attrs[a.name] = v;
    }
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text: (el.textContent || "").trim().slice(0, 70),
      attrs: attrs,
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      path: cssPath(el)
    };
  }

  function fingerprint() {
    const sel =
      "input, textarea, select, button, [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='menu'], [contenteditable='true'], [data-testid]";
    const nodes = Array.from(document.querySelectorAll(sel));
    const seen = new Set();
    const out = [];
    for (const el of nodes) {
      if (el.type === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const d = describeElement(el);
      const key = d.tag + "|" + JSON.stringify(d.attrs) + "|" + d.text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
      if (out.length >= 250) break;
    }
    return {
      url: location.href,
      capturedAt: new Date().toISOString(),
      count: out.length,
      elements: out
    };
  }

  function describe(keys) {
    const wanted = keys || Object.keys(SELECTORS);
    const report = {};
    for (const key of wanted) {
      const el = find(key);
      report[key] = {
        found: !!el,
        tag: el ? el.tagName.toLowerCase() : null,
        text: el ? (el.textContent || "").trim().slice(0, 80) : null
      };
    }
    return report;
  }

  /** Detail for a one-off query (used by the probe command). */
  function probe(query) {
    if (!query) return null;
    let el = null;
    try {
      el = document.querySelector(query);
    } catch (err) {
      el = null;
    }
    if (!el) el = byText(query);
    return el ? describeElement(el) : null;
  }

  root.SunoGenSelectors = {
    SELECTORS: SELECTORS,
    find: find,
    findIn: findIn,
    findAll: findAll,
    findClipRow: findClipRow,
    findWorkspaceTrigger: findWorkspaceTrigger,
    findWorkspaceOption: findWorkspaceOption,
    findMenuCover: findMenuCover,
    loadedCoverText: loadedCoverText,
    isVisible: isVisible,
    waitFor: waitFor,
    waitForKey: waitForKey,
    setNativeValue: setNativeValue,
    clickEl: clickEl,
    hoverEl: hoverEl,
    describe: describe,
    describeElement: describeElement,
    cssPath: cssPath,
    fingerprint: fingerprint,
    probe: probe
  };
})(globalThis);
