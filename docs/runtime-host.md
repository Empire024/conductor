# Runtime host: native runtimes survive a Conductor restart

Owner's item `e1610f01`: restarting or updating Conductor must not kill running Claude, Codex or
Grok runtimes, and quitting asks whether to keep them running in the background. After the next
launch the app reattaches to them and their turns carry on in their tabs with no lost events.

## Why not a Windows service

A service needs admin rights to install, runs as another account (so it cannot see the owner's
CLI logins under `%USERPROFILE%`), and is shared by every Conductor profile. What is needed is a
process that outlives the Electron main process, per user and per `userData`. A detached child
with a lock file is exactly that.

## Why the host runs from a copied runtime

The NSIS installer (`app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh`)
kills every process whose image lives under `$INSTDIR`, and every process named `Conductor.exe`.
A host started as `Conductor.exe` with `ELECTRON_RUN_AS_NODE=1` would die on every update, and a
host reading its script out of `app.asar` would keep the archive open so the installer could not
replace it. So a packaged app copies the Electron runtime it needs into
`<userData>/runtime-host/runtime-<electron version>/conductor-runtime-host.exe` (the exe plus
`icudtl.dat`, `ffmpeg.dll`, `snapshot_blob.bin`, `v8_context_snapshot.bin`, about 210 MB, once
per Electron version) and the host bundle into `<userData>/runtime-host/host-<sha>.js`. A
development checkout runs `process.execPath` directly. Provider CLIs live outside `$INSTDIR`, so
the installer leaves them alone too.

## Process and files

- Host bundle: `src/main/runtime-host/host-main.ts`, bundled by esbuild into
  `out/main/runtime-host.js` from `electron.vite.config.ts` (a self-contained CommonJS file with
  only `node:` imports, so a copy of that one file runs anywhere).
- Lock file: `<userData>/runtime-host/host.json` `{ pid, pipe, secret, protocol, startedAt }`,
  written by the host once it listens. `userData` is per-user, so is the secret.
- Pipe: `\\.\pipe\conductor-runtime-host-<sha256(userData) prefix>`; every connection must open
  with `hello {secret, protocol}` or it is dropped.
- Log: `<userData>/runtime-host/host.log` (bounded, rotated at 1 MiB).
- Launch: on Windows through PowerShell's `Start-Process` (ShellExecuteEx), so the host inherits
  none of the app's handles. A plain `spawn` from Node always passes inheritable handles, and
  Chromium's listening sockets are inheritable: a host started that way kept the old app's
  `--remote-debugging-port` after the app was gone, so the relaunched app never answered on it
  (FX16). If PowerShell fails, `spawn(..., { detached: true, stdio: 'ignore' })` as before. A second
  host finding a live lock with a live pid exits at once. A running host from an older build
  (its `hello` lacks one of `RUNTIME_HOST_FEATURES`) is replaced at launch when it keeps nothing
  running; one that keeps a turn stays, without the newer features, until it next goes idle.

## Protocol (newline-delimited JSON over the pipe, version 1)

Client to host: `hello`, `spawn {runtimeId, executable, args, cwd, env, meta}`,
`send {runtimeId, line}`, `attach {runtimeId, afterSeq}`, `detach {runtimeId, seq}`,
`ack {runtimeId, seq}`, `close {runtimeId}`, `list`, `stopAll`, `shutdown`, `relay {key, servers}`
(a host whose `hello` lists the `mcp-relay` feature; see below).
Requests carry an `id`; the host answers `{op: 'result', id, ok, value | error}`.

Host to client: `frame {runtimeId, seq, stream: 'stdout' | 'stderr', data}` (stdout split into
whole lines, stderr as text chunks) and `exit {runtimeId, seq, code, signal, error?}`. `seq` is
per runtime, starts at 1 and never repeats.

Every runtime is owned by at most one client. Frames go to the owner while it is attached; the
host also keeps every frame after the last `ack` in a bounded buffer (16 MiB or 50 000 frames).
`detach` records the last sequence the client processed; a later `attach {afterSeq}` replays the
buffered frames after it, in order, and then streams live. When the buffer overflowed the oldest
frames are dropped and `list` reports `lostFrames`; the reattach says so in the conversation.
`close` ends the child and its tree (`taskkill /T /F`). A runtime that exits stays listed with its
exit frame buffered until a client attaches and acks it, or until the idle timeout.

## Main process

- `transport.ts` keeps its interface. When `setRuntimeHost(client)` has installed a connected
  client, `JsonLineTransport.start()` spawns through the host instead of `child_process`; with no
  client (setting off, host unavailable, tests) it spawns directly exactly as before. The adapter
  code does not change for spawning. A runtime started before the host connects (the first
  moments after launch) runs inside the app and is not kept.
- A hosted transport can `detach()` (stop listening without killing) and can be created from an
  existing handle: `TransportOptions.attach = {runtimeId, seq}` (the last frame handled). It acks
  what it handled every 500 ms so the host can drop it.
