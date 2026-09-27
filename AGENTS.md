# AGENTS.md — SunoGen

Guidance for an AI agent (or human) picking up this project in a future session.
Read this first, then `ARCHITECTURE.md`.

## What this is

A personal-use Chrome extension (Manifest V3) that batch-generates **Suno Cover
Song** variations from saved **style presets**, applying the user's naming and
workspace conventions. It drives the real suno.com UI (DOM automation) — there is
no public Suno API and Workspaces are UI-only.

Deliverable = `suno-gen/` folder (load unpacked). `tools/` is a dev-only
Playwright harness and is NOT part of the shipped extension.

## Current status (validated live)

- End-to-end multi-preset batch works: source pick → Cover → fill style/title/
  lyrics → select/create workspace (verified) → Create → monitor to completion.
- Verified with a live 2-preset batch: both jobs routed to the intended workspace
  and reached `complete`.
- Do **not** trust this doc over the code; selectors change when Suno ships UI.

## Quick start

1. `chrome://extensions` → Developer mode → Load unpacked → select `suno-gen/`.
2. Pin the extension; click the toolbar icon to open the side panel (opens via
   `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`).
3. On `suno.com` with your clip list visible: **Pick source song** → click a row
   → fill Batch fields → tick presets → **Generate batch** (tick *dry run* first).

### Reloading after code changes

- After editing extension files you MUST reload the extension. Use the panel's
  **Tools → Reload extension** button (`chrome.runtime.reload()`), or the ↻ on the
  card at `chrome://extensions`. There is no refresh in the side panel itself.
- Content scripts self-heal: the panel injects the latest code into the active
  Suno tab on open, and `content.js` removes/replaces any prior `onMessage`
  handler (`__sunogenHandler`) so a reload takes effect without reloading the page.
- If behavior looks stale despite that, reload the Suno tab once.

## Dev harness (Playwright, `tools/`)

Uses `playwright-core` (no browser download) and attaches over CDP to a real
Chrome. Rationale and details in `ARCHITECTURE.md`.

```bash
npm install                 # once
npm run chrome              # launches debuggable Chrome (tools/.chrome-profile)
                            #   -> log into Suno in that window ONCE (session persists)
npm run inspect             # dump selector inventory of the live create page
npm run cover -- --title="two days"        # drive Cover flow, dump menu + form
node tools/probe.js --url=https://suno.com/me --inject '<js>'
node tools/test-flow.js --title="two days" --style="..." --song="..." --ws="26-9 Mashes"
node tools/test-flow.js ... --submit=yes   # ACTUALLY submits (spends credits)
node tools/test-flow.js ... --batch=yes    # runs a 2-preset batch via runBatch
```

- `npm run chrome` spawns Chrome with `--remote-debugging-port=9222` and a
  dedicated `--user-data-dir` (required: Chrome 136+ ignores remote debugging on
  the default profile). Google login is done manually by the user; never handle
  credentials.
- Chrome stays running after the script exits (detached). Close it manually.

### Testing techniques that paid off

- **Inject the real extension logic into the page**: `test-flow.js` and
  `probe.js --inject` add `shared/title.js`, `content/selectors.js`,
  `content/cover-flow.js` via `page.addScriptTag`, then call
  `globalThis.SunoGenCoverFlow._internals.*`. This exercises the exact shipping
  code against live Suno without needing the extension installed.
- **`_internals` is the test seam.** Expose any new step there so it can be
  called in isolation (e.g. `ensureSourceRow`, `selectWorkspace`, `monitorJobs`).
- **Confirm without spending credits**: fill the form and inspect
  `form state` / screenshots, but do not call `clickCreate`. Only use
  `--submit=yes` / `--batch=yes` when the user has authorised generation.
- **Screenshots**: harness writes `tools/out/*.png`; read them back to visually
  confirm menus/forms.
- **`probe.js` flags**: `--inject`, `--click=<css>`, `--click-re=<regex>`,
  `--click-text=<exact>`, `--click-at=x,y`, `--wait=ms`, `--shot=name`.
