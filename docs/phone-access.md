# Phone access

Your phone as a thin controller of the Conductor on this computer: see every conversation and what
it is waiting for, answer a question or an approval, send a follow-up, start a task on the computer
that holds the project, read the machine's load, and get a push notification when a conversation
finishes or needs a decision - even with the phone app closed.

Nothing runs on the phone. It is a small installable web app served by Conductor itself; every action
it takes happens on this computer (or, for a project that lives on a paired machine, on that machine,
through the same mirror the desktop window uses).

## Turn it on

Settings → **Phone**. Switch on "Let my phones control this Conductor". Conductor shows the address
the phone should keep: the Tailscale address of this computer, which answers at home and away while
Tailscale is on. The four numbered steps below each show a QR code, a status read from this computer,
and a "Check again" or "Show a new code" retry.

1. **Tailscale on the phone.** Scan the QR (App Store or Play Store), sign in with the same account
   as this computer (the panel names it), keep Tailscale on. The step turns green when the phone
   appears on the tailnet; "Check again" re-reads Tailscale.
2. **Make the address trusted.** Recommended: a certificate from Tailscale. HTTPS certificates must be
   enabled for the tailnet at <https://login.tailscale.com/admin/dns> (the panel says whether they are,
   with a button and a QR to that page); then switch on "Get a trusted certificate from Tailscale". The
   phone needs nothing installed. The machine's MagicDNS name becomes public in
   certificate-transparency logs. Alternative: install Conductor's own certificate. Scan the QR of the
   trust page; on an iPhone the page offers "Open in Safari" because only Safari can install a
   profile, then Settings → Profile Downloaded → Install, then Settings → General → About →
   Certificate Trust Settings and full trust for Conductor. Compare the fingerprint with the one in the
   panel.
3. **Pair.** "Show pairing code" shows a QR and an 8-character code, valid for ten minutes, one phone.
   Scanning with the Camera opens the phone's default browser; that page offers "Open in Safari" and
   shows the code large, so a phone that already has Conductor on its Home Screen can just open it and
   type the code. The step turns green when the phone appears in the paired list.
4. **Home Screen and notifications.** Share → Add to Home Screen, open it from there, turn
   notifications on under Phone. iOS delivers web push only to a Home Screen app, and a Home Screen app
   has its own storage, which is why pairing should happen inside it.

### Advanced

Folded away in the panel: where it listens ("This network" on every interface, or "Only through
Tailscale" bound to the tailnet address only, failing closed when Tailscale is off), the port (default
51841), and the notification master switch.

### The Tailscale certificate, in detail

Under Tailscale exposure, **Get a trusted certificate from Tailscale** asks Tailscale for a Let's
Encrypt certificate for this computer's MagicDNS name (`tailscale cert`). A phone on the tailnet then
needs nothing installed: it opens `https://<machine>.<tailnet>.ts.net:51841/` and the browser already
trusts it. Two things to know before turning it on: the tailnet needs HTTPS certificates enabled at
<https://login.tailscale.com/admin/dns>, and the request publishes the machine's MagicDNS name to
public certificate-transparency logs, which is why it is off by default. Conductor renews the
certificate on its own two weeks before it lapses. The address is served with the Conductor
certificate for everything but that one name, so a phone that trusts the authority keeps working too.

## What the phone shows

- **Sessions**: every open conversation, grouped by project and workspace, with one word for its
  state - needs you, working, limited, failed, disconnected, stopped, done, idle - the provider and
  model, the computer it runs on, how long the current turn has been going, and the last thing it
  said. Filters for what needs attention and what is working. Conversations whose tab is closed sit
  in a collapsed "Not open" section; they can be read but never ask for anything.
- **A conversation**: the timeline the desktop shows, trimmed for a phone; a pending question or
  approval as a card with its choices; a composer whose button says Send, Steer or Queue depending on
  what the provider allows mid-turn; Stop while a turn runs; Resume when the conversation was
  interrupted or disconnected.
- **New**: start a task - project, workspace, the computer it runs on, provider, model, effort and
  the first message. A project belongs to exactly one computer, so "run on" is stated rather than
  chosen; a project that lives on a paired machine runs there, through the same placement the
  desktop launcher uses, and its conversation is mirrored back here. Starting a task needs a
  Conductor window open on this computer, because the tab is a real, visible tab.
- **System**: CPU, memory and GPU of this computer, the local model servers and whatever else is
  expensive right now, the runtimes Conductor has open, and the provider usage windows (weekly and
  short) as the providers last reported them.
- **Phone**: the phone's own name, notifications on/off with a test button, and unpair.

## When the phone shows nothing

A Home Screen app on iOS shows its splash colour and then a blank page when the address it was added
from does not answer; the browser's error page never appears in a Home Screen app. Since this change
the app shows a card instead of a blank page whenever its own files fail to load or its script fails,
and a "Connection check" page (also reachable from the pairing screen and the Phone screen, at
`#diagnose`) that names the address the app uses, whether the page is running from the Home Screen, and
what `GET /api/health` answered.