- `ProviderAdapter.detach()` returns `{ state, transport }` or `null`. `state` is the adapter's
  own fields (Maps and Sets included, see `providers/adapter-state.ts`); each adapter names the
  fields holding promises, timers or callbacks, and any other value that cannot be written down
  refuses the detach instead of being dropped. An adapter with a host call in flight (a hook, a control
  request, an RPC awaiting its answer) first waits up to 3 s for it to settle; if it will not,
  the runtime is not detachable and is stopped as before.
- `AdapterOptions.attach = {state, transport}` makes `start()` restore that state and attach to
  the running process instead of spawning and handshaking. The first buffered frame is then
  processed exactly as it would have been live, so the structured store keeps assigning
  monotonic sequence numbers and nothing is duplicated.

## Quit, restart and update

`StopConfirmations` answers with `'background' | 'stop' | 'cancel'`. With a running conversation
turn and a connected host, the dialog offers **Keep running in background** (the default),
**Stop all** and **Cancel**. A restart or update started by a wizard tab or the owner credential
(`force`) keeps running work without asking. `app.quit.confirm({stopWork: true})` still means stop
and `false` cancel; the open dialog lists its `choices`. Terminal CLI tabs are not hosted and stop.

Keeping work: `StructuredSessions.detachForRestart()` detaches every conversation whose turn is in
flight (or has background work), unless it is in the middle of a host-side step (submit, steer,
view switch, queue dispatch, native steering acceptance). Its record goes into the one settings
key `runtimeHost:detached` (`{[agentSessionId]: {runtimeId, provider, adapter: {state,
transport}, live, at}}`) and the conversation is dropped without emitting `disconnected`. Idle
runtimes are stopped as before; they reconnect their native conversation lazily.

## Reattach on launch

After app control is up and before the windows open, main joins the running host (never starting
one for this) and calls `list`. Each kept record whose runtime is listed is rebound with
`StructuredSessions.reattach(id)`: the same `runtimeId`, so pending approvals and temporary
permissions stay valid. The store's load marks every in-flight conversation `disconnected`, expires
its approvals and interrupts its running tools (an app that stopped normally ended its turns), so
the attached adapter restates what is still live: running tools, pending interactions and its
phase. Buffered frames then arrive and are handled exactly as if live. A record whose runtime is
gone is dropped and the conversation marked `disconnected` (native resume as before).

A reattached turn still holds the old process's app-control endpoint and credential, so it is sent
one steering message with the new briefing. A reattached wizard is not resumed a second time by
the restart-initiator logic. Reattached conversations without an open tab appear in `agents.list`
as orphans. After reattaching, main starts (or joins) the host for new runtimes and closes any
host runtime nobody owns: its app crashed, so no adapter state exists to continue it.

## Tools after a reattach (FX16)

A kept Claude or Codex process keeps calling back into Conductor while it runs: tool hooks
(Claude `hook_callback`) and approvals (Claude `can_use_tool`, Codex `requestApproval`) travel on
its stdio, which the host already relays and buffers; its MCP tools (the browser view and
`conductor-local`) are HTTP servers in the app on a new port with new bearer tokens every launch.

- Hooks: a hosted Claude CLI registers its hooks with a 900 s timeout instead of 15 s, so a hook
  sent while no app runs (an update install, then the new process's slow first minute: 45 s + 55 s
  on 2026-09-25) waits in the host for the next app instead of failing every tool call of the turn.
  The adapter still answers within 15 s itself, or fails the hook (the tool is not run).
- Approvals have no provider-side timeout; the reattached adapter restates them and the answer
  goes out through the host.
- MCP: the host runs a loopback HTTP relay (`runtime-host/relay.ts`). An adapter whose process is
  hosted registers its MCP servers under its own `relayKey` and gives the process the relay's
  address and a per-route token instead of the app's. The address and token last as long as the
  host. On reattach the adapter registers again with the new app's servers; a request that
  arrives while no app owns the route waits for it (up to 10 min), and a server the new app no
  longer gives the conversation is refused. The relay forwards bytes with the app's own
  credential, so the app's server still decides every call.

`scripts/smoke-fx16-restart-tools.mjs` restarts a parked app under a streaming turn whose stand-in
CLI sends a hook and calls both MCP servers while no app runs, and checks that the relaunched app
answers on its debugging port.

## Lifecycle

The host exits by itself once no runtime is alive and no client is connected for 5 minutes
(`CONDUCTOR_RUNTIME_HOST_IDLE_MS`). A client that disconnects without detaching (a crash) takes its
runtimes with it; a detached runtime nobody reattaches within 12 hours is closed. Local model
*servers* already outlive the app (llama.cpp is spawned detached and adopted by its run record);
local *turns* pause and resume instead (below).

## Local model turns: paused at a safe point, not hosted

Item `local-turns-survive-restart`. The llama.cpp server already outlives the app; the agent loop
(`src/main/local-models/agent.ts`) runs in the main process. Two designs were possible: (a) run
the loop in the host as its own runtime kind, or (b) pause it at a safe point and resume it after
the relaunch. **(b) is the one built**, because it is much smaller and it is correct:

- The loop already writes a durable checkpoint (task state, transcript, budgets, and the
  identity of every mutation it ran) to the conversation's settings key before every request,
  before every tool call and after every result. A restart only needs a pause point on top.
