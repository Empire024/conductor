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
- Launch: `spawn(runtime, [host.js], { detached: true, stdio: 'ignore', windowsHide: true })`,
  `unref()`. A second host finding a live lock with a live pid exits at once.

## Protocol (newline-delimited JSON over the pipe, version 1)

Client to host: `hello`, `spawn {runtimeId, executable, args, cwd, env, meta}`,
`send {runtimeId, line}`, `attach {runtimeId, afterSeq}`, `detach {runtimeId, seq}`,
`ack {runtimeId, seq}`, `close {runtimeId}`, `list`, `stopAll`, `shutdown`.
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

## Lifecycle

The host exits by itself once no runtime is alive and no client is connected for 5 minutes
(`CONDUCTOR_RUNTIME_HOST_IDLE_MS`). A client that disconnects without detaching (a crash) takes its
runtimes with it; a detached runtime nobody reattaches within 12 hours is closed. Local model
*servers* already outlive the app (llama.cpp is spawned detached and adopted by its run record).

## Not covered (yet)

- **Local model turns.** The local agent loop runs in the main process, not in a child, so a
  restart still ends a local turn; the server itself survives. Moving the loop into the host is
  a separate item.
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
