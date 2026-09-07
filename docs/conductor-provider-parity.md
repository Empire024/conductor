# Conductor provider parity ledger

Compatibility baseline inspected 2026-09-07. This ledger separates implementation from verification; no full-parity claim is made. Integrated offline validation passed, but Codex live A failed before its approval was answered, B was skipped, and Claude live is blocked by quota. Core parity is not release-qualified; no main push/release has been made. See `conductor-agent-ui-qa.md` for the release gate and exact executed checks.

## Baseline and boundaries

| Provider | Installed runtime | Reference extension | Connection/authentication |
| --- | --- | --- | --- |
| Claude Code | 2.1.263 | Local `anthropic.claude-code-2.1.263-win32-x64` | Native local CLI, inherited user-managed authentication; no SDK/API client or OAuth-token extraction. Exact-version bridge gate. |
| Codex | codex-cli 0.153.4 | Official Codex IDE documentation; extension not installed in the inspected VS Code profile | Native local App Server over stdio. `codex login status` reports ChatGPT. Generated 0.153.4 protocol checked in; compatible 0.153.x accepted with unverified-version notice. |

The actual stack is Electron 37, React 19, TypeScript, Node SQLite (`node:sqlite`, WAL), Monaco, xterm/node-pty, Git, Vite, Vitest, and newly added Playwright. Existing `AgentManager` owns structured controllers as well as the remaining providers' PTYs. No second process is launched by an event inspector, pane subscription, or history restoration. Qwen/Kimi/Gemini and PowerShell retain their existing terminal interfaces.

Codex initialization is `initialize` response → `initialized` → thread start/resume. Experimental planning is disabled unless `CONDUCTOR_CODEX_EXPERIMENTAL=1` and the exact generated baseline matches. Claude preserves its coding CLI prompt, working directory, configuration sources, organizational policy, tools, and native permissions. It uses the installed CLI/official extension control protocol, including the stdio permission bridge and real lifecycle hook callbacks. See `claude-compatibility.md` and `codex-compatibility.md` for wire evidence and constraints.

Implementation labels: **native**, **native partial**, **fallback-only**, **unsupported**, **unknown**. Verification labels: **fixture-verified**, **live-verified**, **manually verified**, **blocked**, **failed**, **untested**. A native partial feature does not count as completed extension parity.

## Feature inventory

Every Claude row references extension/CLI 2.1.263; every Codex row references CLI/schema 0.153.4 and the official IDE page inspected above.

