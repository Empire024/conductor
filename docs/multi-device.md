# Using Conductor from two computers

One computer owns the work. The other is a window onto it.

MAIN runs the projects: files live there, agents, terminals, builds and Git run there, and its own
Conductor window shows all of it. A laptop running Conductor can attach to MAIN and operate that same
workspace - the same tabs, the same conversations, the same shells - with everything streamed to the
laptop and every command executed on MAIN. Detached, the laptop is an ordinary Conductor with its own
local projects, and nothing of MAIN's is claimed as its own.

This is not screen sharing and not two synchronised folders. It is one authoritative backend with
more than one UI.

## What carries it: Tailscale

Both computers are signed into the same Tailscale account (sign in with the GitHub account you
already use). Tailscale gives each of them a stable address in `100.64.0.0/10`, finds a path between
them across separate internet connections without any router change, encrypts it with WireGuard, and
- when two NATs will not let a direct path through - carries it over its own relay (DERP) servers.

Be clear about what that means:

- **It is not infrastructure-free.** Tailscale's coordination server distributes keys and device
  lists, and its DERP relays carry traffic when no direct path exists. Conductor depends on both
  being up. It runs no VPS of its own and asks you to run none.
- **It is not always direct.** Whether a connection is direct or relayed is decided by the networks
  you are on. Conductor shows which it is, using only what Tailscale reports (`tailscale status`),
  never a guess from latency.
- **It is not unencrypted anywhere.** Direct or relayed, the WireGuard tunnel ends only on your two
  devices; a DERP relay forwards ciphertext. On top of that Conductor still speaks HTTPS with a
  pinned certificate and signs every request with a per-device key, exactly as it did before, so a
  tailnet device that is not paired sees nothing but a refusal.

Conductor never widens the listener to make a connection work. In Tailscale exposure it binds only
this machine's Tailscale address; if Tailscale is missing, signed out or stopped, the listener does
not start and the panel says why. It never falls back to `0.0.0.0`, a public IPv6 address, the LAN,
the old relay or the GitHub gist mailbox.

## Trust boundary - read this

A paired device allowed to run commands on MAIN is trusted to act as MAIN's user. It can open a
shell, run an agent, read and write every file in a shared project, and reach anything that MAIN's
own commands can reach - a database on MAIN's LAN, a mounted drive, a credential in MAIN's
environment. Project-root checks scope Conductor's *file APIs*; they do not sandbox a shell, and
nothing here claims to. Tailscale's ACL decides which devices may reach the port; it does not decide
what a command run through it may touch.

So: pair only your own devices, revoke a device the moment it is lost, and keep the ACL to the two
machines and the one port. Revoking closes that device's stream and terminals immediately and refuses
every later request.

Nothing of MAIN's is copied to the laptop by attaching: not its environment, not its agent logins,
not its model keys, not its provider tokens. The laptop keeps its own.

## Architecture (for people changing it)

```
 laptop                                              MAIN
 ─────────────────────────────                       ─────────────────────────────
 UI ── LocalBackend ── this computer's services      UI ── LocalBackend ── services (files, pty,
    └─ RemoteBackend ──┐                                                       agents, tasks, git)
                       │  HTTPS, pinned cert, signed RPC (existing)              ▲
                       ├─────────────────────────────────────────────────────►  RemoteControlHost
                       │  WebSocket /v1/stream: change notices, pty bytes         (allowlisted ops,
                       ◄─────────────────────────────────────────────────────    project grants)
                       │  WebSocket /v1/tunnel: one per TCP conn to a registered
                       └─────────────────────────────────────────────────────►  127.0.0.1:<port>
                                  all of it inside the Tailscale tunnel
```

- **Transport** (`src/main/tailscale.ts`, `remote-control-server.ts`, `remote-control-client.ts`,
  `remote-stream-*.ts`): Tailscale detection and peer paths; the `'tailscale'` exposure that binds
  only that address; the client that dials it and, for a tailscale pairing, nothing else; the push
  channel with heartbeat, backoff, cursors and generations. Contracts: `src/shared/remote-control.ts`,
  `src/shared/remote-stream.ts`.
