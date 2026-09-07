# Claude Code adapter compatibility

Recorded 2026-09-07. This file records implementation and verification separately. Synthetic tests do not establish live-provider parity.

## Local reference and authentication

- Installed `claude --version`: **2.1.263 (Claude Code)**.
- Installed official VS Code extension: **anthropic.claude-code-2.1.263-win32-x64**.
- Executable discovery returned the native Windows `.exe`; the adapter uses argument arrays, `shell: false`, an explicit cwd, and separate stdout/stderr.
- No separately installed Agent SDK dependency was found in Conductor. The official extension contains the SDK bridge implementation matching its packaged CLI.
- Connection mode is **local CLI**, using the owner's existing CLI authentication/configuration. Conductor neither reads OAuth tokens nor creates an API client. The inherited CLI can itself be configured for subscription login, an API key, or a supported enterprise provider; the adapter does not switch that route or infer it from dollar telemetry.
- **Live verification blocked:** the owner reported that Claude usage allowance is exhausted. No Claude inference was submitted during this implementation; neither acceptance prompt A nor B ran. This is not a green live test.

`ClaudeAdapter` explicitly requires the tested **2.1.263** baseline. An untested executable version is rejected before any prompt is sent. Broadening this gate requires updating the baseline, checking the installed bridge, and rerunning the contracts. The application should expose unsupported controls as unavailable capabilities, not as working GUI parity.

## Supported integration and evidence

| Feature | Mechanism and implementation | Verification | Remaining gap |
| --- | --- | --- | --- |
| Full-duplex transport | CLI `--print --input-format stream-json --output-format stream-json --verbose`, partial messages and `--permission-prompt-tool stdio`; initialize response awaited before accepting input | Fixture-verified, including an actual Node child process | Live blocked by quota |
| Native coding-agent configuration | No generic system prompt, `--bare`, settings-source override, SDK auth environment, or credential extraction; native CLI defaults load coding prompt, CLAUDE.md, policy and applicable user/project/local configuration | Argument contract verified; installed help inspected | Effective user-specific hook/MCP behavior not live-verified |
| Streamed Markdown source | `stream_event` message/content identities and text deltas, then authoritative assistant snapshots | Fixture-verified, including repeated identical chunks and UTF-8 fragmentation | Renderer/Electron verification belongs to integrated QA |
| Tool inputs and results | Native `tool_use.id`/`tool_result.tool_use_id`; input JSON accumulates separately; complete input remains preparing; `tool_progress` confirms running; results replace previous output snapshots | Fixture-verified interleaving, nonzero exit, native tool names, nested parents | No genuine incremental command stdout available in this adapter; output capability is false |
| Approvals | `can_use_tool` request ID; `control_response` with `behavior`, unchanged `updatedInput`, and native `toolUseID`; allow once, deny, or abort only | Fixture-verified both directions and duplicate/stale rejection | Session/persistent permission scopes intentionally absent; live approval unverified |
| Questions | `AskUserQuestion` via permission callback; answers map original question text to labels/free text; original questions retained | Fixture-verified multi-select and validation | New extension-only user dialog kinds are reported unsupported; not silently approved |
| Selected images | Documented native streaming user content blocks with base64 PNG/JPEG/GIF/WebP; backend canonical workspace checks, byte-sniffed media type, bounded file-descriptor reads, 3 MiB per file / 4 MiB total message | Fixture-verified wire format and path/size rejection using synthetic bytes | Live image interpretation untested; animated formats use the runtime's supported first-frame behavior |
| Edit artifacts | Registered SDK `PreToolUse`, `PostToolUse`, `PostToolUseFailure` callbacks; host snapshot awaited before acknowledgement; callbacks run for auto-approved operations too | Fixture-verified lifecycle and callback ordering | Only observed Edit/Write/NotebookEdit/MultiEdit file paths; shell writes and externally concurrent edits are not universally attributable |
| Tool failure | Native `is_error`, structured exit code and interrupted metadata where available | Fixture-verified; missing metadata remains absent | Runtime-specific results without structured exit code cannot provide one |
| Stop | Native `interrupt` control request, `cancel_queued: true`; request acknowledgement keeps interrupting state until result/disconnect | Fixture-verified | A disconnect leaves execution uncertain and never triggers automatic prompt replay |
| Continuation/resume | Keep stream input open across turns; use saved native `session_id` and explicit `--resume` on a new runtime | Fixture-verified identity and startup arguments | Live contextual continuation unverified; conversation fork UI absent |
| Model/permission/planning | `set_model` and `set_permission_mode` acknowledged before next user input; default/acceptEdits/plan remain distinct; read-only rejected | Fixture-verified actual control frames | Claude read-only execution sandbox is not supplied by these modes; effort changes require explicit resumed runtime |
| Plans/tasks/background | Native TodoWrite post-hook becomes plan steps; task system events and forwarded subagent message parents remain native | Implemented; nested tool parent fixtures verified | Task-specific lifecycle and execution-transition UI need integrated evidence; no extra model calls for labels/summaries |
| Models/commands/config discovery | Cached `discover()` returns initialize response and system/init payload without runtime calls; model choices come from returned metadata | Fixture-verified models and no-call discovery | No native configuration editor, hooks/plugin manager, MCP status editor, or arbitrary slash-command dispatcher in this adapter |
| Usage | Per-turn native token counts; runtime-cumulative cost becomes estimated per-result deltas, with the original total preserved in native metadata | Fixture-verified cumulative accounting and missing values | Cost is computed from a bundled price table, not authoritative billing or subscription quota |
| Native file checkpoints | Public rewind capability exists, separate from Conductor snapshots | Unsupported in this adapter | No universal rollback claim; native coverage excludes Bash edits and most subagents |
| Hosted/browser/extension-only workflows | Retain user CLI configuration; do not impersonate the extension or invent hosted endpoints | Unsupported in GUI | Cloud delegation, remote-control/extension-specific dialogs, browser commands and native fork/checkpoint controls need separately supported implementations |

