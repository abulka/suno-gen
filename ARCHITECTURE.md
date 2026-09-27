# ARCHITECTURE.md — SunoGen

Design, data flow, and the hard-won Suno DOM facts. Pair with `AGENTS.md`.

## Goal & workflow

Given a **source song** and a set of **style presets**, produce one Suno **Cover
Song** per preset, titled by convention and saved to a target workspace.

```
Pick source (clip row) ─┐
Song idea: name/date/take/rating/workspace ─┤
Style presets (code + style prompt + overrides) ─┤
                                                  ▼
        [ Batch engine ]  for each preset:
          ensure cover context → Advanced mode
          → style → title → lyrics([instrumental])
          → model (best-effort) → workspace (verified)
          → Create song
        → monitor all job titles to completion
```

## Components

```
┌────────────────────────────┐        chrome.runtime messaging
│ Side panel (extension page)│◀───────────────────────────────┐
│  batch fields, presets,     │                                │
│  preview, Tools, log        │── chrome.tabs.sendMessage ──▶  │
└────────────────────────────┘                                │
                          chrome.storage.local: presets/settings/lastBatch
                                                               │
┌────────────────────────────┐                                 │
│ Content script (ISOLATED)  │◀────────────────────────────────┘
│  content.js: message router, pick-source, recorder
│  selectors.js: selector map + resilient lookups
│  cover-flow.js: runBatch + all DOM steps
│  title.js: naming/workspace builders
└─────────────▲──────────────┘
              │ window.postMessage({source:"sunogen-page"})
┌─────────────┴──────────────┐
│ Page hook (MAIN world)     │  hooks fetch/XHR, extracts clip id/title/status
│  page-hook.js              │  (deduped, id-required, skips pre-completed)
└────────────────────────────┘
```

Files: `src/panel/*`, `src/content/*`, `src/inject/page-hook.js`,
`src/shared/title.js`, `src/background/service-worker.js`.

## Data model (`chrome.storage.local`)

```js
settings = { defaultModel, delayMs, maxConcurrent, rating, autoDeriveWorkspace }
preset   = { id, name, styleCode, stylePrompt, model, lyrics, workspaceOverride, selected }
lastBatch= { batch: { songName, date, take, rating, workspace, autoWorkspace },
             source: { clipId, title, url, status } }
job      = { presetId, presetName, styleCode, title, workspace, workspaceIsOverride }
```

`date` = `YY-M`, `take` = 2-digit, `rating` default `iiiN`, `styleCode` = no
spaces ≤ 8 chars.

## Message protocol

Panel → content (`chrome.tabs.sendMessage`, auto-injects + retries on failure):

| type | purpose |
|------|---------|
| `SUNOGEN_PING` | liveness / page info |
| `SUNOGEN_START_PICK` / `SUNOGEN_CANCEL_PICK` | arm click-to-pick source |
| `SUNOGEN_DIAGNOSE` | selector report + fingerprint |
| `SUNOGEN_RECORD_START` / `SUNOGEN_RECORD_STOP` | click/hover recorder |
| `SUNOGEN_PREVIEW` | build jobs without DOM |
| `SUNOGEN_RUN_BATCH` | run the batch (`config`, incl. `dryRun`) |

Content → panel (`chrome.runtime.sendMessage`, always `{type:"SUNOGEN_EVENT",
event, ...}`): `pick-armed`, `pick-cancelled`, `pick-miss`, `source-picked`,
`record-started`, `job-preview`, `job-start`, `job-submitted`, `job-error`,
`monitor-start`, `job-status`, `batch-complete`, `page` (page-hook payload).

page-hook → content: `window.postMessage({source:"sunogen-page", payload})` where
payload is `{event:"hook-ready"}` or `{url, clips:[{id,title,status}], at}`.

## Selector strategy

All Suno selectors live in `src/content/selectors.js` as **ordered candidate
arrays**; the first match wins. Candidate forms: CSS string, `{text}`,
`{textMatch:/re/}`, `{aria}`, `{placeholder}`, `{testid}`, `{role,name}`,
`{attr:{...}}`. Text matches prefer the smallest matching element.

Helpers: `find`, `findIn(root,key)`, `findAll`, `findClipRow(title)`,
`findWorkspaceTrigger()`, `findWorkspaceOption(name)`, `isVisible`, `waitFor`,
`waitForKey`, `setNativeValue` (React-safe), `clickEl`, `hoverEl`,
`describeElement`, `fingerprint`, `probe`.

Keep structural workarounds (e.g. locating the "Save to..." button) as dedicated
functions in `selectors.js` rather than fragile CSS.

## Title / workspace logic (`src/shared/title.js`)

- `buildTitle({date,take,rating,styleCode,songName})`
  → `"26-9 01-iiiN qhvy - happy song"`.
- `buildWorkspace({date,songName})` → `"26-9 happy song"`.
- `resolveWorkspace(batch, preset)`: **preset override → `batch.workspace` →
  derived**. (Regression: an earlier version skipped `batch.workspace` and always
  derived from date+name — keep this order.)

`title.js` is a classic script attaching `globalThis.SunoGenTitle`, loaded before
`cover-flow.js` in both the content script list and `panel.html`.