- **Host services** (`remote-control-host.ts`, `remote-terminals.ts`, `remote-services.ts`):
  terminals with a bounded output ring buffer and attach-from-offset; registered preview services
  and the per-connection tunnel; host lifecycle (closing the window is not stopping the host).
  Contracts: `src/shared/remote-terminals.ts`, `src/shared/remote-services.ts`.
- **Attachment and decoupling** (`remote-attachment.ts`, `RemoteControlSettings.tsx`, sidebar and
  launcher): remote projects as first-class entries (`ProjectRecord.remote`), the execution target
  shown everywhere, detach/attach with generations, recovery drafts for unsaved remote edits.
- **One machine per project** (`remote-project-adoption.ts`): a paired machine's projects are
  adopted into this computer's list as that machine's the moment it is reached, with the grant
  mapping the adopted row onto the host's own project rather than onto a working copy here. Removal
  is remembered (`remoteProjectsDismissed`) so the next probe does not undo it, and `projects.create`
  makes a project on the other machine rather than pairing two folders.
- **Existing and reused**: pairing (single-use ticket → per-device Ed25519 key → approval with
  project grants → revocation), remote files with revision checks, the session mirror with its
  sequence cursors, tab placement and inheritance.

Identity: pairing is unchanged. The ticket travels between your own machines; approval happens on
MAIN; the device key is what every later request proves. GitHub sign-in in Conductor is the key
registry that pairing already verifies against - it is not a second login - and on the Tailscale
path it is consulted at pairing and, while a peer is active, about every ten minutes to notice a
revoked key (with an hour of grace when GitHub cannot be reached) - never for discovery, presence,
state or transport.

## Standalone: "use this computer independently"

A single action on the laptop. It needs nothing from MAIN and works when MAIN is off, unreachable or
gone: it stops every request, cancels every reconnect, drops every subscription, bumps the attachment
generation so a late reply cannot touch local state, and keeps unsaved remote edits as labelled
recovery drafts. It is remembered across restarts. MAIN is not told and nothing on MAIN changes: work
already running there continues on its own lifecycle, and anything already sent may have completed.

It is not "forget this device" (the pairing stays) and not "become a host" (the laptop accepts no
remote clients unless hosting is turned on there separately). When MAIN comes back, nothing
reattaches by itself.

## Setting up both computers

Two separate sign-ins are involved, and they are not the same step even though both happen to use
GitHub: Tailscale's own sign-in builds the tailnet; Conductor's sign-in is what the device-key
registry that pairing verifies against is built on. Doing one does not do the other.

1. Install Tailscale on both computers from <https://tailscale.com/download>.
2. Sign in to Tailscale on both with the same GitHub account.
3. Confirm both machines show in <https://login.tailscale.com/admin/machines>. If one is missing,
   Conductor has no tailnet address to use on that machine and Tailscale exposure will refuse to
   start there - fix that before touching Conductor.
4. On MAIN, in Conductor: sign in to GitHub (**Account & machines**), turn remote control on, set
   exposure to **Only through Tailscale**, then press **Invite a device**. Conductor hands back a
   single pairing code; the ticket it carries is marked so the machine that redeems it knows to
   reach MAIN over the tailnet and nothing else - no relay key and no relay room travel with it.
5. On the laptop, in Conductor: sign in to the same GitHub account, press **I have an invite**, and
   paste the code.
6. Back on MAIN, approve the request and choose which projects it may open. Projects made on MAIN
   later are shared with the laptop too; any single one can be unshared from the machine's card.
7. On the laptop, MAIN's projects are already in the project list, each marked `Remote: MAIN`. Open
   one and everything in it - files, terminals, agents, tasks - runs on MAIN.

### Which computer a project is on

A project belongs to exactly one computer: the one whose disk holds it. There is no pairing of a
project here with a project there, and no setting that links them - the two machines' lists are
joined, each project keeps the machine it lives on, and work opened in it runs on that machine.

- A project of this computer's runs here. The launcher's **Run on** states that rather than offering
  the other machine.
- A project that lives on MAIN runs on MAIN, from either window.
- Adding a project while a machine is linked asks where it should live: this computer, or MAIN. A
  project made on MAIN is created in MAIN's own projects folder and appears here as MAIN's.
