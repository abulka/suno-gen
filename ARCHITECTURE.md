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
          ensure cover context (source verified) → Advanced mode
          → style → title → lyrics([instrumental])
          → workspace (verified)
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
│  row-indicators.js: per-row unlock + download badges
│  title.js: naming/workspace builders
└─────────────▲──────────────┘
              │ window.postMessage({source:"sunogen-page"})
┌─────────────┴──────────────┐
│ Page hook (MAIN world)     │  hooks fetch/XHR + Response.json/text;
│  page-hook.js              │  status (deduped, skips pre-completed) and
│                            │  is_download_unlocked
└────────────────────────────┘
```

Files: `src/panel/*`, `src/content/*`, `src/inject/page-hook.js`,
`src/shared/title.js`, `src/background/service-worker.js`.

## Data model (`chrome.storage.local`)

```js
settings = { delayMs, maxConcurrent, rating, autoDeriveWorkspace,
             showUnlockBadge, showDiskBadge, showHistoryBadge }
preset   = { id, name, styleCode, stylePrompt, lyrics, workspaceOverride, selected }
source   = { clipId, title, url, status, songName }
lastBatch= { batch: { songName, date, take, rating, workspace, autoWorkspace, globalTake },
             sources: [source] }
job      = { presetId, presetName, styleCode, source, sourceIndex, songName,
             title, workspace, workspaceIsOverride }
downloadedClips = { <clipId>: { history?: {at, filename}, disk?: {at, path, count} } }
clipTitles      = { <clipId>: <title> }  // feeds filename-based download matching
```

The folder-scan cache lives in IndexedDB (`sunogen-fs`/`scanIndex`,
`{ rootName, files: { <relPath>: {size, mtime, id} } }`) so unchanged files are
skipped on rescans; reconnecting to the same `rootName` keeps it, a different
folder clears it, and a "Rebuild index" action clears it on demand. The granted
`FileSystemDirectoryHandle` is stored in the same DB.

`date` = `YY-M`, `take` = 2-digit, `rating` default `iiiN`, `styleCode` = no
spaces ≤ 8 chars.

## Message protocol

Panel → content (`chrome.tabs.sendMessage`, auto-injects + retries on failure):

| type | purpose |
|------|---------|
| `SUNOGEN_PING` | liveness / page info (incl. `pick: {active,multiple}`) |
| `SUNOGEN_START_PICK` (`{multiple}`) / `SUNOGEN_CANCEL_PICK` | arm click-to-pick; `multiple` stays armed until Esc |
| `SUNOGEN_DIAGNOSE` | selector report + fingerprint |
| `SUNOGEN_RECORD_START` / `SUNOGEN_RECORD_STOP` | click/hover recorder |
| `SUNOGEN_PREVIEW` | build jobs without DOM |
| `SUNOGEN_RUN_BATCH` | run the batch (`config`, incl. `dryRun`) |

Content → background: `SUNOGEN_CLIP_TITLES` (`{items:[{id,title}]}`) keeps the
service worker's title→id map current for filename-based download matching.

Content → panel (`chrome.runtime.sendMessage`, always `{type:"SUNOGEN_EVENT",
event, ...}`): `pick-armed`, `pick-cancelled`, `pick-miss`, `source-picked`,
`record-started`, `job-preview`, `job-start`, `job-submitted`, `job-error`,
`monitor-start`, `job-status`, `batch-complete`, `page` (page-hook payload).

page-hook → content: `window.postMessage({source:"sunogen-page", payload})` where
payload is:
- `{event:"hook-ready"}`
- `{url, clips:[{id,title,status}], at}` — generation status (feeds the monitor)
- `{event:"clip-meta", items:[{id,title,unlocked,known,hasStem,upload}], at}` —
  download metadata for every feed clip, deduped per id (`known` = Suno reported
  the flag, `upload` = `metadata.type === "upload"`)

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
  → `"26-9 01-iiiN qhvy - happy song"`. `take`/`rating` are optional: the
  `{take}-{rating}` segment collapses to whichever is present (`06`, `iiiN`) and
  vanishes when both are empty.
- `offsetTake(take, n)` — base + step (`06` + 2 → `08`); `""` when no take.
  `buildJobs` uses step **2 per style** (Suno always makes 2 clips per Create, so
  the 2nd is left for manual editing).
- `deriveSongName(title)` — from a picked clip's aria-label: drop `· <uuid>`,
  strip a leading `YYYY-MM-DD`/`YY-M` date, take the last ` - ` segment, else
  strip a leading `take-rating` token. `"2026-07-28 arlie · <uuid>"` → `"arlie"`.
- `uniqueSourceNames(sources)` — per-source name (`songName` override → derived),
  disambiguating duplicates with a 4-char clip-id suffix. Used by the panel list,
  the preview and `buildJobs` so all three agree.
- `buildWorkspace({date,songName})` → `"26-9 happy song"`.
- `resolveWorkspace(batch, preset)`: **preset override → `batch.workspace` →
  derived**. (Regression: an earlier version skipped `batch.workspace` and always
  derived from date+name — keep this order.)

`title.js` is a classic script attaching `globalThis.SunoGenTitle`, loaded before
`cover-flow.js` in both the content script list and `panel.html`.

## Cover flow sequence (`cover-flow.js`)

`buildJobs(config)` expands **sources × selected presets** into jobs. Each job
carries its own `source` and per-source `workspace` (auto → `{date} {song}` per
source; manual → one workspace for all). `take` steps by 2 per job; with
`globalTake` (default) it keeps counting across songs, otherwise it resets per
song.

Per job (`runBatch` → `ensureCoverContext(job.source)` → fill → create):

1. `ensureSourceRow(title)` — find `.clip-row[aria-label=title]`; if absent, SPA-click
   the Library tab, **wait for the `/me` route and the clip search to exist**
   (don't wait on `.clip-row` — create pages have rows too, so that resolves
   before navigation), then filter the clip search (full title, then prefixes).
2. Click the row's `[aria-label="More options"]`.
3. `revealCoverMenuItem()` — hover/click each `button[data-context-menu-trigger]`
   in the open portal until the Cover item appears (currently under `Remix`).
   The lookup is **scoped to a visible menu portal** (`S.findMenuCover()`): a
   global `[aria-label*="Cover" i]` query also matches the create panel's
   `"Change condition type from Cover"` button and would click the wrong thing.
4. Click Cover; click `Keep Current` if the confirm dialog appears (that dialog
   is about preserving lyrics/styles, not the audio — we overwrite lyrics with
   `[instrumental]` anyway).
5. `ensureAdvancedMode()` (click the `Advanced` tab if needed).
6. `waitForCoverData()` — wait until style/title are populated (Suno fills from
   the source asynchronously; writing too early gets overwritten).
7. `verifyLoadedSource(source)` — confirm the create panel's loaded-source chip
   (`AudioCover<title>…`) references the picked source. If it clearly doesn't,
   **throw before Create** so a cover can't be generated from stale audio. Skips
   silently when no chip is readable.
8. `fillStyle`, `fillTitle`, `fillLyrics` (`[instrumental]` via Lexical
   insertText + retry), `selectWorkspace`.
9. `selectWorkspace(name)` — open picker, type name, click `"<name> (N clips)"`
   or `[aria-label="Create new workspace"]`, then **verify the pill text**;
   throw (stop before spending credits) if it didn't change.
10. `clickCreate()` → `button[aria-label="Create song"]`.
11. After all jobs, `monitorJobs()` polls `.clip-row[data-clip-status]` for the job
    titles and emits `queued → streaming → complete`. The panel's `logStatus()`
    dedupes these against the MAIN-world network hook (same titles/statuses) and
    filters to the current batch, so each transition logs once.

## Confirmed Suno DOM reference (Sep 2026)

| Thing | Selector / fact |
|-------|-----------------|
| Create mode tabs | `button[aria-label="Simple"|"Advanced"|"Sounds"]` |
| Condition type | `button[aria-label="Change condition type from Cover"]` (create panel; NOT the menu item) |
| Loaded source chip | create panel text `AudioCover<title>…` (`S.loadedCoverText()`) |
| Style prompt | `[data-testid="create-form-styles-wrapper"] textarea` (maxlength 1000) |
| Song title | `input[placeholder="Song Title (Optional)"]` |
| Lyrics editor | `div[contenteditable="true"][aria-label="Lyrics editor"]` (Lexical) |
| Create button | `button[aria-label="Create song"]` |
| Workspace trigger | `button` inside the row whose text is exactly `Save to...` |
| Workspace picker | `input[placeholder="Search or create..."]` |
| Create workspace | `button[aria-label="Create new workspace"]` |
| Workspace option | `button` text `"<name> (N clips)"` |
| Clip row | `div.clip-row[role="group"][aria-label="<title>"][data-clip-status]` |
| Clip cover | `.clip-image-container` (download badge anchors to it) |
| Row menu | `button[aria-label="More options"]` |
| Context menu portal | `div[data-context-menu="true"]` |
| Submenu trigger | `button[data-context-menu-trigger="true"]` (e.g. Remix) |
| Cover item | `button[aria-label="Cover"]` |
| Confirm dialog | button text `Keep Current` |
| Clip search | `input[aria-label="Search clips"]` |

**Suno clip API fields** (from `/api/feed` responses, observed Sep 2026): every
clip carries `is_download_unlocked` (boolean) — the source of the badge's
`unlocked`/`locked` state. `metadata.has_stem` flags WAV availability. Suno's
signed audio-download URLs embed the clip UUID, which is how `chrome.downloads`
entries are mapped back to a clip. Downloaded files also embed the exact id:
M4A/MP3 comment `"made with suno; created=…; id=<uuid>"` and a C2PA
`com.suno.provenance` / `icontentIdx$<uuid>` block (read by
`src/shared/audio-meta.js`), so a granted-folder scan can recognise files even
after a rename. Streaming (`media_urls`) is client-side encrypted and not
readable.

**Injected by another extension (do not use):** `data-sm-*`, `data-tree-*`,
`data-testid="clip-row"`, buttons titled "Download MP3 via Suno (S)", etc.
(Suno Manager V3 — its green "Saved" chip comes from live `chrome.downloads`
tracking only; that's the behaviour `row-indicators.js` improves on.)

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
- Wrong audio (covers keep the previously loaded track if the Cover menu item
  didn't apply) → menu lookup scoped to the visible portal + loaded-source chip
  verification + hard stop before Create.
- Credits/rate limits → conservative defaults, `dryRun`, delays, verified
  workspace before Create.
- ToS/anti-automation → UI-level, human-paced, personal use only.

## Repo layout

```
manifest.json   src/{background,panel,content,inject,shared}   tools/   AGENTS.md   ARCHITECTURE.md
```