## Cover flow sequence (`cover-flow.js`)

Per job (`runBatch` → `ensureCoverContext` → fill → create):

1. `ensureSourceRow(title)` — find `.clip-row[aria-label=title]`; if absent,
   SPA-click the Library tab and use the clip search (`[aria-label="Search clips"]`).
2. Click the row's `[aria-label="More options"]`.
3. `revealCoverMenuItem()` — hover/click each `button[data-context-menu-trigger]`
   in the open portal until `button[aria-label="Cover"]` appears (currently `Remix`).
4. Click Cover; click `Keep Current` if the confirm dialog appears.
5. `ensureAdvancedMode()` (click the `Advanced` tab if needed).
6. `waitForCoverData()` — wait until style/title are populated (Suno fills from
   the source asynchronously; writing too early gets overwritten).
7. `selectModel` (best-effort), `fillStyle`, `fillTitle`, `fillLyrics`
   (`[instrumental]` via Lexical insertText + retry), `selectWorkspace`.
8. `selectWorkspace(name)` — open picker, type name, click `"<name> (N clips)"`
   or `[aria-label="Create new workspace"]`, then **verify the pill text**;
   throw (stop before spending credits) if it didn't change.
9. `clickCreate()` → `button[aria-label="Create song"]`.
10. After all jobs, `monitorJobs()` polls `.clip-row[data-clip-status]` for the job
    titles and emits `queued → streaming → complete`.

## Confirmed Suno DOM reference (Sep 2026)

| Thing | Selector / fact |
|-------|-----------------|
| Create mode tabs | `button[aria-label="Simple"|"Advanced"|"Sounds"]` |
| Model button | `button` with text `/^v\d/` (menu unmapped — best-effort) |
| Style prompt | `[data-testid="create-form-styles-wrapper"] textarea` (maxlength 1000) |
| Song title | `input[placeholder="Song Title (Optional)"]` |
| Lyrics editor | `div[contenteditable="true"][aria-label="Lyrics editor"]` (Lexical) |
| Create button | `button[aria-label="Create song"]` |
| Workspace trigger | `button` inside the row whose text is exactly `Save to...` |
| Workspace picker | `input[placeholder="Search or create..."]` |
| Create workspace | `button[aria-label="Create new workspace"]` |
| Workspace option | `button` text `"<name> (N clips)"` |
| Clip row | `div.clip-row[role="group"][aria-label="<title>"][data-clip-status]` |
| Row menu | `button[aria-label="More options"]` |
| Context menu portal | `div[data-context-menu="true"]` |
| Submenu trigger | `button[data-context-menu-trigger="true"]` (e.g. Remix) |
| Cover item | `button[aria-label="Cover"]` |
| Confirm dialog | button text `Keep Current` |
| Clip search | `input[aria-label="Search clips"]` |

**Injected by another extension (do not use):** `data-sm-*`, `data-tree-*`,
`data-testid="clip-row"`, buttons titled "Download MP3 via Suno (S)", etc.
(Suno Manager V3.)

## Debugging & testing techniques (why the harness is built this way)

- **Playwright over CDP with a persistent profile.** `npm run chrome` launches
  Chrome with `--remote-debugging-port=9222 --user-data-dir=tools/.chrome-profile`
  (Chrome 136+ refuses remote debugging on the default profile). The user logs in
  manually; the session persists. `connectOverCDP` attaches without a new profile.
- **Inject the shipping code to test it live.** `page.addScriptTag` loads
  `title.js`/`selectors.js`/`cover-flow.js` into the page (main world), then calls
  `SunoGenCoverFlow._internals.*`. This tests the exact modules the extension runs,
  without installing the extension. `_internals` is a deliberate test seam.
- **Avoid spending credits while iterating.** Fill and inspect the form, screenshot
  it, and only call `clickCreate` behind an explicit `--submit`/`--batch` flag.
- **Recorder for unknown menus.** Content-side capture-phase click/hover listeners
  write descriptors to `sessionStorage` (survives SPA navigation), read back via
  `Copy diagnostics`.
- **Diagnose must not read stale code.** The panel injects the latest content
  scripts, then reads `SunoGenSelectors` via `chrome.scripting.executeScript`
  directly — bypassing `onMessage` handlers that an older injected copy may still
  own. `content.js` also replaces its previous handler (`__sunogenHandler`) on
  re-injection.
- **React controlled inputs** need the native value setter + `input`/`change`
  events (`setNativeValue`), not `el.value = x`.
- **Lexical contenteditable** (lyrics) is driven by focusing, selecting all, and
  `document.execCommand("insertText", ...)`, with a `beforeinput` fallback.

## Risks & mitigations

- DOM/UI changes → centralized selector map + `Diagnose`; patch one file.
- Wrong workspace (covers inherit the source's) → explicit selection + pill
  verification + hard stop.
- Credits/rate limits → conservative defaults, `dryRun`, delays, verified
  workspace before Create.
- ToS/anti-automation → UI-level, human-paced, personal use only.

## Repo layout

```
manifest.json   src/{background,panel,content,inject,shared}   tools/   AGENTS.md   ARCHITECTURE.md
```
