# ARCHITECTURE.md — Suno Generator

> Product name: **Suno Generator**; `SunoGen` is the internal code namespace.

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
`FileSystemDirectoryHandle` is stored in the same DB. Scans also run
automatically on panel open and ~2.5 s after a download completes (the service
worker messages the panel), but only while the handle's read permission is still
`granted` — those paths have no user gesture, so a lapsed permission is skipped.

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
| `SUNOGEN_COLLECT_WORKSPACES` | full workspace list for the catalogue export (see below) |
| `SUNOGEN_COLLECT_SONGS` (`{expected}`) | every library clip + its workspace for the optional `suno-songs.json` |

Content → background: `SUNOGEN_CLIP_TITLES` (`{items:[{id,title}]}`) keeps the
service worker's title→id map current for filename-based download matching.

Content → panel (`chrome.runtime.sendMessage`, always `{type:"SUNOGEN_EVENT",
event, ...}`): `pick-armed`, `pick-cancelled`, `pick-miss`, `source-picked`,
`record-started`, `job-preview`, `job-start`, `job-submitted`, `job-error`,
`monitor-start`, `job-status`, `batch-complete`, `catalog-progress`, `page`
(page-hook payload).

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
  split on `" - "`, drop trailing processing/fragment markers (`mangled`,
  `mangled2`, `frag1`, `fragment1`, … plus an optional `-a1b2` dedupe suffix).
  If a marker was removed, keep the **whole remaining descriptive name**
  (`"multiple guitars - maton arrives - frag1"` → `"multiple guitars - maton
  arrives"`); otherwise take the last ` - ` segment (`"70s nu jam - truck"` →
  `"truck"`). Then strip leading `YYYY-MM-DD`/`YY-M` and date/take prefixes.
  `"2026-06-28 fine - mangled"` → `"fine"`; `"post a30p dedication 01 - frag1
  mangled"` → `"post a30p dedication 01"`.
- `isProcessingMarker`, `isFragmentMarker`, `stripProcessingMarker`,
  `stripFragmentMarker`, `stripTrailingMarker`, `hasTrailingMarker`,
  `repairSongName`, `splitTitle`, `joinTitle` — shared marker/repair helpers
  used by the panel's bulk title repair tool and load-time source migration.
- `uniqueSourceNames(sources)` — per-source name (`songName` override → derived),
  disambiguating duplicates with a 4-char clip-id suffix. Used by the panel list,
  the preview and `buildJobs` so all three agree.
- `buildWorkspace({date,songName})` → `"26-9 happy song"`.
- `resolveWorkspace(batch, preset)`: **preset override → `batch.workspace` →
  derived**. (Regression: an earlier version skipped `batch.workspace` and always
  derived from date+name — keep this order.)

`title.js` is a classic script attaching `globalThis.SunoGenTitle`, loaded before
`cover-flow.js` in both the content script list and `panel.html`.

## Title repair (`catalog.js` + panel Tools)

The repair tool is the only writer of clip titles. It uses the same
`__session` JWT as the catalogue export:

- `POST /a/api/search/` body
  `{search_queries:[{name:"library_song", search_type:"library_song", term,
  from_index, size:20, rank_by:"most_recent"}]}`. `size` caps at 20; page with
  `from_index` until `total_hits`. The repair input accepts comma-separated
  terms (default `mangled, frag`) and merges hits by clip id.
- `GET /a/api/clip/{id}` for a clip/source title (source of a cover).
- `POST /a/api/gen/{id}/set_metadata/` body `{title}`. Verified live: a partial
  payload changes only the title; lyrics, tags, cover image and display tags are
  preserved. Retries 429/5xx.
- `titleAliases` (`{ titleLower: clipId }`) is written before renames; the
  service worker and the panel folder scan merge it with `clipTitles` (current
  titles win) so old filenames / Chrome download history still resolve. Audio
  files embed the UUID, so a disk rescan is authoritative regardless.

The panel groups search rows by old title → new title, lets the user edit or
uncheck each group, and renames every clip id in the selected groups (Suno
generates two clips per Create, so most groups contain 2 ids).

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
11. After all jobs, `monitorJobs()` first polls the library feed
    (`/a/api/feed/v3`, paged by `catalog.js:recentClips`) so off-screen clips,
    error statuses and missing siblings are included. It expects **2 good clips
    per job** (4 for two jobs sharing a title), waits a short grace period, and
    reports `found/expected` plus any `metadata.error_type`/`error_message`.
    Short titles are **auto-retried once** (`selectRetryJobs`, override with
    `settings.autoRetryPasses`) by re-running the relevant jobs, then verified
    again. Falls back to polling visible `.clip-row[data-clip-status]` rows if
    the feed is unavailable. The panel's `logStatus()` dedupes transitions and
    ignores per-clip page-hook statuses while the feed monitor is active, so a
    sibling's `complete` cannot hide an errored clip.

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

## Workspace list for the catalogue export (`catalog.js`)

The "Export catalog JSON" tool needs *every* workspace, with ids. Two facts
decide the implementation:

