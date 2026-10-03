# Conductor phone control suite

Owner brief, 2026-10-03. Controller: agent_murrdn5k_umf5k4m. The phone is the same product as the desktop, with fast thumb navigation and immediate feedback. Preserve pairing/auth, phone lock, image attachments and Share Target, Ideas and markdown.

## Visual system

Use the active theme tokens in `src/renderer/src/styles.css` (the explicit dark/light overrides, not the older root defaults):

| Token | Dark | Light |
| --- | --- | --- |
| bg | #01111f | #edf1f7 |
| surface-0 | #011627 | #f6f8fa |
| surface-1 | #071d2e | #ffffff |
| surface-2 | #0b2942 | #eef2f7 |
| surface-3 | #133a57 | #e2e8f0 |
| border / soft | #1d3b53 / #102f46 | #d4dbe6 / #e1e6ee |
| text / secondary / muted | #d6deeb / #b2ccd6 / #637777 | #403f53 / #59607a / #8991a5 |
| accent / secondary | #82aaff / #7fdbca | #4876d6 / #2aa298 |
| danger | #ef5350 | #d3423e |

Follow system appearance by default; More offers System / Light / Dark. Use readable secondary text for small labels, 44px minimum targets, 16px inputs, 16px page gutters, 12–18px corners, restrained borders and elevation. Headings are compact and confident. Running indicators share the desktop .9s orbit. Respect reduced motion. Safe areas and the visual keyboard viewport must work at 320px and up.

## Navigation and screens

Five bottom destinations: Home, Tabs, Attention, New task, More. Home is the project overview: project cards, running/attention counts, recent tabs and a small recent-activity preview. Project cards open that project's tabs. Home is permanently reachable, including conversation, terminal, idea and diagnostic detail screens (persistent bottom navigation with composer safe-area spacing). Native hash history is authoritative; Back goes to the actual previous in-app location, with Home fallback for direct links. Native edge swipes pop one in-app screen; a same-origin Home history boundary prevents falling into stale browser routes. Home returns to the root of the stack. Never simulate swipe gestures or push a new history entry for Back. Usage and Activity refresh every 15 seconds while visible.

Tabs show project name plus a stable project colour on EVERY row, title, provider/model, recent activity time and explicit Running / Waiting / Needs you / Done state. Sort by recent activity; highlight recently finished work without flattening controller/coworker relationships. Attention is the filtered queue of approvals/questions needing the owner. New task presents project and agent/model visibly, a generous prompt and a clear Start task / Open tab action; workspace, machine, effort and title are secondary settings. Preserve draft on updates/failure. Last successful provider/model wins; otherwise Claude Opus, then available Claude/default Codex, with explicit choices when neither exists. Missing quota must never favour Grok.

More contains Project tasks, Ideas, Idea runs, Usage, Activity, System, Terminal, Phone/security, appearance and connection help. Existing bookmarked routes remain valid. Usage shows provider-reported Claude/Codex/Grok weekly and short/session windows, small historical graphs, reset times and observed freshness; unavailable/reset data is labelled unknown, never invented. Same source as desktop `usage.limits` / provider allowance history. Activity is a newest-first, window-bounded cross-project feed of completed outward actions and deliveries, with project, tab, time and a tab link. Include sent emails, deployments/production, shipped commits, installed updates, answered approvals and completed tasks using durable records. Distinguish confirmed completion from an attempted command. Trace today's Conductor print-shop email; add a durable recording path if necessary. Main-process reads must be indexed and time/row-bounded on multi-GB databases.

## Reliability and interaction

Render a useful shell/skeleton immediately. Cached last state may render instantly ONLY when it cannot bypass phone lock; clear sensitive cache on lock, unpair and 401. Show when cached/stale, refresh immediately on foreground/network return, cancel old requests and back off boundedly. Never replay mutations automatically. Connection status has a small animated indicator, plain explanation and retry/help; no bare Reconnecting screen.

Messages appear immediately with Sending, then Sent/Queued/Steered, and Delivered only after authoritative acknowledgement appropriate to that mode. Preserve failed drafts/attachments and expose error/retry without duplication. Stop has its own request state independent of a slow send and uses the same interrupt semantics as desktop `agents.interrupt`, including queued-turn behaviour. Keep pending Stop visible until confirmed or failed.

Dictation starts synchronously from the mic tap, captures exceptions including constructor/start, handles interim/final results without losing text, and stops safely on navigation. Detect Web Speech constructor and secure context; explain permission denial, no microphone, network/service failure, unsupported browser/PWA separately. Offer keyboard dictation as the fallback when an attempt fails or speech is unsupported, as a dismissible one-line note under the composer (never permanently); do not claim every iOS standalone or Android browser supports Web Speech. Real-device checks remain necessary beyond injected recognizer smoke tests.

The session composer is one row like a messaging app: [image] [field that grows from one line to five, then scrolls] [mic] [Stop, only while a turn can be stopped] [Steer / Queue / Send / Resume], every control a 44px target with the buttons on the field's last line. Nothing else sits under it unless dictation is listening or has failed. The tab bar owns the home-indicator inset once; the shell fills the screen from CSS (a Home Screen app fills it even when iOS reports a shorter visual viewport) and is sized to the visual viewport only while it is well short of the layout one (keyboard or zoom). While the keyboard is up the tab bar steps aside and the composer sits on the keys. `scripts/smoke-phone-composer.mjs` checks this at 390 and 320px in both themes; `--before` only takes screenshots.

## Work ownership and acceptance

A owns CSS, index.html and manifest only. B owns app.js first (navigation, Home/Tabs/Attention/More, new task, Usage/Activity UI), then releases it to C. C first investigates runtime/server causes and owns separate runtime test/smoke files, then exclusively owns app.js, boot.js and sw.js for connection, optimistic sends, Stop and dictation. Controller owns backend integration, docs, feature-list, existing test/smoke adaptation and final review. No two workers edit app.js concurrently. Coworkers deliver to controller without ship/update.

Acceptance: phone unit/server tests, sequential parked phone smokes, light/dark screenshots under `.conductor-scratch`, local `git.ship` with scoped paths, then exact-commit `app.update` with shell/images/markdown-dictation smokes and offer:true. Wizard installs; this controller does not install or publish.
