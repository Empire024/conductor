# Phone lock and phone terminal

Two features on the phone web app (`src/phone/**`, served by `src/main/phone-access-server.ts`):

- **The 6-digit lock** (`src/main/phone-lock.ts`): a second factor on top of pairing. Pairing
  proves *which phone* is asking (its bearer token); the code proves *the owner is holding it*.
- **The terminal** (`src/main/phone-terminal.ts`): a shell on this machine (MAIN) inside the phone
  app, for machine chores without Tailscale-SSHing into the computer.

The owner sets, changes or removes the code, picks the idle time, resets a lockout and locks every
phone at once in **Settings > Phone > Phone lock**. Without a code, phones work as before and the
terminal is closed.

## How the lock is enforced

Everything is decided on the computer. The phone's lock pad is only a view of what the server
already refuses.

1. `PhoneAccessServer.handle` authenticates the device (bearer token, as before).
2. `/api/lock/*` (state, unlock, touch, lock) is answered next. Nothing else is.
3. **The gate**: when a code is set, every other route needs `X-Conductor-Unlock: <token>` naming a
   live unlocked session *of that same device*; otherwise `423 { locked: true }`.
4. Only then is the route table (`buildRoutes()`) or a registered extension
   (`registerPhoneApiRoute`, e.g. Ideas) dispatched.

Because the gate sits in front of the table and the extensions, a new route is locked without
anyone remembering to lock it. `src/main/phone-access-server-lock.test.ts` walks every entry of
`routeTable()` plus a registered extension with a locked phone and a forged token and expects 423
from each, and it pins the only paths the handler looks at before the gate (`/api/health`, `/api/`
assets, `/ca.crt`, `/api/pair`, `/api/lock/`), so adding an early path fails a test on purpose.