- Removing one of MAIN's projects from this list removes it from the list only - MAIN keeps it, and
  **Account & machines** can show it here again.

To see whether a session is Direct or Relayed, open that machine's diagnostics: the value comes
straight from `tailscale status --json` on this machine (`TailscalePeer.path` in
`src/shared/remote-control.ts`) - `direct` when Tailscale currently holds a live peer-to-peer path,
`relayed` when it is going through a DERP region, and `unknown` before Tailscale has reported
anything. Conductor never estimates this from latency or guesses at it.

### Previews from the laptop

A dev server running on MAIN is reached from the laptop the same way everything else is: through
the paired, signed connection, never through an address. On MAIN, open the project's browser pane,
press **Server** beside the address bar and, under **Preview services**, register the loopback port
the dev server listens on with a label. On the laptop, the browser pane of that project (or of a
tab placed on MAIN) offers **Open on MAIN: <label>**; choosing it opens a loopback port on the laptop
that leads to that one registered port on MAIN and nothing else, and loads it. Hot-reload
WebSockets pass through byte for byte. The page in the pane holds no credential - the device key
that opened the tunnel stays in Conductor's main process - and the pane says **Remote: MAIN** while
it shows MAIN's service, so a laptop preview of MAIN's localhost is never mistaken for the laptop's
own. Detaching, forgetting or revoking closes every tunnel at once.

## Tailscale access policy

`docs/tailscale-policy.hujson` is a fragment, not a tailnet policy of its own. It exists to answer
one question precisely - which device may reach which port on which other device - and to leave
every other choice about your tailnet alone. Merge it rather than replace anything:

1. Open <https://login.tailscale.com/admin/acls> - the tailnet's existing policy lives there, and
   opening this page is itself an admin-console action the owner has to take; Conductor cannot edit
   it for you.
2. Add the fragment's two `tagOwners` entries into your policy's existing `tagOwners` object, and
   its one rule into your existing `acls` array. Do not paste the whole fragment over what is
   already there.
3. Tag MAIN with `tag:conductor-main` and the laptop with `tag:conductor-laptop` from the admin
   console's Machines list (or `tailscale up --advertise-tags=...` on each machine). The fragment's
   comments also show a device-name alternative for an owner who would rather not tag anything.

The rule names one port: Conductor's `DEFAULT_REMOTE_PORT` (`src/shared/remote-control.ts`), `51840`.
An ACL rule that names a port is only meaningful if that port stays put, so MAIN's Conductor has to
be set to a fixed port in **Account & machines** rather than `0` / "let the OS choose" - a port
that moves on every restart cannot be the port a policy names, and the rule would silently stop
matching the listener it was written for.

Do not go further than this for Conductor's sake. Do not enable subnet routes, an exit node, Funnel
or Serve on either machine: none of them are what carries this connection, and each one widens what
the tailnet - not just Conductor - exposes. The fragment's own comments list what it deliberately
leaves out.

## Revoking a device

Conductor's own revoke and Tailscale's own removal are two different systems, and a lost laptop
needs both:

- **Conductor: press Revoke** next to the peer in **Account & machines**, on MAIN. This is
  immediate - the paired device's stream and terminals are closed and every later request from it is
  refused - and it is enforced by MAIN regardless of whether the laptop is even reachable right now
  to be told. It does not remove the laptop from the tailnet: unless the ACL is also changed, a
  revoked device can still address MAIN's Tailscale IP and port, it will simply get nothing back.
- **Tailscale: remove the device** in <https://login.tailscale.com/admin/machines>. This takes it
  off the tailnet entirely, which is the only way to stop it reaching anything else on the tailnet
  besides Conductor - another machine's file share, another service on MAIN's LAN it could otherwise
  route to.

Between the two, MAIN's own GitHub-account check runs at pairing and, independently, about every
ten minutes while that device is active (with an hour of grace if GitHub is unreachable) against the
device-key registry, which is the backstop for a key removed from GitHub outside of Conductor
entirely - it is not a substitute for pressing Revoke, since ten minutes is a long time for a
device you know is lost.

For a lost or stolen laptop, do both, in either order, as soon as you notice.

## Standalone: switching and coming back

