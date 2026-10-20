# Project browser tools (`conductor-browser` MCP)

Every Claude, Codex and Grok conversation with **browser tools** switched on (the globe toggle in
its composer, `settings.browserMcp`) gets the `conductor-browser` MCP server: a loopback endpoint in
`src/main/browser-mcp.ts` whose tools are defined in `src/shared/browser-mcp.ts` and run against the
project's own isolated browser in `src/main/browser-views.ts` (one `WebContentsView` per project,
partition `persist:conductor-browser-<projectId>`). The bearer token is minted per conversation and
only ever reaches that project's browser; it travels in a private config file, never in argv.

## Presentation

The project browser is the same live page however it is shown: in the Browser rail, expanded across
the workspace, detached into its own window, or in the **background**. A browser no window has
mounted lives in a hidden, non-focusable parking window at -32000,-32000 with a 1440x900 viewport.
`browser_present({mode})` switches between `background` and `detached` (shown without focus) without
selecting a workspace tab. Nothing a tool does shows a window over the owner's screen or takes focus.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_present` | `background` or `detached` presentation. |
| `browser_navigate` | Open an http(s) URL; returns the URL the view actually settled on. |
| `browser_snapshot` | URL, title, visible text, headings, links and form fields (read-only). |
| `browser_screenshot` | A PNG of the view, in every presentation (read-only). |
| `browser_video_frames` | Frames of the page's `<video>` (or an element / the viewport) as image files, optional WAV. |
| `browser_download` | A file fetched with the browser's session, written into the project. |
| `browser_console` | Recent console messages and page errors (read-only). |
| `browser_click`, `browser_type` | Click / type into the first element matching a CSS selector. |
| `browser_evaluate` | Run JavaScript in the page and return its JSON result (capped at 200,000 characters). |

### Screenshots in the background