## Official references checked

- [CLI reference](https://code.claude.com/docs/en/cli-reference): streaming flags, permission modes, resume, settings, effort, hook event and forwarded subagent flags. Installed `claude --help` was checked against this documentation.
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): supported local CLI entry point and conversation handling.
- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output): partial events are followed by complete messages; input completion is not command execution.
- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): native image/base64 user content blocks alongside text, without a separate upload API.
- [Vision formats and limits](https://platform.claude.com/docs/en/build-with-claude/vision): PNG/JPEG/GIF/WebP; Conductor's local message limits are stricter than the applicable provider limits.
- [Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input): native permission decisions and question answer formats.
- [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks): real tool lifecycle callbacks and tool-use identity.
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions): native session continuation.
- [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking): in streaming input, tokens cover one main-agent turn while total_cost_usd accumulates across the runtime call, including subagents; costs are client-side estimates. The installed extension replaces its displayed total with the latest result rather than summing results.
- [File checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing): Bash and subagent coverage limitations.
- [Official Python SDK bridge source](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py): initialize `hookCallbackIds`, control request/response and hook callback wire envelopes. These formats were cross-checked against the locally installed official extension's bundled SDK. No extension-private hosted endpoints are used.

## Offline reproduction and extension guidance

Run `npm.cmd test -- src/main/providers/claude.test.ts src/main/providers/claude-ui-fixture.test.ts`. The final adapter suite has **19 passing tests** plus **2 passing raw process/controller/store tests**. Image tests use synthetic file headers to validate wire routing and safety checks; they are not proof of live image interpretation. The fixture `scripts/fixtures/claude-runtime.mjs` is marked synthetic, does no inference and does not execute tool text or write workspace files.

Integrated offline result after this slice: `npm.cmd test` **200 passed / 34 files**; `npm.cmd run typecheck` passed. Shared tests include strict persisted live-budget thresholds, a 90-second cumulative active-runtime clock with a separate 30-second cumulative human-wait allowance, legacy terminal history retained once without creating native context, project relocation, no-start replay, stale request/runtime exclusion, and conflict-safe artifacts. Final UI/build/release results belong in `conductor-agent-ui-qa.md`.

`scripts/fixtures/fake-claude.mjs` is the separately gated Electron fixture. With `CONDUCTOR_OFFLINE_TESTS=1`, fixed `SYNTHETIC A` input produces raw text/tool/hook/approval frames, edits only the exact two fixture declarations after approval, and executes the local dependency-free Node test once. `SYNTHETIC B` is explicitly fixture continuation, not evidence of model memory. Two raw-process tests pass through the production adapter, controller, SQLite journal, and immutable artifacts, covering allow/deny, exact two-line deletion, actual test exit 0, explicit native resume, and local undo. No sanitized live capture exists because live testing is blocked by quota.

The documented CLI fork path combines `--resume` and `--fork-session`, then reports its native fork ID while processing the next explicit user query. The initialize response does not document a standalone fork ID/RPC. The newer public SDK also offers a session-store `forkSession` utility, but Conductor has no public SDK dependency and does not import extension-private internals. Therefore the current immediate `fork(): Promise<string>` control remains unsupported for this CLI adapter; no hidden user prompt is sent to materialize a fork. Conversation reset commands `/clear`, `/reset`, and `/new` are rejected before dispatch because they change native identity; create a new Conductor conversation instead.

For a new event mapping, add it to the Claude adapter using actual native IDs and lifecycle evidence. Preserve unknown payloads as inspectable notices. Add a raw protocol test and assert the shared replay projection, not only an isolated render prop. A tool input declaration must remain preparing until native progress or completion; permission callbacks must never stand in for the execution feed. Keep a new tool renderer separate from protocol handling and send backend actions through the existing validated bridge.