| Feature | Provider mechanism / constraint | Conductor implementation and UI entry | Implementation | Evidence / remaining gap |
| --- | --- | --- | --- | --- |
| Transcript and tools | Claude stream events, assistant/user tool blocks, IDs and parent tool IDs | Default Claude pane, Markdown and IN/OUT tool registry | native | Raw child-process fixtures; Claude live blocked by owner-reported quota. Tool output is result delivery, not fabricated streaming. |
| Transcript and tools | Codex item started/completed and text/output deltas | Default Codex pane; exact commands, output, exit status when supplied | native | Raw process and actual Electron fixtures passed; real A text/command/approval declaration observed. A failed in the harness before execution; no completed live turn. |
| Edits and immutable review | Claude PreToolUse/PostToolUse snapshots; Codex authoritative fileChange patches | File change card → Click to expand; Monaco inline/side-by-side, navigation, copy patch, current file | native | Fixtures count exactly two deletions, CRLF/Unicode and multiple hunks. Patch reconstruction requires exact reverse/forward verification; otherwise patch-only limitation. |
| Approval vs review | Claude can_use_tool; Codex requestApproval variants | Exact request/scope card; provider-issued decision choices; separate Keep and Undo | native | Raw runtime and actual Electron accept/deny/cancel tests; Keep never writes. A real Codex approval arrived, but the harness stopped before answering; live round trip unverified. |
| Structured questions | Claude AskUserQuestion updatedInput; Codex requestUserInput answer map | Question fieldsets and answer submission | native | Fixture-verified. Unknown elicitation/custom-control methods are explicit unsupported notices, never invented responses. |
| Cancellation | Claude interrupt control; Codex turn/interrupt and terminal turn status | Stop button; interrupting remains until native acknowledgement/completion | native | Fixture-verified, including stale responses/disconnect. No success implied by sending cancellation. |
| Session ownership | One backend resource per Conductor ID; native IDs separate | Any number of subscribing pane views | native | Fixture-verified controller and actual Electron reload, close/retrieve, split and detached-window retrieval; unchanged native identity and prompt count. |
| History/search/rename/archive | Conductor SQLite projection/search; native controls when exposed | History and Session settings | native partial | Fixture-verified local search/metadata and native Codex thread/name/set, archive/unarchive; Claude local metadata only. External CLI history import remains a gap. |
| Resume | Claude --resume native ID; Codex thread/resume exact native ID | Resume conversation / Resume connection | native | Fixture-verified; read-only restore never automatically reconnects. A disconnected uncertain turn is not resent. |
| Fork | Codex thread/fork; Claude CLI supports a separate session fork surface | Supported native fork in Session settings | native partial | Codex thread/fork fixture-verified with distinct native ID and immutable history copy, no inference. Claude immediate fork unsupported: CLI materializes its fork ID only with a subsequent explicit query; no hidden query sent. |
| Checkpoints | Claude provider checkpoint APIs have tool/shell/subagent coverage limits; Codex rollback is context, not general file rollback | Conductor immutable snapshots/Undo only | unsupported (provider checkpoint controls) | No universal rollback claim. Claude Bash edits, unknown binary/oversized files and external concurrent writes remain uncovered. |
| Editor context | Explicit files, selected ranges, draft content, diagnostics, terminal selection | Attach file; Code pane attach actions; PowerShell selection action | native | Backend workspace validation and bounded context; actual submitted text retained. No whole-repository attachment by default. |
| Images/attachments | Codex localImage; Claude native base64 PNG/JPEG/GIF/WebP blocks | Attach file context accepts workspace image paths; inspectable/removable image chips | native | Fixture-verified native mapping, byte sniffing and bounded canonical paths. No implicit images, external-path authorization picker or live image verification. |
| Models/effort | Native model discovery, Codex per-turn model/effort; Claude model control and resume-required effort | Connect provider → Session settings | native | Fixture-verified turn fields; Electron model/effort controls and explicit resume tested. Live A selected Luna/low and received a native turn acknowledgement. No inference for discovery. |
| Permissions/sandbox/planning | Native policy controls; Codex sandbox distinct from planning; Claude has no equivalent read-only sandbox | Session settings: separate permission, execution sandbox, approval policy, planning and effort controls | native partial | Independent Codex execution sandbox and approval selectors reach actual per-turn fields; effective settings inspectable. Codex plan/default transition fixture-tested behind exact-version experimental opt-in; Claude read-only sandbox not offered. Dedicated feedback/execute review remains a gap. |
| Plans/tasks | Claude TodoWrite actual hooks; Codex plan events | Structured plan rows | native partial | Fixture events verified; provider-specific task-list controls are incomplete. |
| Skills/commands | Native Claude initialize command metadata; Codex skills APIs | Session settings → Provider commands and configuration inspector; existing app command palette remains local | native partial | On-demand native discovery fixture-verified without a turn. A dedicated execution picker remains a gap; the inspector explicitly does not execute commands or mutate configuration. |
| Memory/configuration | Native configuration inheritance; existing Conductor durable project memory | Existing Memory dock, Settings, exact context in user event | native partial | Native configuration is preserved; dedicated per-scope editing/discovery of provider memory remains incomplete. |
| MCP/plugins/hooks | Native inheritance; Claude SDK-control lifecycle hooks supplement existing hooks | Session settings → Provider commands and configuration; existing provider configuration inherited | native partial | Native skills/plugin/MCP inventory inspector implemented and fixture-verified. Management controls and MCP elicitation remain incomplete. No private hosted integrations. |
| Usage/limits | Claude usage/cost fields; Codex tokenUsage/rateLimits | Timeline usage row and inspectable limits | native | Token/rate-limit mappings fixture-verified; native quota metadata inspected. Live A yielded no usage event: tokens/cost unknown. Claude cumulative costs are delta-accounted estimates, not subscription charges. |
| Subagents/background tasks | Native parent IDs, Claude task events, Codex collaboration thread IDs | Nested activity rows | native partial | IDs/events preserved and fixture-tested; cross-session background steering controls incomplete. |
| Cloud/browser workflows | Official public cloud/browser paths vary by product/runtime | Existing Browser workspace surface preserved | fallback-only / unknown | Native hosted delegation/history and extension-only workflows are not implemented; browser preview is not equivalent to provider browser tooling. |
| Workspace orchestration | Existing persistent agents, coworker coordination, memory, routines/jobs and handoffs | Existing Automation/Memory/Processes docks and pane system | native existing | Existing regression suite retained. Structured facts feed coworker observation; no summarization agent added. |
| Raw inspection / real terminal | Structured stdout is protocol, PowerShell remains node-pty | Events inspector versus separate PowerShell pane | native | Opening Events does not create a terminal/process or send input. |

## Durability and security

Schema v1 events have Conductor session/runtime/project/workspace identities, native conversation/turn/item/request/parent correlation, local sequence and timestamp. SQLite stores sanitized events and periodic deterministic projections; private immutable artifacts retain original bytes for restore. The reducer is pure and bounded. Unknown events remain inspectable. Replay cannot call a runtime or filesystem API.

IPC checks a known Conductor window, exact trusted renderer URL and main frame, request type, session identity, supported decision scope and runtime incarnation. Files require lexical and canonical workspace checks including junctions/symlinks. Provider processes are launched with argument arrays and separate stdout/stderr, bounded newline/UTF-8 framing and owned-process cleanup. Pending input/approval is expired on disconnect. Undo checks expected post-change bytes, uses per-path host locking and rechecks immediately before write; external writers do not participate in a universal OS compare-and-swap, so this remaining race is stated explicitly.

## Official references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) — rich-client protocol, generated schema, events and requests.
- [Codex IDE](https://learn.chatgpt.com/docs/codex/ide) — reference workflow inventory; installed extension version unavailable.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) — configuration layers and per-server disable controls.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [headless integration](https://code.claude.com/docs/en/headless).
- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), [user input](https://platform.claude.com/docs/en/agent-sdk/user-input), [sessions](https://platform.claude.com/docs/en/agent-sdk/sessions), [file checkpointing](https://platform.claude.com/docs/en/agent-sdk/file-checkpointing).
- [Claude VS Code extension](https://code.claude.com/docs/en/vs-code).

## Extending the implementation

Add native protocol mappings only in the owning adapter, with raw fake-process evidence. Emit `AdapterEvent` facts with native identity; let `StructuredSessions` assign the durable envelope. Add categories to `structured-agent.ts` and the pure reducer, then register native tool-name presentation in `StructuredAgentRenderers.tsx`. Keep execution in the runtime. Never make a renderer execute a tool, resolve an approval from display text, or read today's bytes for an old diff.