A guest hidden inside its workspace window (background presentation after the Browser rail mounted
it, or a pane the owner is not looking at) has no compositor surface, and Electron's `capturePage`
then resolves an **empty 0x0 image** rather than an error. That is what `browser_screenshot` used to
return. Now a capture of a view that is not on screen borrows the hidden parking window for the
duration of the capture, at the size the page is laid out at, and puts the view back where its
presentation keeps it (`BrowserViews.withCapture`). A visible view is captured where it is. An image
with no pixels is never returned: the tool fails with the reason and the next step (read the page
with `browser_snapshot`, or `browser_present({mode:"detached"})` and capture again).
(Probed 2026-10-20 on Electron 37: `capturePage` on a window shown off-screen fails with "Current
display surface not available".)

A guest that has **never been painted in a shown window** has no compositor surface at all: a
project whose browser only MCP ever drove lives in the hidden parking window from its first load.
There `capturePage` refuses ("Current display surface not available for capture") or comes back
empty however long it waits, and neither `invalidate()`, reparenting, toggling visibility, showing
the host off-screen, a frame subscription nor `stayHidden`/`stayAwake` changes that. That was the
installed app's failure after 9aa6dba; the parked smoke had passed because its guest had first been
painted in the (shown, off-screen) workspace window, and because Playwright drives Electron over
DevTools, which by itself gives a guest a surface. A DevTools `Page.captureScreenshot` makes the
renderer produce a surface: it answers with the PNG in about 0.1 s, `capturePage` works from about
70 ms after the request, and it keeps working after the debugger detaches. So when the parked
capture fails, `grab()` takes one DevTools screenshot (attaching the debugger only if no Electron
debugger client is attached, and detaching only what it attached), retries `capturePage`, and
falls back to the DevTools PNG itself. Video frames go through the same `grab()`, so a primed guest
captures every later frame directly.

A second state showed up on the installed e5f2a81 (videos wizard): right after
`browser_present({mode:"detached"})` and then `{mode:"background"}`, the first capture came back
empty and the DevTools screenshot answered "Internal error"; `browser_navigate` to the same page
healed it. (In Chromium, "Internal error" from `Page.captureScreenshot` means the widget had no
view to copy from.) It needs a detached window really painted on a display, so neither the
off-screen probes nor the parked smoke reproduce it. Two defences followed: a guest that moved to
another host window since its last capture (`OwnedBrowser.rehosted`, set by `attachTo`) first gets
a fresh frame (a 1px resize round trip, which allocates a new surface as a navigation does, plus
`invalidate()`, waiting for two animation frames); and a failed capture escalates through a
DevTools screenshot, a fresh frame and a brand-new capture host, each followed by `capturePage`
and DevTools again. The error, if every step fails, lists what each step returned, and suggests
`browser_navigate` to the same URL.

On the installed 1e4ace2 every one of those steps still failed for that state (empty image and
DevTools "Internal error" each time), while `browser_navigate` to the same URL healed it. So the
chain now ends in a **reload of last resort**: the same `loadURL` of the page's own URL that
`browser_navigate` makes, a wait for the load and a fresh frame, and the capture again. The result
says so plainly (`reloaded` in the screenshot and `browser_video_frames` results, appended to the
tool text): the page's scroll position, video position and form input are lost.
`browser_video_frames` takes one capture before it locates the video, so a reload can never leave
the frames pointing at an element that is gone. A page is never reloaded when that could submit a
form again: the session's `webRequest.onSendHeaders` (non-blocking, `types: ['mainFrame']`, so a
page's own traffic never passes through it) records the method of the guest's last main-frame
request, each redirect hop included. Only a page whose last main-frame request was a GET is
reloaded, so a POST answered with a 303 is fine. A POST, an unknown method or a non-http(s) page
keeps the full error, with the reason as its last entry (`no reload: …`).

### Watching a video: `browser_video_frames`

`{selector?, start?, end?, fps?, maxFrames?, scale?, format?, mode?, audio?}`. The target is the
selector's element (or the `<video>` inside it), else the page's largest video, playing ones first;
without a video it films the element or the viewport. Frames go to
`<project>/.conductor/browser-captures/<timestamp>/frame-0001.png` (or `.jpg`), each cropped to the
target and listed with its media time; read them with the file tools.

- **seek** (default for a seekable video): pauses the video and seeks to `start`, `start + 1/fps`, …
  up to `end` (default: the video's end), waiting for each frame to be painted. Exact, and not real
  time.
- **play** (live or unseekable streams, `mode:"play"`, or `audio:true`): plays the window in real
  time and captures at `fps`.
- **viewport**: no video; the element or viewport is captured over wall-clock time.

The page's audio output is muted for the whole call (`webContents.setAudioMuted`) and the video is
put back as it was found (time, paused or playing). Bounds: 300 frames, 30 fps, 256 MB of images and
about 48 s per call (45 s of real-time playback), because an MCP client gives an HTTP tool call
60 s (Claude Code's default). A longer window stops early and the result says
`continue with start=<seconds>`.

`audio:true` records the element's sound through `captureStream()` into 16-bit PCM WAV
(`audio.wav` beside the frames). When that is not possible it says why instead of writing a file:
no `<video>`, no audio track, the page refused the capture, or pure silence (a silent clip, or
cross-origin media without CORS, which Chromium mutes for page scripts).

### Saving reference media: `browser_download`

`{url}` or `{fromVideo:true, selector?}`, plus `path?` and `maxMB?`. The request goes through
Electron's `net` with the project browser's session: its cookies (`useSessionCookies`), its user
agent and the current page as `Referer`. Redirects are followed only to http(s), at most 10.

- The file lands in `refs/` by default, named from `Content-Disposition`, else the URL, with an
  extension from the content type. `path` is project-relative (or absolute inside the project); a
  value ending in `/` is a folder.
- It must stay inside the project: `..`, an absolute path elsewhere, a junction or symlink that
  leads out, an NTFS alternate data stream, and protected locations (`.git`, `.claude`, `.codex`,
  `.conductor`, `.github`, `.vscode`, `node_modules`, `AGENTS.md`, `CLAUDE.md`, `.env*`, keys, …) are
  refused (`src/main/browser-media.ts` `projectTarget`).
- A download only ever creates a new file: a named path that exists is refused, a default name gets
  `-1`, `-2`, ….
- 512 MB by default, `maxMB` up to 2048; a declared or actual size over the cap stops it and
  removes the partial file.
- A download still running after 45 s answers with `inProgress: true`; it continues as
  `<path>.part-…` and is renamed to `path` when complete.
- `fromVideo` resolves the video's `currentSrc` (else `src`, else its first `<source>`). A `blob:`,
  `mediastream:` or `data:` source (Media Source Extensions streaming, as most social video players
  use) is not a file; the tool says so and points to `browser_video_frames`.

Reference media is for analysis only.

## Permissions

The tools need no approval card:

- **Claude**: the conversation's flag-settings allow list carries an exact rule for every
  `mcp__conductor-browser__<tool>` whenever the tab has the browser server
  (`BROWSER_MCP_ALLOWED_TOOLS` in `src/main/providers/claude.ts`), beside the conductor request
  tools and the owner's grants. The read-only ones (`snapshot`, `screenshot`, `console`) are also
  outside the PreToolUse hook matcher.
- **Codex**: an `mcpServer/elicitation/request` for `conductor-browser` is accepted for the session
  by the adapter in every mode, with the notice `Conductor allowed conductor-browser/<tool> without
  asking` (`src/main/providers/codex.ts`); in Read only the two tools that write files
  (`browser_video_frames`, `browser_download`) keep their card. Other MCP servers are unchanged.

This is also the answer to Claude's Auto-mode classifier refusing a shell download of reference
media (`curl.exe` of a reel): Conductor cannot override that classifier, but the browser tools are
first-party, allowed by rule, and use the browser's own sign-in. The server's MCP `instructions`
(`BROWSER_MCP_INSTRUCTIONS`) tell every agent with the tools to use `browser_download` and
`browser_video_frames` instead of curl.

## Verification

- Unit: `src/main/browser-media.test.ts` (path containment, names, frame plan, crop),
  `src/main/browser-mcp.test.ts` (argument caps, no empty screenshot, instructions),
  `src/main/browser-owned-surface.test.ts` (background capture through the parking host and back),
  provider tests for the allow rules and Codex answers.
- Parked smoke: `node scripts/smoke-lock.mjs -- node scripts/smoke-browser-watch-media.mjs` after a
  build. It screenshots in background presentation (a pane-mounted guest, and a never-painted guest
  of a second project that only MCP drove), extracts red/green/blue frames and a WAV from
  `scripts/fixtures/browser-media/tiny.webm` (3 s, 160x90, VP8 + 440 Hz Opus) served from loopback,
  and downloads with a cookie and referer check. No network.
- Unprimed capture: `node scripts/smoke-lock.mjs -- node scripts/probe-browser-background-capture.mjs`
  bundles the real `BrowserViews` and runs it in plain Electron with no DevTools client, the
  installed app's condition. It checks that a plain `capturePage` of an MCP-only guest is refused
  (the reproduction), then that the screenshot and red/green/blue seeked frames succeed with nothing
  shown. Exit 0 means reproduced and fixed.