- The computer is off or Conductor is closed. Start it.
- The phone is not connected to Tailscale. Open Tailscale on the phone.
- Conductor was switched from "This network" to "Only through Tailscale" after the app was added from
  the Wi-Fi address. Scan the pairing code again and add the app to the Home Screen from the new
  address.
- The certificate is not trusted yet. Do step 2.

## Notifications

The desktop sends a push when a watched conversation goes into a state that asks something of you or
ends your wait: a new question or approval (a second question in a row counts as new), a finished
turn, a failure, a closed usage window. Nothing is sent for a conversation seen for the first time,
nothing while it is merely working, and nothing for history without a tab. Push goes through the
phone browser's own push service (Apple's for Safari, Google's for Chrome) using VAPID keys minted
here; the payload is end-to-end encrypted to the phone, and neither service can read it. A phone
whose subscription the service reports gone is marked as needing notifications turned on again; a
phone that keeps failing shows a count in the panel.

**Send push notifications** in the panel is the master switch; each phone still opts in on its own.
While the app is open, the same events arrive over its live stream as an in-app toast.

## Security

- HTTPS only, with a certificate the phone was taught to trust; TLS 1.2 or later.
- Every API call carries a bearer token that names one paired phone. Tokens are handed out only by
  redeeming a pairing code, are stored hashed, and never appear in a URL. A page from any other
  origin cannot send that header, and the listener additionally refuses POSTs whose Origin is not
  its own.
- Pairing codes are single-use, expire in ten minutes, use an alphabet without look-alike characters,
  and an address that fails five times is ignored for ten minutes.
- The listener serves the app shell and the API and nothing else: no files, no shell, no arbitrary
  paths. What a phone can do is exactly what the desktop composer can do to a conversation, plus
  opening a tab the way the launcher does.
- Under Tailscale exposure the listener binds only the tailnet address and refuses any socket from
  outside the tailnet, even through a local forward.
- The certificate authority's private key, the server key and the push keys live in the OS
  credential store, like remote control's keys. Without that store nothing is served.
- A paired phone is trusted like the owner at the keyboard: revoke a lost phone from the panel
  immediately.
- `GET /api/health` is the only unauthenticated JSON answer: version, exposure and whether the
  request came over the tailnet, nothing about projects or conversations.

## Keeping the process alive

While phone access is on and listening, closing the last window leaves Conductor running behind the
tray icon, exactly as hosting another computer does, so a phone can still reach it. Quitting asks
first while a phone is connected.

## Validation

- `src/main/phone-access.test.ts`: settings, pairing and lockout, token authentication and
  revocation, the certificate chain, the phone's view of sessions/history/usage/metrics, message
  routing (send/steer/queue/resume, local and mirrored), answering questions, opening tabs locally
  and on a paired machine, the notification rules with a fake push service, the recommended address
  and the pairing endpoint choice.
- `src/main/phone-access-server.test.ts`: a real HTTPS listener over the CA-signed chain - shell
  assets and headers (the boot guard included), `/api/health`, the pairing endpoint, bearer and
  origin enforcement, body limits, the live stream, Tailscale fail-closed, a port clash, and the
  tailnet detail behind the setup steps (phones on the tailnet, HTTPS certificates on or off, Check
  again without a restart).
- `src/main/tailscale.test.ts`: each node's OS and the tailnet's CertDomains from
  `tailscale status --json`.
- `src/phone/phone-shell.test.ts`: boot.js and sw.js exactly as served, in node:vm with a stub
  DOM - the boot card for a failed, stuck or throwing app.js, the watchdog, browser detection, the
  Safari hand-off address, and the service worker's built-in "not answering" page.
- `src/main/phone-tls.test.ts`, `src/main/web-push.test.ts` (RFC 8291 test vector),
  `src/shared/qr-code.test.ts` (with an independent decoder), `src/main/phone-notifications` rules,
  and `src/renderer/src/components/phone-access-view.test.ts` for every decision the setup steps
  show (step status, address labels, phones on the tailnet, the recommended-address sentence).
- `scripts/smoke-phone-access.mjs` runs the real Electron app with the synthetic Claude fixture:
  enables phone access from the settings bridge, pairs over HTTPS, opens a tab from the phone API,
  answers a question the agent asks, sends a follow-up, reads metrics, checks the live stream's
  notifications and the Settings > Phone page. Run after `npm.cmd run build`; the report is
  written to `artifacts/phone-access/`.
- `scripts/smoke-phone-shell.mjs` (`npm run test:phone-shell`) opens the served phone app in a
  second parked, phone-sized window that trusts only the listener's certificate: boot, the
  connection check, the trust page, the iPhone Chrome and Safari landings, a real pairing, the boot
  card with app.js blocked, and "not answering" after phone access is switched off. Screenshots and
  `smoke-report.json` go to `artifacts/swarm-2026-09-23/phone-app/`.