1. **The picker cannot be trusted as a source of the full list.** It renders 20
   rows on open and appends the next 20 only when the list is scrolled to the
   bottom (the app fetches one page per arrival). Scraping its DOM therefore
   captures whatever the user/scroll loop happened to load — a 215-workspace
   account exported 100 rows this way. It is also slow (11 × scroll + wait).
2. **Suno calls workspaces "projects"** and lists them all through one endpoint:

   ```
   GET /a/api/project/me?sort=max_created_at_last_updated_clip
                         &show_trashed=false&exclude_shared=false&page=N
   → { num_total_results: 215, current_page: N,
       projects: [{ id, name, clip_count, created_at, last_updated_clip, … }] }
   ```

   20 rows per page. `num_total_results` on page 1 gives the page count, so
   pages 2..N are fetched four at a time (~2 s for 215 workspaces).

The endpoint wants `Authorization: Bearer <clerk JWT>`. Suno also keeps that JWT
in the JS-readable `__session` cookie, so `catalog.js` reads it at export time
(always fresh — a captured header would expire) and issues the requests from the
content script (same origin, verified working in an isolated world).

If the API path throws (signed out, endpoint renamed), `catalog.js` falls back to
the picker: click `S.findWorkspaceTrigger()`, scope to the `[role="dialog"]`
holding the search input, clear any stale filter, then repeatedly
`scrollTop = scrollHeight` and wait for the row count to grow, up to 80 rounds.
Rows are `button > span` with text `<name> (N clips)` (legacy) or
`<name>` + `N songs · …` (newer). Escape closes the popover again. The panel
shows `catalog-progress` events while this runs and the status line reports which
path was used, so a partial list is visible rather than silent.

### Songs (`include songs` checkbox)

Every clip already carries its workspace, so no per-workspace drilling is needed:

```
POST /a/api/feed/v3
{ "cursor": null, "limit": 100, "filters": {
    "disliked": "False", "trashed": "False",
    "fromStudioProject": {"presence": "False"},
    "stem": {"presence": "False"}, "stemComplement": "False" } }
→ { clips: [...], next_cursor, has_more }
```

Each clip has `id`, `title`, `created_at`, `status`, `is_download_unlocked`,
`model_name`, `metadata.{type,duration,tags,has_stem}` and
`project: {id, name, …}` — the workspace. `limit` > 100 is rejected with HTTP
400, and cursors are sequential, so the export is one loop; on a 2.7k-clip
library that is 27 requests in ~35 s (median 1.2 s/page). The feed reports
`has_more`, never a total, so progress uses the sum of workspace clip counts as
an approximate denominator (`done/~total`) and the first response's
`next_cursor` drives the next call. Retries are 2 extra attempts with backoff;
a 4xx aborts. Output goes to a separate `suno-songs.json` (schema
`suno-songs/v1`, ~1.9 MB for 2.7k clips) so the catalog stays small.

The file is `{ schema: "suno-songs/v1", exportedAt, complete, pages, songCount,
filters, counts, songs }`. `complete` is true only when the loop ended because
the feed said `has_more: false`; hitting `MAX_SONG_PAGES` yields `complete:
false` plus `incompleteReason`, and a mid-walk HTTP failure yields a partial file
flagged the same way. `filters` is a flat echo of the request
(`{disliked:"Any", trashed:"False", fromStudioProject:"False", stem:"False",
stemComplement:"False"}`) derived from `FEED_FILTERS`, and `counts` is
`{liked, disliked}` computed over the rows actually written. Disliked clips are
**included** (the library view hides them by default) and flagged, so the file is
"all songs". Every song keeps `project: {id, name}` (null for the handful of
clips with no workspace); rows are sorted by project name → `createdAt` → `id` so
exports diff cleanly (Suno emits 2 clips per Create with identical timestamps,
hence the id tiebreak). `isLiked`/`isDisliked` come from
`reaction.reaction_type` (`"L"`/`"D"`, with `is_liked` as a fallback), and
`likedAt` is the reaction's `updated_at`. Signed `audio_url` is omitted on
purpose. `tools/probe-songs.js` asserts the contract (songCount === songs.length,
boolean flags, ISO-or-null likedAt, counts ≤ songCount, sort order, filters echo)
and warns if the summed workspace clip counts drift more than 5% from songCount
(they are Suno's cached aggregates: 2,683 vs 2,719 = −1.3%).

**Throttling.** Suno answers bursts with `429`. Both API helpers therefore
retry `429`/`408`/5xx and network errors up to 5 attempts, honouring
`Retry-After` when present and otherwise backing off 0.5 → 8 s with jitter;
only 400/401/403 are treated as fatal (one attempt). Feed pages are also spaced
120 ms apart and the workspace pages are fetched 2 at a time. If every retry
fails mid-walk, `collectSongs` keeps the rows it already has, returns
`complete: false` with an accurate `incompleteReason` (e.g. `HTTP 429 (rate
limited) at page 4`), and the panel writes that file anyway — flagged, so the
importer rejects it — instead of discarding a 30 s scan.

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