The practical version of the "use this computer independently" behavior described above:

- The button is **Disconnect from MAIN and use this computer independently**, next to that
  connection.
- What happens: every pending request to MAIN stops, every reconnect attempt is cancelled, every
  subscription is dropped, the attachment's generation is bumped so a reply already in flight from
  MAIN cannot land on state the owner has moved past, and any unsaved remote edit is kept as a
  labelled recovery draft rather than lost.
- What does not happen: the pairing is not forgotten (MAIN still lists the laptop as a peer, and the
  laptop still lists MAIN), and the laptop does not start accepting remote clients of its own -
  detaching from a host and hosting are unrelated switches.
- It persists. Restarting Conductor on the laptop does not reattach it; it comes back up standalone,
  exactly as it was left.
- Reattaching is a separate, explicit action - **Attach to MAIN** - and nothing does it
  automatically, including MAIN coming back online while the laptop is mid-restart or was detached
  for some other reason. The owner decides when to reattach, every time.

## Two-device smoke test

This needs two real machines on two real networks - a laptop on cellular or a coffee-shop network,
say, and MAIN at home - because that is the one condition automation on a single machine cannot
create. Work through this list on the real hardware before trusting the setup with real work:

1. **A command really ran on MAIN.** From the laptop, open a terminal on MAIN's project and run
   something that only MAIN could answer correctly - `hostname`, or `pwd`/`cd` to print the working
   directory - and check the answer against MAIN's actual hostname and path, not the laptop's.
2. **An edit from the laptop lands on MAIN.** Edit a file from the laptop's window onto the project,
   then check the change is on disk on MAIN itself (not just visible in the laptop's UI).
3. **A dropped connection does not fork the session.** Disable the laptop's Wi-Fi for a few seconds
   mid-conversation or mid-terminal, reconnect, and confirm there is still exactly one shell and one
   agent running on MAIN - not a second one alongside an orphaned first.
4. **Direct vs. relayed reads true.** On a network where the two machines can reach each other
   directly, confirm the diagnostics view says Direct; on a network that forces both through NAT that
   will not traverse (many phone hotspots do), confirm it says Relayed instead, and that either way
   the connection keeps working.
5. **An unpaired device is refused.** From a third machine that was never paired - or the laptop
   itself before pairing - try to reach MAIN's Tailscale address and Conductor port directly, and
   confirm it gets nothing usable back.
6. **A revoked device loses access immediately.** Press Revoke on MAIN while the laptop is mid-use,
   and confirm its open terminal and stream die right there rather than on the next reconnect.
7. **No unintended listener exists.** On MAIN, run `netstat -ano | findstr <port>` for the port set in
   **Account & machines** (`51840` unless changed) and confirm the only listening address shown is
   MAIN's own `100.x` Tailscale address - not `0.0.0.0`, not MAIN's LAN address, not `[::]`.
8. **Standalone works with MAIN unreachable.** Turn MAIN off, or disconnect it from the network, then
   press **Disconnect from MAIN and use this computer independently** on the laptop and confirm it
   still completes and the laptop is usable on its own local projects.
9. **Standalone survives a restart.** Restart Conductor on the laptop while still detached, and
   confirm it comes back standalone rather than trying to reach MAIN.
10. **MAIN coming back does not reattach anything.** Bring MAIN back online and confirm the laptop
    stays detached until **Attach to MAIN** is pressed by hand.

## What automation proves

The automated smoke - `scripts/smoke-multi-device.mjs`, run with `npm run test:multi-device` - starts
two real Conductor instances, both on this one machine, both using
`loopback` exposure rather than a real tailnet - that is what a single CI machine can actually create.
It proves the protocol both sides speak is correct: pairing, project grants, terminal attach-from-
offset and reconnect, file operations under the project grant, tab placement, and that revoke and
detach take effect immediately and cannot be raced by a reply already in flight. It proves nothing
about Tailscale itself - not that the `'tailscale'` exposure actually binds only a real tailnet
address on a real machine, not DERP fallback under a real NAT, not an ACL policy actually enforced by
Tailscale's coordination server. That gap is exactly what the checklist above is for, and it cannot
be closed by anything running on one machine.