- (a) would move the tools, the Docker sandbox, the artifact hooks (`beforeTool`/`afterTool`)
  and the `localControl` bridge into the host. The host bundle is deliberately `node:`-only and
  protocol-agnostic, and every one of those calls reaches back into main, so (a) would need a
  second RPC channel from the host into a main process that is gone during the restart.
- Nothing is lost by pausing: the model server keeps its weights loaded, so the resumed request
  costs one prompt re-evaluation (llama.cpp's prompt cache usually covers most of it).

How it works:

- `LocalAdapter.detach()` aborts the turn with a `LocalTurnSuspension` reason and waits up to 5 s
  (`LOCAL_PAUSE_SETTLE_MS`) for the loop to reach its next safe point. Events the turn reports
  meanwhile are held, not shown. Every stop path in the loop (`finish('interrupted')`) writes
  the pause point instead: `{id, ledger, finalText, processing}` beside the task state in the
  same checkpoint, with the lifecycle left `running`. The detachment names that id. Its
  `transport.runtimeId` is `local:<runtimeId>`, which the host never lists.
- **In mid-generation**, the partial reply was never stored, so the resumed run sends the same
  request again. The tab keeps the text it had already streamed, as a separate item above the
  resumed reply. **During a tool call**, the call is stopped. Its result in the transcript says it
  was interrupted by the restart and will not be run again, and its id is recorded as executed, so
  it cannot be replayed. Calls later in that round get "Interrupted before execution". The round
  counts as taken. **During the acceptance command**, the run is not treated as a verdict and
  runs again after the resume. **Before the model was reached** (the server still loading), the
  detachment carries the prompt and the turn starts again from it.
- The pause point holds the run ledger: segment, stage, request count, evidence, the
  stagnation detector (`StagnationDetector.snapshot()`), truncated calls and the finish phase.
  The resumed run carries on in the same segment. No round is lost and none is taken twice.
- If the turn finishes by itself while it is being paused, or does not settle in 5 s, `detach()`
  returns null. The held events are shown and the runtime is stopped as before.
- On launch, `reattachKeptRuntimes` does not ask the host about a local record: it calls
  `reattach` directly. `LocalAdapter.start()` with `attach` restores the session from the
  checkpoint and checks that its pause point is the one the detachment names. If it is not,
  nothing is replayed and the conversation is marked disconnected. Otherwise the adapter shows the
  held events and a notice ("paused after tool round N and continues here"). It then runs the turn
  under its original `turnId`, with fresh item ids for the new text. It is not re-briefed about
  app control, because a local model reaches app control only through the in-process
  `localControl` bridge.
- **It resumes only when it may.** The conversation must still exist
  (`detachedRuntimes()` skips deleted specs). Its model must still be loaded or loadable: the
  resumed turn goes through `ready()`, so `ensureServer` applies the one-server rule of
  `docs/machine-profile.md` under the admission lock. If that fails, the tab shows why, the turn
  ends failed, and the progress up to the pause stays saved. The owner's next message continues
  from it, as after any stop.
- A pause point is used once: the next ordinary checkpoint drops it. If the app does not
  reattach (it crashed, or the detached record was lost), the restored task reads as blocked,
  and the next message starts a turn instead of resuming the old one.
- The quit dialog's **Keep running in background** covers local turns through the same
  `detachForRestart()`, and so does a forced (wizard or owner credential) restart. Like the other
  runtimes, this needs the runtime host setting on. Time spent while Conductor is closed still
  counts against the task's cumulative time budget.

Tests: `src/main/local-models/restart-resume.test.ts` (pause mid-generation and mid-tool, no
replay, one-shot pause points, detector snapshot) and `src/main/providers/local.test.ts` (adapter
detach and reattach in a new instance, same turn, one prompt). `scripts/smoke-local-restart.mjs`
runs the built app parked, with a stand-in llama.cpp endpoint through the unpackaged
`CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT` override, calls an owner `app.restart` during round 2,
and checks that the relaunched app sends that same request once more and completes the turn.

## Not covered (yet)

- **Crash reattach.** After a crash no adapter state exists, so orphaned runtimes are closed.
- **Browser MCP after reattach.** The CLI keeps the previous process's browser-tool endpoint;
  browser tools come back with the conversation's next runtime.
- **Status bar indicator and a "Stop background runtimes" command.** While the app runs every kept
  runtime is reattached into its tab, so there is nothing separate to show yet; both need a
  renderer surface outside this item's files.

## Setting and tests

`runtimeHost` (settings table, `'on'`/`'off'`), default on. An automation profile
(`CONDUCTOR_TEST_USER_DATA`) defaults to off; `CONDUCTOR_RUNTIME_HOST=1`/`0` overrides both. Off:
no host is started and every transport spawns directly, exactly as before.

`src/main/runtime-host/host.test.ts` covers the protocol with fake runtimes; `reattach.test.ts`
restarts the app mid-turn for Claude and Codex and checks every event arrives once, in order.
`scripts/smoke-runtime-host.mjs` does it with the built app: an owner `app.restart` mid-turn, the
relaunched app attached to the same provider process, the turn finishing in its tab.