What stays open, deliberately: `/api/health` (the diagnose page, no data), `/api/pair` (needs the
desktop's one-time pairing code; a new phone is then locked like the rest), and the static shell
assets (no data in them; `xterm.js` is among them).

### The code

- Six ASCII digits, checked with **scrypt** (N=2^15, r=8, p=1, 32-byte key, 16-byte random salt;
  about 32 MiB and ~100 ms per guess, run on libuv's thread pool, not the main thread).
- The hash record lives in the **OS credential vault** (`SecretVault`, DPAPI/Keychain via
  Electron safeStorage), not the settings table. A copied `conductor.db` alone does not hold it.
  A non-secret marker in settings records that a code exists, so if the vault stops answering the
  lock **fails closed** (refuses to unlock, asks for the code to be set again) instead of turning
  itself off.
- Compared with `timingSafeEqual`; a malformed attempt still costs one hash, so the answer's
  timing does not tell a malformed attempt from a wrong one.
- The code crosses IPC once, from Settings to the main process, and is never sent back, logged or
  stored in plain text.

### Attempts, backoff, lockout

One failure counter for **all** phones together, persisted in settings (a restart does not hand
out fresh attempts). Verifications run one at a time, so parallel guesses cannot race the counter.

| consecutive failures | next attempt |
| --- | --- |
| 1 | immediately |
| 2 | after 5 s |
| 3 | after 30 s |
| 4 | after 2 min |
| 5 | **locked out**: no phone can unlock until the desktop resets it |

While waiting (429) or locked out (423) an attempt is refused *without* hashing. A right code
clears the counter. A lockout ends every unlocked session and writes an audit line. **Reset
attempts** on the desktop clears it; the code stays.

### Unlocked sessions

- A right code returns a 32-byte random unlock token; the server keeps only its SHA-256, bound to
  the device id. The phone keeps the token **in memory only**: a reload, a crash, or iOS evicting
  the app all mean the code again. Unlocked sessions are not persisted either; restarting
  Conductor locks every phone.
- **Idle expiry** (1, 5 default, 10 or 30 minutes): only `POST /api/lock/touch` (sent by the app on
  a tap, key or scroll, at most every 20 s) and terminal input count as activity. A screen that
  polls by itself (System's metrics) does not keep the phone open. A sweep every 10 s ends idle
  sessions even when no request arrives.
- **Background**: an app that was hidden for over a minute locks when it comes back (and tells
  the server, which ends the session).
- Ending a session (idle, background, "Lock every phone now", code change, lockout, unpair) sends
  `locked` down the phone's open event streams and closes them, and kills that session's terminals.
  Setting or changing the code also closes streams that were opened before any code existed.

### Notifications

A phone that holds no unlocked session gets pushes with **no content**: title "Conductor", body
"Unlock Conductor to see what changed.", no conversation id, link to `/#/`. Unlocked phones get the
normal text. In-app toasts arrive only over the event stream, which a locked phone does not have.

## The terminal

- Reuses **TerminalManager** (node-pty, the same PTY code as the desktop's terminal panes): the
  shell is an ordinary terminal in a project workspace (the phone picks one of MAIN's projects; it
  starts in the project folder), with the usual 512 KiB output ring buffer and transcript. The
  phone renders it with the same **xterm.js** the desktop uses (served as `/xterm.js`, loaded only
  on `#/terminal`), plus a key row (Ctrl, Esc, Tab, arrows, Paste, Copy), resize via the fit addon,
  5000 lines of scrollback, and copy of the selection or the visible screen.
- Transport: the phone's own authenticated HTTPS connection. Output is a server-sent event stream
  (`GET /api/terminal/:id/stream?from=<offset>`, base64 chunks with byte offsets, so a reconnect
  resumes exactly); keystrokes go up in POSTs batched over 12 ms (max 64 KiB each). The listener
  refuses websocket upgrades, as before.
- Rules (`PhoneTerminals`):
  - only with a code set and an unlocked session; **the code is typed again for every new shell**
    (`POST /api/terminal/open { code, ... }` goes through the same attempt counter);
  - a shell belongs to the device *and the unlocked session* that opened it; any other phone, or the
    same phone after re-unlocking, gets 404 for it;
  - killed when that session ends, after **10 minutes without a keystroke**, on Close, when the
    phone is unpaired, when phone access is switched off, and when Conductor quits;
  - at most 3 per phone, 6 in total.
- **Audit**: exactly one line per shell, written when it ends, to
  `<userData>/logs/phone-audit.log` (and the console): device name and id, machine, project and
  workspace, start, end, duration, why it ended, and how many bytes were typed. **Never what was
  typed.** Lockouts, resets and code changes are logged there too.

### Paired machines: not yet, on purpose

The phone terminal opens on MAIN only; `open` with any other `machineId` is refused (403). A
paired machine's shells are reachable from MAIN through `RemoteTerminalBindings` under that
machine's existing project grants, but those bindings deliver output only to the desktop windows
(`terminal:data` broadcasts) and have no subscriber seam a phone stream could use; adding one means
changing `remote-terminals.ts`, which this work does not own. The relay path
(`remote-relay.ts`: a private gist per machine, polled) cannot carry an interactive PTY stream
with usable latency in any case, so when paired-machine shells come, they must be limited to peers
on a direct connection and must go through `terminals.open`'s project grant unchanged. The phone
itself always talks to MAIN over the direct listener; there is no phone relay path.

## Threat model

**Stolen unlocked phone.** The thief has the paired token and a live unlock token in the app's
memory. Exposure is bounded by the idle time (default 5 minutes without a touch; the thief touching
it keeps it open, which is the residual risk), and by the background rule (put in a pocket for a
minute, it locks). Opening a *new* shell needs the code again, so an unlocked phone is not a shell;
a shell already open when the phone was taken stays usable until the phone locks or 10 minutes pass
without typing, and then dies. The owner can cut it off at once from the desktop: **Lock every phone
now**, then **Revoke** the phone (kills its streams, sessions and shells, and its token stops
working).

**Stolen locked phone.** The thief has a valid pairing token but no unlock token (memory only). The
server answers every data route with 423, so there is nothing to read, and notifications arrive
without content. Guessing is limited to 5 codes in total before the lock needs the desktop (see
brute force). The paired token is still worth revoking from the desktop.

**Network attacker on the path, and the relay.** Phone traffic is TLS to the listener's own CA
(or Tailscale's certificate) and, under "Only through Tailscale", only accepted from tailnet
addresses; the bearer token and unlock token ride inside TLS in headers, never in URLs. POSTs must
be same-origin JSON (origin, `Sec-Fetch-Site` and content-type checks), and no CORS grant is ever
issued, so a web page cannot drive the API with the phone's tokens. The unlock token is bound to
the device, so a token lifted from one phone's traffic would not unlock another. The machine-to-
machine relay carries no phone traffic and no terminal traffic at all (see above); its sealing and
authority rules are unchanged by this work.

**Brute force of 6 digits.** 10^6 codes; the online budget is 5 attempts across all phones before a
lockout that only the desktop clears, with 5 s / 30 s / 2 min waits between the later ones, so an
online guesser has a 5 in a million chance, then must get the owner to reset it. Offline, an
attacker needs the scrypt record, which lives in the OS credential vault (DPAPI-bound to the
Windows user), not the database file; with it, ~100 ms per guess makes the full space about a day
of one core, which is why the record is not left where a stolen database would expose it. The
limitation is the code's length itself: six digits is a lock-screen strength second factor, not a
password, and it relies on pairing (a device token only this phone holds) as the first factor.

**What the lock does not cover.** The app shell files, `/api/health` and `/ca.crt` are public by
design (no data). A local user of the computer can already do everything the phone can. Push
notification *delivery* (that something happened, and when) is visible on a locked phone's lock
screen; their content is not.
