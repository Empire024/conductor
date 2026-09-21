# Phone access

Your phone as a thin controller of the Conductor on this computer: see every conversation and what
it is waiting for, answer a question or an approval, send a follow-up, start a task on the computer
that holds the project, read the machine's load, and get a push notification when a conversation
finishes or needs a decision - even with the phone app closed.

Nothing runs on the phone. It is a small installable web app served by Conductor itself; every action
it takes happens on this computer (or, for a project that lives on a paired machine, on that machine,
through the same mirror the desktop window uses).

## Turn it on

Settings → **Phone access**.

1. Switch on **Let my phones control this Conductor**. Conductor starts an HTTPS listener on port
   51841 (change it if you like) and shows the address it answers on.
2. Choose where it listens. **This network** answers on every interface of this computer, so a phone
   on the same Wi-Fi can reach it. **Only through Tailscale** binds this computer's tailnet address
   and nothing else - the same rule remote control follows - and refuses to start at all when
   Tailscale is missing, signed out or stopped.
3. **Trust this computer on your phone** (once per phone). The listener speaks HTTPS with a
   certificate signed by a certificate authority Conductor minted for this computer. The phone has
   to trust that authority once; after that Conductor can re-issue the server certificate as often
   as it needs to (a new LAN address, a new tailnet name, an expiry) without touching the phone
   again. Open `https://<address>:51841/ca.crt` on the phone - or save the certificate from the
   panel and send it across - and install it:
   - iPhone / iPad: open the link in Safari, allow the profile, then Settings → Profile Downloaded →
     Install. Then Settings → General → About → Certificate Trust Settings and enable full trust for
     "Conductor Phone Access".
   - Android: download the file, then Settings → Security → Encryption & credentials → Install a
     certificate → CA certificate. Chrome trusts it from then on.
   The fingerprint shown in the panel is what you compare against the one the phone shows before
   you trust it.
4. **Show pairing code**. The panel shows a QR code and an 8-character code, valid for ten minutes,
   usable once. Scan the code or open the address on the phone, give the phone a name, and pair. The
   phone receives its own bearer token; the code is spent. Every phone is listed in the panel with
   the last time it was seen, and can be renamed or revoked from there. Revoking closes its stream
   at once and refuses every later request from it.
5. On the phone, **add the app to the Home Screen** (Share → Add to Home Screen on iOS; the install
   prompt on Android), then open it from there and turn on notifications under **Phone**. iOS only
   delivers web push to an app on the Home Screen; Android does not mind either way.

### A certificate from Tailscale instead

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

## Keeping the process alive

While phone access is on and listening, closing the last window leaves Conductor running behind the
tray icon, exactly as hosting another computer does, so a phone can still reach it. Quitting asks
first while a phone is connected.

## Validation

- `src/main/phone-access.test.ts`: settings, pairing and lockout, token authentication and
  revocation, the certificate chain, the phone's view of sessions/history/usage/metrics, message
  routing (send/steer/queue/resume, local and mirrored), answering questions, opening tabs locally
  and on a paired machine, and the notification rules with a fake push service.
- `src/main/phone-access-server.test.ts`: a real HTTPS listener over the CA-signed chain - shell
  assets and headers, the pairing endpoint, bearer and origin enforcement, body limits, the live
  stream, Tailscale fail-closed and a port clash.
- `src/main/phone-tls.test.ts`, `src/main/web-push.test.ts` (RFC 8291 test vector),
  `src/shared/qr-code.test.ts` (with an independent decoder), `src/main/phone-notifications` rules,
  and the settings panel helpers.
- `scripts/smoke-phone-access.mjs` runs the real Electron app with the synthetic Claude fixture:
  enables phone access from the settings bridge, pairs over HTTPS, opens a tab from the phone API,
  answers a question the agent asks, sends a follow-up, reads metrics and checks the live stream's
  notifications. Run after `npm.cmd run build`; the report is written to `artifacts/phone-access/`.
