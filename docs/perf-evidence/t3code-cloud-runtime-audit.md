# t3code vs Conductor: runtime, streaming and persistence audit (cloud researcher)

Cloud researcher for the Sol controller, 2026-10-29. This is read-only research. I ran no t3code
script, no package manager and no Conductor build, test or smoke. Every claim below comes from
reading source, docs or commit metadata at the pins given here. **None of it is a new
measurement.**

## Pins and limitations

| | Pin |
| --- | --- |
| t3code | [`pingdotgg/t3code@dd148481531a0a090780a2ade20588566db099a2`](https://github.com/pingdotgg/t3code/tree/dd148481531a0a090780a2ade20588566db099a2) (2026-10-29 13:43 -0700, "perf(server): idle servers run 100x fewer background queries and 4.8M fewer spans a day (#27098)"). Shallow clone deepened to 400 commits for history. |
| Conductor | [`empire024/conductor@3f9534920f6950def7eb315e5d3f5706949ed88c`](https://github.com/empire024/conductor/tree/3f9534920f6950def7eb315e5d3f5706949ed88c), the pushed `origin/main` (2026-10-28 00:02 +0100). |

Limitations, explicitly:

1. **The Conductor source here may lag the owner's machine.** AGENTS.md makes routine deliveries
   local commits that are not pushed. Anything committed on MAIN after `3f95349` and not
   published is invisible to me. An item listed below as "remaining" may already be fixed
   locally. The controller should check each "remaining" item against the local `main` before
   dispatching it.
2. **`docs/perf-evidence/t3code-comparison.md` does not exist in any pushed ref.** I checked
   `origin/main`, every `origin/claude/*` and `origin/cloud/*` branch, and every tag; `git grep -i
   t3code` across all remote refs finds nothing. It is presumably an unpublished local file. This
   audit therefore cannot "build on" its text. It stands alone, and is written so its rows can be
   merged into that file by someone who has it.
3. **t3code's performance numbers are its own commit-title claims.** The PR bodies are empty
   (title plus co-author trailer only), and this session's GitHub scope does not include
   `pingdotgg/t3code`, so the PR threads were not read. Each number is quoted as "claimed" and was
   not reproduced.
4. **Conductor's numbers come from its own committed docs** (`docs/perf/*.md`,
   `docs/journal-retention.md`, `docs/conversation-residency.md`, `docs/runtime-host.md`,
   `docs/startup-diagnostics.md`). They were measured on MAIN (Windows, Ryzen 9 7900), not here.
5. **Effort estimates are engineering judgement**, in focused engineer hours including tests.
   They exclude waiting for an owner decision and the overnight perf guards.

Link prefixes: `T:` is t3code at the pin, `C:` is Conductor at the pin.

---

## 1. Architecture at a glance

| Concern | t3code | Conductor |
| --- | --- | --- |
| Where orchestration runs | A separate Node server process. Electron main spawns it with `ELECTRON_RUN_AS_NODE=1` ([T: DesktopBackendConfiguration.ts#L521-L539](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/desktop/src/backend/DesktopBackendConfiguration.ts#L521-L539)). The renderer talks to it over a WebSocket, not through Electron main ([T: apps/web/src/lib/runtime.ts#L61](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/web/src/lib/runtime.ts#L61)). | Electron main owns SQLite, adapters, parsing, the reducer and IPC ([C: docs/ARCHITECTURE.md#L23-L26](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/ARCHITECTURE.md#L23-L26)). The detached runtime host only relays stdio lines ([C: runtime-host/host.ts#L38-L39](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/runtime-host/host.ts#L38-L39)). |
| SQLite driver | `node:sqlite` `DatabaseSync`, wrapped in an Effect client. The writer is on the server event loop, with a **4-worker read-only reader pool** and a **checkpoint worker** ([T: Sqlite.ts#L54-L58](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Sqlite.ts#L54-L58), [T: nodeSqliteClient.ts#L296-L297](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L296-L297)). | `node:sqlite` `DatabaseSync` on Electron main ([C: database.ts#L5](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/database.ts#L5), [#L380-L383](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/database.ts#L380-L383)). Only journal compaction ([C: journal-compaction.ts#L126](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/journal-compaction.ts#L126)) and the boot sampler use a worker. |
| Persistence model | An event log plus normalized projection tables, updated per entity in the same transaction ([T: EventSink.ts#L257-L284](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EventSink.ts#L257-L284)). | An event journal (20,000-event window) plus **one whole-projection JSON snapshot** per conversation ([C: structured-store.ts#L618-L631](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L618-L631)). |
| Live delivery to the UI | A paragraph gate (400 ms, whole blocks), then per-subscriber 50 ms coalescing, then ACK-paced RPC batches ([T: assistantStreaming.ts#L96-L100](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/assistantStreaming.ts#L96-L100), [T: ThreadLiveEventCoalescer.ts#L18-L19](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts#L18-L19)). | A microtask burst flush, then 500-event IPC batches to **every** window ([C: structured-sessions.ts#L2129-L2157](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-sessions.ts#L2129-L2157), [C: index.ts#L2919](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/index.ts#L2919)). The renderer then does rAF and time-sliced ingest. |

The rest of the document is about the consequence: in Conductor, every SQLite statement, its
fsync, and every snapshot stringify competes with the owner's keystrokes, because every key
passes through Electron main ([C: docs/perf/typing-long-conversation.md#L17-L18](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-long-conversation.md#L17-L18)).
**Moving the whole orchestrator out of main the way t3code does is not recommended here** (see
section 6). The ranked items in section 5 take t3code's targeted mechanisms one at a time.

---

## 2. Runtime and session lifecycle

### What t3code does

- **The backend is supervised.**
  - Readiness: polls `GET /.well-known/t3/environment` ([T: DesktopBackendManager.ts#L43](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/desktop/src/backend/DesktopBackendManager.ts#L43)).
  - Restart backoff: exponential, capped at 10 s ([#L35](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/desktop/src/backend/DesktopBackendManager.ts#L35)).
  - Stop: SIGTERM, then SIGKILL after 5 s ([#L41](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/desktop/src/backend/DesktopBackendManager.ts#L41)).
  - Orphan guard: the backend polls `process.ppid` every 2 s and shuts down when the launcher is gone ([T: launcherWatch.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/launcherWatch.ts#L5-L35)).
- **One server per home.** An exclusive SQLite transaction on `server-owner.sqlite` is the lock; the OS releases it even on SIGKILL ([T: serverOwnership.ts#L177-L219](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/serverOwnership.ts#L177-L219)).
- **Session release reasons.** `idle_timeout | runtime_error | manual_shutdown | server_shutdown` ([T: ProviderSessionManager.ts#L65-L70](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L65-L70)).
- **Idle reaper.** Releases a session after 30 min idle. A session with background work is pinned, for at most 4 h ([#L56-L57](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L56-L57), [#L1075](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L1075)).
- **Resume after a restart.** Uses the persisted `nativeThreadRef` (Claude SDK `resume`, Codex `thread/resume`, ACP `session/load`). Restart continuation is capped at 3 per chain ([T: docs/internals/server-updates.md#L66-L98](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/server-updates.md#L66-L98)).
  - **Provider processes do not survive a server restart.** Recovery marks sessions `stopped` and continues the turn from a fresh process.
- **Process-tree cleanup on POSIX.**
  - Claude is spawned `detached` under a `/bin/sh` watcher. When a pipe only the server holds hits EOF, the watcher runs `kill -TERM 0`, then `kill -KILL 0` 5 s later. This also covers a server crash ([T: ClaudeAdapterV2.ts#L326-L359](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L326-L359)).
  - On Linux, agents run in systemd scopes under a per-home slice with `MemoryHigh`/`MemoryMax`. Leftover scopes are stopped at startup ([T: agentScope.ts#L124-L189](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/process/agentScope.ts#L124-L189)).
- **Process caps.** I found no global cap on provider processes. Codex shares one app-server per provider instance; Claude and ACP use one process per thread.

### Conductor at the pin

- **Already stronger than t3code: runtimes survive restart and update.** The runtime host keeps
  Claude, Codex and Grok processes alive across a Conductor restart or update, and replays
  buffered frames after the last ack. The buffer is 16 MiB or 50,000 frames
  ([C: runtime-host/protocol.ts#L9-L10](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/runtime-host/protocol.ts#L9-L10),
  [C: docs/runtime-host.md](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/runtime-host.md#L55-L66)).
  t3code kills and resumes instead. **Nothing to adopt.**
- **Idle release: already present.** `CoworkerAutoClose` frees idle Claude and Codex processes
  after 10 min ([C: coworker-autoclose.ts#L24](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/coworker-autoclose.ts#L24),
  [#L251-L259](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/coworker-autoclose.ts#L251-L259)).
  The host exits after 5 min with nothing live, and closes a runtime nobody reattached after 12 h
  ([C: host.ts#L54-L55](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/runtime-host/host.ts#L54-L55)).
- **Stuck interrupt: already present.** It is force-settled after 5 s
  ([C: structured-sessions.ts#L139](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-sessions.ts#L139)).
  An unstarted turn is requeued.
- **Remaining: POSIX stop is not a tree kill.** Windows uses `taskkill /T /F`, but POSIX only
  does `child.kill('SIGTERM')` on the direct child, with no process group
  ([C: providers/transport.ts#L199-L203](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/providers/transport.ts#L199-L203)).
  This matters for the mac node (`docs/mac-node.md`). It is not a performance item; the risk is
  orphaned MCP and tool grandchildren holding CPU and memory. **Rank 9.**
- **Not applicable: no global cap on cloud-CLI processes.** t3code has none either.
  `docs/machine-profile.md` governs this by policy.

---

## 3. Streaming, latency and main-thread load

### What t3code does

1. **Adapter coalescing on a time window.** Codex assistant text and reasoning flush every 50 ms
   and plans every 400 ms, "to avoid a database write per token"
   ([T: CodexAdapterV2.ts#L209-L211](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L209-L211),
   [#L3247](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L3247),
   [T: ProviderTextDeltaCoalescer.ts#L40](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts#L40)).
   ACP text also flushes every 50 ms.
2. **Paragraph gate before persistence (on by default).** `responseStreamingMode` defaults to
   `"paragraph"` ([T: contracts/settings.ts#L1244-L1246](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/contracts/src/settings.ts#L1244-L1246)).
   A streaming assistant message passes at most once per 400 ms, and only up to a completed
   block ([T: assistantStreaming.ts#L71-L111](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/assistantStreaming.ts#L71-L111)).
3. **Command output never enters the event log.** It goes to `CommandOutputHub`: one bounded tail
   per running command, frames every 100 ms or more, a 16 KiB append cap, and 64 live commands
   ([T: CommandOutputHub.ts#L29-L41](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CommandOutputHub.ts#L29-L41)).
   Clients receive it only while a command row is expanded. The rationale: "a busy command would
   flood the event store and block ingestion for every other thread"
   ([T: docs/internals/performance-regressions.md#L45-L51](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/performance-regressions.md#L45-L51)).
4. **Wire slimming.** Command output is omitted (`outputOmitted: true`), detail strings are capped
   at 32 KiB, and on-demand detail at 256 KiB
   ([T: WireProjection.ts#L26-L28](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/WireProjection.ts#L26-L28),
   [#L168](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/WireProjection.ts#L168)).
5. **Renderer.**
   - The list is virtualized with `LegendList` ([T: MessagesTimeline.tsx#L1301](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/web/src/components/chat/MessagesTimeline.tsx#L1301)).
   - Markdown is parsed incrementally (prefix cached up to the last closed fence) ([T: markdown-incremental.ts#L83](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/web/src/markdown-incremental.ts#L83)).
   - Timeline rows are reused when only the streaming text changed ([T: session-logic.ts#L881-L924](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/web/src/session-logic.ts#L881-L924)). Claimed: "45 → 9 ms" per rebuild and "12 → 0.3 ms" per tool update (commit `29f33af7`).
   - The client cache is not written while a run is active ([T: client-runtime threads.ts#L429](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/client-runtime/src/state/threads.ts#L429)).
6. **Production stall telemetry.** `EventLoopMonitor` logs stalls of 2 s or more to
   `event-loop-stalls.ndjson` ([T: EventLoopMonitor.ts#L22-L29](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/observability/EventLoopMonitor.ts#L22-L29)).

### Conductor at the pin: already fixed

| Fixed | Evidence |
| --- | --- |
| Synchronous `where.exe` on main | In-process PATH lookup, cached for 30 s. Main time in `spawn` went from 46.9 s to 0.24 s per 60 s window ([C: docs/perf/typing-long-conversation.md#L30-L45](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-long-conversation.md#L30-L45), [#L83-L88](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-long-conversation.md#L83-L88)). |
| Snapshot rewritten every burst | At most one checkpoint per second (`CHECKPOINT_INTERVAL_MS`) ([C: structured-store.ts#L26](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L26), [#L605-L617](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L605-L617)). Main checkpoint time went from 2.1 s to 52 ms in the owner-case run. |
| Rendered-card cost | `LIVE_WINDOW = 60` plus `content-visibility` ([C: StructuredAgentPane.tsx#L89](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/StructuredAgentPane.tsx#L89)). This is functionally the part of LegendList that matters for typing cost. |
| Renderer ingest | rAF and time slices, with a 6 ms budget and renders held while the owner types ([C: stream-ingest.ts#L60](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/stream-ingest.ts#L60)). The commit is a `startTransition`, and markdown is memoized per block. |
| Per-fragment tool-input rows | `journal-coalescing.ts` merges tool `inputDelta` and text deltas within a burst. Fragments were 54% of rows before ([C: docs/journal-retention.md](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/journal-retention.md#L23-L45)). |
| Background work at owner priority | Below-normal priority for parked instances, CLIs, the host and delivery steps. Swarm p99 went from +108.6 ms to +6.2 ms over the quiet floor ([C: docs/perf/typing-under-load.md](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-under-load.md#L76)). |
| Composer re-render per key | Uncontrolled textarea. p95 is 11.6 to 12.6 ms at 1 to 26 tabs ([C: docs/perf/typing-long-conversation.md#L114-L127](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-long-conversation.md#L114-L127)). |

### Conductor at the pin: remaining

- **R-S1: deltas are merged only within one synchronous burst, not over time.**
  - `scheduleFlush` is `queueMicrotask` ([C: structured-sessions.ts#L377-L381](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-sessions.ts#L377-L381)).
    So each stdout chunk that arrives in its own tick costs its own `BEGIN…COMMIT`
    ([C: structured-store.ts#L580-L587](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L580-L587)),
    its own journal row(s) and its own IPC broadcast.
  - With WAL at the default `synchronous=FULL`, Conductor's own doc measures "about 8 s of main
    time per minute" with three coworkers streaming
    ([C: docs/perf/typing-long-conversation.md#L98-L104](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-long-conversation.md#L98-L104)).
    It is listed there as **still open**.
  - t3code uses a 50 ms window, plus the paragraph gate.
- **R-S2: Codex command and file-change output deltas are not merged at all.**
  - `item/commandExecution/outputDelta` becomes one `tool` event with `outputMode: 'delta'` per
    notification ([C: providers/codex.ts#L1123-L1128](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/providers/codex.ts#L1123-L1128)).
  - `streamedDeltaKey` only matches `preparing` tool *input* and text deltas
    ([C: journal-coalescing.ts#L19-L31](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/journal-coalescing.ts#L19-L31)).
  - Each such event is journaled, reduced and broadcast to every window. **How big a share of
    rows these are has not been measured.** `docs/journal-retention.md` sampled tool-input
    fragments only.
- **R-S3: every window receives every conversation's events.** `publish` sends each batch to all
  `BrowserWindow`s ([C: index.ts#L2919](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/index.ts#L2919)),
  and each mounted pane filters ([C: StructuredAgentPane.tsx#L376-L379](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/StructuredAgentPane.tsx#L376-L379)).
  The cost is one structured clone per window per batch. With one main window this is small. It
  grows with detached windows. Unmeasured, so **low rank**.
- **R-S4: no steady-state main-thread stall telemetry.** The boot sampler worker's heartbeat
  stops after 5 min ([C: boot-diagnostics.ts#L31-L35](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/boot-diagnostics.ts#L31-L35)).
  After that, a long main-thread stall in the owner's installed app leaves no record. That
  forces perf work to rely on reproductions (`perf-input.mjs`) rather than field evidence, so
  this is **rank 1**: it is cheap and it makes every other rank measurable.

---

## 4. Persistence and bounded reads

### What t3code does

- **Pragmas** ([T: Sqlite.ts#L14-L44](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Sqlite.ts#L14-L44)):
  - `synchronous = NORMAL`, with the comment "FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints. App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption."
  - `temp_store = MEMORY` (commit `a8e41888`, "SQLite temp files no longer block the event loop").
  - `checkpoint_fullfsync = ON` (macOS).
  - `auto_vacuum = INCREMENTAL` on new databases.
  - `journal_size_limit` 32 MiB.
  - It deletes `sqlite_stat1` and runs `ANALYZE sqlite_schema` so the planner prefers indexes.
- **Off-thread SQLite.**
  - The writer turns autocheckpoint off; a worker runs `wal_checkpoint(PASSIVE/TRUNCATE)`. Writers are gated at 10,000 frames ([T: nodeSqliteClient.ts#L490-L492](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L490-L492), [#L500-L560](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L500-L560), [#L807](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L807)).
  - Reads wrapped in `readOnly` go to a pool of 4 read-only worker connections. If a worker is unavailable, reads fall back to the main connection ([#L197-L215](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L197-L215), [#L447-L456](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L447-L456)). Claimed: "up to 5x faster under load" (commit `facaa08b`, which went from one reader worker to a pool).
- **Bounded history.**
  - A cold open or history page stops at about 1 MiB of encoded rows, 10 user turns, 75 items, or 500 turn items ([T: threadHistoryPaging.ts#L15-L22](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/threadHistoryPaging.ts#L15-L22)).
  - Pages are fetched with cursors.
  - Snapshot SQL picks row ids first and fetches payloads after ([T: ProjectionStore.ts#L2914](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProjectionStore.ts#L2914)).
  - Resume replays at most 128 events and 1 MiB, otherwise sends a snapshot ([T: ThreadStream.ts#L18](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadStream.ts#L18)).
  - Budgets are pinned in `test:perf:v2-wire` and a transfer-budget integration test ([T: performance-regressions.md#L1-L72](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/performance-regressions.md#L1-L72)).
  - Known exception: older-page reads still scan each turn item's metadata (no payloads) ([T: ProjectionStore.ts#L5322-L5370](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProjectionStore.ts#L5322-L5370)). t3code is not fully bounded either.
- **Startup does not replay.** "Projections already contain historical terminals; replaying them delays startup…" ([T: Orchestrator.ts#L13117](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Orchestrator.ts#L13117)).
- **Search** uses contentless FTS5 with a trigram tokenizer, maintained by triggers that skip streaming rows ([T: 069_ThreadMessageSearch.ts#L23-L58](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Migrations/069_ThreadMessageSearch.ts#L23-L58)).
- **Reclaiming space.**
  - Superseded-update compaction every 6 h, at about 10% duty (sleeps 9× the work time) ([T: DatabaseStorage.ts#L22](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/DatabaseStorage.ts#L22), [#L104-L110](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/DatabaseStorage.ts#L104-L110)).
  - `incremental_vacuum` of up to 1,024 pages a minute, one page per step with yields ([#L21](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/DatabaseStorage.ts#L21), [#L86-L97](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/DatabaseStorage.ts#L86-L97)).
- **Idle background queries (HEAD commit `dd148481`, read from its diff).**
  - A "due hint" lets idle scheduler ticks skip SQL until the next known due time; every write that can move work earlier invalidates it ([T: ScheduledTaskService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/scheduledTasks/ScheduledTaskService.ts)).
  - Materialized settings and secrets are cached.
  - `page_size`/`auto_vacuum` are cached.
  - Per-candidate settlement spans were removed.
  - Claimed: "100x fewer background queries and 4.8M fewer spans a day".

### Conductor at the pin: already fixed

| Fixed | Evidence |
| --- | --- |
| Startup reads every projection (the OOM outage) | Nothing is read at construction; conversations load on first use. LRU residency budget of 768 MB, a heap guard at 70%, and a source test that every `projection_json` SELECT is `WHERE id=?` ([C: docs/conversation-residency.md](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/conversation-residency.md#L28-L71), [C: structured-store.ts#L38](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L38), [#L386-L399](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L386-L399)). Owner-scale boot: "ready in 1.5-1.7 s with a peak of about 300 MB" ([C: docs/startup-diagnostics.md#L259-L267](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/startup-diagnostics.md#L259-L267)). This is equivalent to t3code's "startup does not replay". |
| Listing parses projections | `summary_json` is written at checkpoint and read for lists. |
| Journal growth from fragments and capability restatements | Coalescing plus a compaction worker that runs off main, with 200-row transactions and pauses between them ([C: journal-compaction.ts#L138](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/journal-compaction.ts#L138)). This is functionally the same as t3code's superseded-update compaction. |
| WAL that stays huge | `journal_size_limit = 64 MiB` and `wal_checkpoint(TRUNCATE)` on close ([C: database.ts#L383](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/database.ts#L383), [#L1769](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/database.ts#L1769)). |
| Unbounded tool output in events | Output over 32,000 characters becomes an artifact plus a 32,000-character tail ([C: structured-sessions.ts#L1993-L1997](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-sessions.ts#L1993-L1997)). The projection is capped at 2,000 items and 64,000-character previews ([C: structured-agent-reducer.ts#L3-L4](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/shared/structured-agent-reducer.ts#L3-L4)). |
| Phone and remote snapshot size | Phone gets 120 items. Remote `agents.snapshot` gets the 60 most recent ([C: remote-control-host.ts#L651-L653](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/remote-control-host.ts#L651-L653)). |

### Conductor at the pin: remaining

- **R-P1: `synchronous` is not set, so WAL runs at FULL.** There is no `synchronous` pragma
  anywhere in `src` ([C: database.ts#L383](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/database.ts#L383)).
  Conductor's doc measures this as the largest open main-thread cost and leaves the choice to the
  owner or controller. t3code made the same trade toward NORMAL and documents why. `temp_store`
  is also unset.
- **R-P2: WAL autocheckpoint runs on main.** It is the default 1,000-page autocheckpoint, run
  inside a writer's commit. Under NORMAL, the fsync moves to these checkpoints, so R-P1 alone
  moves the cost rather than removing it. t3code's checkpoint worker removes it from the event
  loop.
- **R-P3: `events(id, after)` reads up to 20,001 rows, and callers slice the result.**
  - The method itself: [C: structured-store.ts#L685-L688](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L685-L688).
  - Remote `agents.history` calls it with `after` defaulting to 0 and returns `.slice(0, 100)`
    ([C: remote-control-host.ts#L655-L658](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/remote-control-host.ts#L655-L658)).
    That means up to 20,001 `JSON.parse`s on main to return 100. At the journal's measured
    average of 1,041 B per row, that is roughly 20 MB of JSON (arithmetic, not a measurement).
  - The raw-events panel calls `events(activeId)` from 0 and keeps the last 200, **again on every
    phase change** while the panel is open
    ([C: StructuredAgentPane.tsx#L459-L462](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/StructuredAgentPane.tsx#L459-L462)).
  - `CliDrawer` already reads only the tail ([C: CliDrawer.tsx#L48-L49](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/CliDrawer.tsx#L48-L49)). It is the pattern to copy.
- **R-P4: `archive(id)` has no LIMIT.** It reads the whole transcript archive
  ([C: structured-store.ts#L658-L664](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L658-L664)).
  Its caller is transcript export. That is user-initiated and rare, so it ranks low, but it is
  unbounded on main.
- **R-P5: history search scans every snapshot in the project on main.**
  - A history query runs `projection_json LIKE ?` for every non-resident conversation in the
    project, and `JSON.stringify(resident.items)` for every resident one
    ([C: structured-store.ts#L857-L874](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/structured-store.ts#L857-L874)).
  - Projections go up to 10.8 MB; the total was 1.27 GB across 1,666 conversations on 2026-10-22.
    So one search can read on the order of the whole `structured_sessions` table synchronously.
    The duration is unmeasured.
  - The renderer debounces it by 120 ms per keystroke of the query
    ([C: StructuredAgentPane.tsx#L455](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/StructuredAgentPane.tsx#L455)).
  - `searchMessages` also `peek`s (full parse) one conversation at a time until it has 20 groups.
- **R-P6: a pane mount fetches the whole projection.**
  - `structured:snapshot` returns the full projection, up to 2,000 items and MBs
    ([C: index.ts#L1700](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/index.ts#L1700)).
    It is structured-cloned across IPC on every pane mount, and on every rebuild of a suspended
    tab ([C: StructuredAgentPane.tsx#L385-L390](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/renderer/src/panes/StructuredAgentPane.tsx#L385-L390)).
  - The renderer then draws only 60 cards.
  - t3code's equivalent stops at about 1 MiB / 75 rows and pages older history on scroll.
  - The earlier v2 typing doc recorded a tab switch back to a long conversation at "627–935 ms"
    (`docs/verification/2026-09-24-v2-conversation-typing.md`). That predates later fixes, and
    perf-input's tab-switch step currently fails on HEAD
    ([C: docs/perf/typing-long-conversation.md#L111-L112](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/perf/typing-long-conversation.md#L111-L112)).
    So **there is no current number**, and measuring is step one.
- **R-P7: freed pages are never returned.** `auto_vacuum` is off. The 2026-10-23 shrink was an
  owner-approved offline `VACUUM`, 15.85 → 11.54 GB in 239 s
  ([C: docs/journal-retention.md#L64-L90](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/journal-retention.md#L64-L90)).
  This is disk use, not latency. The owner declined *retention trimming*. Incremental vacuum is a
  different thing (it returns already-freed pages), but turning it on needs one more offline
  VACUUM, which is the owner's call.
- **R-P8: whole-projection stringify at checkpoint.** At most once a second per streaming
  conversation. Measured: 3.7 ms for the 1.3 MB wizard projection, and 52 ms of main checkpoint
  time per 60 s owner-case run. **Mitigated; nothing recommended now** (see section 6).
- **R-P9: the agent PTY transcript is rewritten on each flush.** `substr(transcript || ?,
  -750000)` rewrites up to 750 KB per 450 ms flush
  ([C: database.ts#L1403-L1409](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/database.ts#L1403-L1409),
  [C: agent-manager.ts#L841](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/src/main/agent-manager.ts#L841)).
  It only affects terminal-mode CLI tabs. Unmeasured. Low.

---

## 5. Ranked adoption list

The rank weighs Conductor's **own measured evidence** of cost against effort. An item whose cost
has not been measured in Conductor carries "measure first" in its acceptance; it should not be
built on the strength of t3code's claim alone. Each estimate is focused engineer time including
tests. "Owner" marks an item that needs an owner decision before it can ship.

| # | Item | t3code source | Conductor touchpoint | Evidence of cost in Conductor | Estimate |
| --- | --- | --- | --- | --- | --- |
| 1 | **Steady-state main-thread stall log** (R-S4). Keep the boot sampler's heartbeat worker running after boot. Append a stall of 500 ms or more (t3code uses 2 s) to a bounded, rotated `main-stalls.ndjson` with the current boot stage, heap, and the last IPC channel handled. | [EventLoopMonitor.ts#L22-L29](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/observability/EventLoopMonitor.ts#L22-L29) | `src/main/boot-diagnostics.ts` (worker and heartbeat already exist) | Enabling item: there is no field evidence after the first 5 min today | 4–8 h |
| 2 | **`PRAGMA synchronous=NORMAL` + `temp_store=MEMORY`** (R-P1). Add `checkpoint_fullfsync=ON` for the mac node. | [Sqlite.ts#L26-L33](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Sqlite.ts#L26-L33) | `database.ts#L383`, plus the other `DatabaseSync` stores that share the file | Measured: about 8 s of main time per minute with 3 coworkers streaming; listed as still open | 2–4 h (Owner) |
| 3 | **Time-window delta coalescing before persist** (R-S1, R-S2). Hold mergeable deltas for up to 50 ms instead of one microtask. Extend `streamedDeltaKey` to Codex `outputMode: 'delta'` tool output. | [ProviderTextDeltaCoalescer.ts#L40](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts#L40), [CodexAdapterV2.ts#L209](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L209) | `journal-coalescing.ts`, `StructuredSessions.emit`/`flush`/`releaseHeldDeltas` | The same 8 s/min commit cost (a commit per burst). Row reduction is **unmeasured** | 1.5–2.5 days |
| 4 | **Bounded journal reads** (R-P3). `events(id, after, limit)` with SQL `LIMIT`. `agents.history` uses `limit 100`. The raw-events panel reads its tail as `CliDrawer` does and stops re-fetching on each phase change. | [ThreadStream.ts#L18](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadStream.ts#L18) (bounded resume) | `structured-store.ts#L685`, `remote-control-host.ts#L657`, `StructuredAgentPane.tsx#L461` | Arithmetic only: up to 20,001 parses (about 20 MB) to return 100. Unmeasured | 3–5 h |
| 5 | **Checkpoint worker** (R-P2). Writer gets `wal_autocheckpoint=0`; a worker connection runs `wal_checkpoint(PASSIVE)` once 1,000 frames are pending, with a backpressure ceiling and a fallback to autocheckpoint if the worker dies. | [nodeSqliteClient.ts#L490-L560](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L490-L560), [#L807](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L807) | `database.ts`; the worker pattern from `journal-compaction.ts` | Needed so #2 removes the fsync from main instead of moving it to checkpoints. WAL history: 3.49 GB and an 11.5 s recovery ([C: docs/runtime-host.md#L182-L189](https://github.com/empire024/conductor/blob/3f9534920f6950def7eb315e5d3f5706949ed88c/docs/runtime-host.md#L182-L189)) | 1–2 days |
| 6 | **History search off main** (R-P5). Phase 1: run the history query and `searchMessages` in a read-only worker connection, reusing the compaction-worker pattern. Phase 2 (optional): a contentless FTS5 trigram index over message text, maintained at checkpoint, not per delta. | [069_ThreadMessageSearch.ts#L23-L58](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Migrations/069_ThreadMessageSearch.ts#L23-L58), [nodeSqliteClient.ts#L197-L215](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/shared/src/nodeSqliteClient.ts#L197-L215) | `structured-store.ts#L850-L920` | Unmeasured. Up to 1.27 GB of `LIKE` input per search at 2026-10-22 scale | Phase 1: 1.5–2 days. Phase 2: 2–3 days |
| 7 | **Bounded snapshot on pane mount** (R-P6). `structured:snapshot` returns the newest about 1 MiB / 250 items plus a cursor; scrolling up fetches older pages over IPC instead of from a local full projection. | [threadHistoryPaging.ts#L15-L22](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/threadHistoryPaging.ts#L15-L22), [performance-regressions.md#L15-L24](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/performance-regressions.md#L15-L24) | `index.ts#L1700`, `StructuredAgentPane.tsx` paging (`+250` up to 2,000) | Unmeasured today (the old 627–935 ms tab switch predates later fixes; the switch step fails on HEAD) | 3–4 days, after fixing the perf-input switch step (2–4 h) |
| 8 | **Command output outside the journal** (the CommandOutputHub pattern). A running command's output deltas go to an in-memory tail that is sent only to a pane showing that command, throttled to ≥100 ms. The completed tool event keeps the bounded 32,000-character tail plus the artifact. | [CommandOutputHub.ts#L29-L41](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CommandOutputHub.ts#L29-L41) | `codex.ts#L1123`, reducer tool-output handling, `StructuredAgentPane` | **Measure first**: the share of journal rows that are `outputMode:'delta'` has never been sampled. Only do this if #3 leaves them significant. | 3–5 days |
| 9 | **POSIX process-group stop** (mac node). Spawn CLIs `detached` and signal `-pid` (TERM, then KILL after 5 s). In host mode the group belongs to the runtime host, not main. | [ClaudeAdapterV2.ts#L326-L359](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L326-L359), [provider-core processGroup.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-core/src/server/processGroup.ts#L1-L9) | `transport.ts#L199-L203`, `runtime-host/host.ts#L270-L278` | Correctness and resources, not latency. No incident recorded in pushed docs | 6–10 h |
| 10 | **Incremental vacuum** (R-P7). After an owner-scheduled offline `VACUUM` that sets `auto_vacuum=INCREMENTAL`, reclaim up to about 1,024 pages a minute with yields, from the compaction worker. | [DatabaseStorage.ts#L21](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/DatabaseStorage.ts#L21), [#L86-L97](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/DatabaseStorage.ts#L86-L97) | `journal-compaction.ts` worker | Disk only. Measured: an 11.54 GB file after VACUUM, with compaction freeing GBs | 4–6 h, plus an offline run (Owner) |
| 11 | **Archive export paging** (R-P4). `archive(id)` in 1,000-row pages, yielding between them as `conversation-history.ts` already does. | [ProjectionMaintenance.ts#L139](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L139) (paged replay) | `structured-store.ts#L658-L664` | Rare, user-initiated. Unmeasured | 2–3 h |
| 12 | **Idle-tick SQL skip ("due hint")** for schedule and durable-job ticks. | [ScheduledTaskService.ts (dd148481)](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/scheduledTasks/ScheduledTaskService.ts) | `schedule-runner.ts#L42` (30 s tick), `durable-jobs/wiring.ts#L217` (15 s) | **Measure first**. At these tick rates the cost is probably negligible (inference); only worth doing if #1 shows tick-correlated stalls | 3–4 h |

### Acceptance per item

All runs use the existing harness and its rules: parked windows, smoke-lock, and one perf run at a
time (AGENTS.md, `docs/machine-profile.md`).

1. **Stall log**
   - A vitest that blocks main for 800 ms with a busy loop gets exactly one ndjson line with
     `durationMs ≥ 700`. Rotation keeps the file under its byte cap (pick 1 MiB, as `host.log` does).
   - A `smoke-background-windows` pass still succeeds.
   - A 24 h owner run produces a stall file the controller can read (this is the evidence for the
     items below).
2. **`synchronous=NORMAL`**
   - A test opens `Database` and asserts `PRAGMA synchronous` = 1 and `PRAGMA temp_store` = 2.
   - `database-wal.test.ts` still passes.
   - `perf-input.mjs --background=3x20x60 --profile-main` shows main time in the persist commit
     falling from the documented ~8 s/min. Report the measured value, and record it in
     `docs/perf/typing-long-conversation.md`.
   - Owner sign-off on the power-loss trade-off is recorded in the same doc. The trade-off:
     commits after the last checkpoint can be lost on power loss or an OS crash, without
     corruption, and an app crash loses nothing.
3. **Time-window coalescing**
   - Unit tests in `journal-coalescing.test.ts`:
     - Codex output deltas of the same item merge.
     - A held delta is released after at most 50 ms with no other traffic.
     - Any non-delta event, interrupt, `detachForRestart`, quit and `killWhere` flush first and
       keep sequence order.
     - The host `ack` never acknowledges a frame whose delta is still held. Otherwise a restart
       inside the window loses text.
   - A fixture replaying 1,000 stdout chunks of one streamed reply in separate ticks produces
     ≤ 25 journal rows (bound to confirm on the fixture), against about 1,000 today (inference
     from the microtask flush).
   - The perf-input owner case does not regress the time to first visible token by more than
     50 ms p95.
4. **Bounded journal reads**
   - A store test on a 20,000-event journal checks that `agents.history` with `afterSequence=0`
     returns 100 events and that the SQL carries `LIMIT` (source assertion in the style of the
     residency rule).
   - The raw-events panel issues no `structured:events` call on a phase change while its tail is
     current.
5. **Checkpoint worker**
   - A test with 5,000 commits sees `PRAGMA wal_autocheckpoint` = 0 on the writer, the WAL
     returning to ≤ `journal_size_limit` after the worker's pass, and fallback to autocheckpoint
     when the worker is terminated.
   - The main-thread profile in the #2 run shows no `wal_checkpoint` frames.
6. **History search off main**
   - On the owner-scale synthetic profile (`fe79381`'s 3,000 conversations, 1.45 GB of
     projections), a history query with no hits keeps main-thread blocking under 16 ms per
     call, measured with the #1 stall log or a `--profile-main` trace.
   - Results are identical to the main-thread implementation on the existing
     `structured-message-search.test.ts` fixtures.
   - FTS5: a startup probe `CREATE VIRTUAL TABLE … USING fts5` must pass on Electron's bundled
     SQLite before phase 2 starts. **Not verified here.**
7. **Bounded snapshot**
   - Fix the `.pane-tab[data-control-tab-id]` switch step first.
   - Then `perf-input --events=10000` records the IPC payload bytes for `structured:snapshot`
     (≤ about 1 MiB after the change) and the tab-switch time before and after.
   - Scrolling to the top of a 2,000-item conversation still reaches item 1 in order, with no
     duplicates (extend `timeline-render-cost.test.ts`).
8. **Command output hub**
   - First, a read-only sample of the owner's `structured_events` for the share of
     `outputMode:'delta'` rows. **Stop if it is under 10% after #3.**
   - Otherwise:
     - an expanded command shows live output at ≤ 100 ms intervals;
     - a collapsed one sends nothing over IPC;
     - the finished event still carries the 32,000-character tail and the artifact id;
     - a restart through the runtime host still shows the final output.
9. **Process groups**
   - A POSIX-only test spawns a fixture CLI that forks a sleeping grandchild. After
     `transport.close()`, both pids are gone within 6 s, through a direct spawn and through the
     host.
   - Windows behaviour is unchanged (`taskkill /T /F`).
10. **Incremental vacuum**
    - On a copy of a database with `auto_vacuum=2`, the worker's pass reduces `freelist_count`
      by ≤ 1,024 pages per minute.
    - Main shows no `incremental_vacuum` frames.
    - The pass is a no-op when `auto_vacuum` ≠ 2.
11. **Archive paging**
    - Exporting a conversation with 50,000 archived items yields between 1,000-row pages. The
      test asserts there is no single synchronous `.all()` over the archive.
    - The export output is identical to the current one.
12. **Due hint**
    - Only if #1 attributes stalls to ticks. Then an idle tick performs zero SQL statements (spy),
      and a newly created due schedule still runs on the next tick.

Suggested batching for the controller:
- **Batch A:** #1 + #4 + #11. About 1.5 days, no owner decision, independent files.
- **Batch B:** #2 + #5, after the owner chooses NORMAL.
- **Batch C:** #3, which depends on the #1 field evidence or the #2 result.
- **Later, each gated on measurements from A to C:** #6, #7, #8.
- **Any time:** #9 and #10.

---

## 6. Deliberately not recommended

- **Moving the orchestrator into a separate server process (t3code's process model).** It would
  take the reducer, parsing and SQLite off Electron main entirely. But it is a rewrite of
  `StructuredSessions`, IPC, phone and remote hosting, and the runtime-host protocol, measured in
  weeks. Items 2, 3 and 5 attack the documented cost (commit and fsync on main) for days. Revisit
  only if the #1 stall log shows main-thread time dominated by reducer and parsing work that no
  targeted fix can move.
- **Normalized projection tables instead of the whole-projection snapshot.** This is a large
  schema migration of 11 M+ journal rows and 1.3 GB of snapshots. The cost it would remove (R-P8)
  is already mitigated and measured small (52 ms of main per 60 s run).
- **The paragraph gate (400 ms, whole blocks) as a default.** It changes visible streaming
  behaviour, which is the owner's call, not a performance fix. #3's 50 ms window gets most of the
  write reduction without visibly changing streaming (inference; acceptance item 3 measures it).
- **t3code's renderer stack (LegendList, React Compiler, `@pierre/diffs` WASM highlighting).**
  Conductor's 60-card live window and block memoization already reached p95 11.6–12.6 ms typing.
  No Conductor measurement points at virtualization or highlighting as the remaining cost.
- **Process caps.** Neither codebase has a global provider-process cap. Conductor governs this by
  machine policy (`docs/machine-profile.md`) and 10-minute idle release.

---

## 7. Method and cost

- **t3code**: full tree read at `dd14848`, 400 commits of metadata, and the diffs of `a8e41888`
  and `dd148481` read directly. Three read-only research sub-agents covered lifecycle, streaming
  and persistence. I re-checked their key claims by reading the cited lines myself before
  citing them; for example `Sqlite.ts#L14-L44`, `assistantStreaming.ts#L71-L111`,
  `CommandOutputHub.ts#L29-L41`, `ClaudeAdapterV2.ts#L326-L359`, `launcherWatch.ts` and
  `nodeSqliteClient.ts#L296-L297`.
- **Conductor**: `origin/main` at `3f95349`, one read-only sub-agent, and direct reads of every
  "remaining" citation above: `remote-control-host.ts#L655-L658`, `structured-store.ts` reads,
  `StructuredAgentPane.tsx#L459-L462`, `codex.ts#L1123-L1128`, `transport.ts#L190-L204` and
  `structured-sessions.ts#L2129-L2157`.
- **Token usage**:
  - The four sub-agents reported 222,374 + 212,602 + 248,093 + 304,725 = **987,794 tokens**.
  - The main conversation's session token counter fell by about **245,000** by the time of the commit. No
    input/output/cache split is available.
  - **Dollar cost: unknown** (not exposed to this session).
- Nothing was executed from either repository, and no application code was changed. Only this
  document was added.