- **Recorder** (panel Tools → Record flow): captures clicks/hovers with element
  descriptors, persisted in `sessionStorage` so it survives navigation; retrieve
  via Tools → Copy log/diagnostics. Use when a menu path is unknown.

## Environment / gotchas

- macOS; Chrome at `/Applications/Google Chrome.app/...` (override `CHROME_PATH`).
  Node 24, npm 11, zsh. Not a git repo.
- **Suno generates 2 clips per Create** — always. 2 styles => 4 clips. There is no
  single-clip option.
- **Covers inherit the source's workspace by default.** Always set the workspace
  explicitly and verify the "Save to..." pill changed.
- **Covers keep the previously loaded audio if the Cover menu item isn't
  actually clicked.** The create panel renders a `"Change condition type from
  Cover"` button that a global `[aria-label*="Cover" i]` query matches *before*
  the menu portal. Always resolve the Cover item via `S.findMenuCover()`
  (scoped to a visible `[data-context-menu='true']`/`[role='menu']`), and
  `verifyLoadedSource()` confirms the chip before Create. There is no model
  selection (default model is always used).
- **Async form population**: after the cover loads, Suno fills style/title from
  the source. Wait for that to settle (`waitForCoverData`), then write our values
  and verify; otherwise Suno overwrites them.
- **List virtualization / wrong page**: the batch runs on the active tab, which
  may be a create/workspace view whose list is empty or unrelated. `ensureSourceRow`
  navigates to the Library (`/me`) and searches; it waits for the route + search
  box, not just `.clip-row` (create pages have rows too, so that wait resolves
  before navigation and then searches the wrong DOM).
- Another extension ("Suno Manager V3") injects `data-sm-*` attributes,
  `data-testid="clip-row"`, and shortcut buttons. Do NOT depend on those; key off
  native `.clip-row[role=group]` and `aria-label`s.
- Suno sometimes returns Cloudflare 504s; retry later.
- Credits: a cover costs 10 credits (first 200 free). Be conservative with
  `--submit`/`--batch`.

## Conventions baked into the code

- **Title template:** `{date} {take}-{rating} {styleCode} - {songName}`
  - `date` = `YY-M` (e.g. `26-9`), `take` = 2-digit shared across styles
  - `rating` default literal `iiiN` (searchable prefix + placeholder edited later)
  - `styleCode` = no spaces, ≤ 8 chars (`70s jam` → `70sjam`)
  - Example: `26-9 01-iiiN qhvy - happy song`
- **Workspace:** default `{date} {songName}` (e.g. `26-9 bird song`); per-preset
  override wins; missing workspaces are auto-created (user preference).
- **Resolution order** (`title.js:resolveWorkspace`): preset override → batch
  workspace → derived from date+name.

## File map

```
manifest.json                 MV3: sidePanel, storage, scripting; content scripts + MAIN-world hook
src/shared/title.js           title/workspace builders (loaded by content + panel)
src/background/service-worker.js  defaults, side-panel behavior, getTab relay
src/panel/                    side panel UI (batch, presets, preview, Tools)
src/content/selectors.js      ALL Suno selectors + resilient lookup/helpers
src/content/cover-flow.js     the flow: open cover, fill badges, workspace, create, monitor
src/content/content.js        messaging, pick-source, recorder, page-hook relay
src/inject/page-hook.js       MAIN-world fetch/XHR observer for clip status
tools/                        Playwright harness (dev only)
```

## Known limitations / next steps

- No "pre-flight" workspace resolution pass before job 1 (per-job verify exists).
- Monitoring polls visible rows only; scroll away and it stops waiting (submit is
  unaffected).
- Optional: preset import/export; per-preset "variants" bookkeeping (always 2).

## Suggested first actions for a new session

1. Read `ARCHITECTURE.md`, then `src/content/selectors.js` and
   `src/content/cover-flow.js`.
2. `npm install && npm run chrome`; user logs into Suno.
3. `npm run inspect` to re-verify the selector map against current Suno.
4. Use `node tools/test-flow.js` (no `--submit`) to sanity-check the form fill.
