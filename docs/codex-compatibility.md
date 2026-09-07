# Codex adapter compatibility baseline

Recorded 2026-09-07. This document separates implementation from verification. It is not a claim of complete VS Code extension parity or a successful live turn.

The inspected local runtime reports `codex-cli 0.153.4`. The executable is a native Windows `codex.exe` under the owner's installed OpenAI Codex program directory. `codex login status` reported **Logged in using ChatGPT**. No token, credential file, inherited environment, or account secret was inspected. The adapter uses this user-managed CLI connection, not an Agent SDK/API connection. It does not change account or billing configuration. No OpenAI/Codex VS Code extension directory was present under the inspected `C:/Users/stilj/.vscode/extensions`; its local extension version is therefore **unavailable**, not inferred from the CLI version.

Official documentation was opened on 2026-09-07. The supplied App Server and IDE feature URLs redirected to [App Server](https://learn.chatgpt.com/docs/app-server) and [Codex IDE extension](https://learn.chatgpt.com/docs/codex/ide). The former identifies the bidirectional rich-client interface and initialization sequence; the latter identifies editor context, focused edit review, and delegation workflows. Exact wire details below come from the installed executable's generated schema, because current documentation includes fields that differ from this version.

## Reproduce the protocol baseline

```powershell
codex --version
codex login status
codex app-server generate-ts --experimental --out src/main/providers/generated/codex
codex app-server generate-json-schema --experimental --out src/main/providers/generated/codex/schema
npx.cmd vitest run src/main/providers/codex.test.ts
```

`node scripts/generate-codex-protocol.mjs` performs the two generation steps after requiring version 0.153.4. Generated files must not be edited manually. The generated bundle includes experimental types for compile-time checking; that does **not** enable experimental protocol behavior. `initialize.capabilities.experimentalApi` defaults to false. Plan controls require `CONDUCTOR_CODEX_EXPERIMENTAL=1` and exact runtime 0.153.4. Other 0.153.x patch versions receive a visible unverified-version limitation and experimental features remain disabled. Other minor versions fail connection with a recoverable compatibility error.

SHA-256 of the generated baseline (before Git line-ending normalization):

| File under `src/main/providers/generated/codex` | SHA-256 |
| --- | --- |
| `ClientRequest.ts` | `83418E6F3F8100FA59B0324AFAAF45C8D258DB3DD42A10769D9C337C93B910F2` |
| `ServerNotification.ts` | `DFD31C72D1319F069FCDF124BCAE6368F15AA0DD0033350BF15519D3E3556D54` |
| `ServerRequest.ts` | `1C5837ADBFBDD005F387478BA87840808D1353B47B82DCF63739A78BB1C8D3BE` |
| `schema/codex_app_server_protocol.v2.schemas.json` | `E5F798FD1343C539F01FEDEA0E8A84A43C080FCCA4615C80EB04A5EDAB4F7D0A` |

## Mappings and evidence

All rows reference CLI protocol 0.153.4 and the uninstalled/unknown local extension version. UI entry points refer to the integrated Structured Agent pane. `fixture-verified` means an actual local synthetic child process spoke raw JSONL to the production adapter; it does not mean OpenAI inference occurred.

| Feature / mechanism | Native implementation and entry point | Verification / remaining gap |
| --- | --- | --- |
| Initialize / initialized / thread start | Adapter awaits initialize response, sends initialized, then starts one thread. Send composer | Fixture-verified handshake ordering and single startup across concurrent callers |
| Thread resume | `thread/resume` by exact native ID, excludes old turns; Resume action | Fixture-verified: no turn or prompt replay; active thread with unavailable turn identity fails explicitly |
| Assistant streaming | `item/agentMessage/delta`, authoritative item snapshots; Markdown timeline | Fixture-verified fragmented UTF-8, repeated chunks, final snapshot reconciliation |
| Readable reasoning summaries | `item/reasoning/summaryTextDelta` and summary snapshots; subdued status text | Implemented; no separate live evidence. Raw reasoning text is neither requested nor rendered |
| Command execution | Native command, cwd, parsed actions, aggregated output, exit code and duration; IN/OUT card | Fixture-verified interleaved commands, genuine synthetic process output, failed exit code. Protocol output is merged stdout/stderr; no invented split |
| File edits | `fileChange` items plus `patchUpdated`; compact immutable patch cards | Fixture-verified exactly two removed lines, proposed/applied/rejected states, rename mapping. The host can reconstruct immutable versions only after verifying the provider patch against bytes; undo remains unavailable when reconstruction fails |
| Turn diff | `turn/diff/updated`; inspectable aggregate activity | Fixture-verified, kept separate from per-tool edit totals |
| Approvals | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`; exact request card actions | Fixture-verified accept, deny, duplicate submission, stale runtime rejection, supported decision list. Fake runtime executes the edit once only after approval |
| Permissions tool | `item/permissions/requestApproval`; requested subset with turn/session choices | Implemented from generated response type; live unverified |
| Questions | `item/tool/requestUserInput`; structured form mapped to `{answers:{id:{answers:[value]}}}` | Fixture-verified required IDs, offered choices, exact response. Native nonblocking question metadata does not block session state |
| Interrupt | `turn/interrupt`; Stop button | Fixture-verified acknowledgment is not completion, native interrupted event is required, stale dialogs expire |
| Models/effort | `model/list`, actual `turn/start.model/effort`; composer settings | Fixture-verified discovered catalog and per-model effort validation. Initial effort list is baseline guidance until runtime discovery |
| Sandbox/approval policy | Exact per-turn request fields; permission selector | Fixture-verified read-only and workspace-write mappings, restoring initial effective default. The inherited default preserves native configuration |
| Plans | `turn/plan/updated`; plan card. Gated `turn/start.collaborationMode`; Plan mode | Fixture-verified plan/default transition, explicit default mode after native resume, and native built-in mode instructions via null override. Experimental opt-in required |
| Attachments | Native localImage plus exact text context fragments; removable composer chips | Deterministic test verifies images, CRLF selection content and Unicode/spaced paths. No implicit repository attachment |
| Usage/limits | `thread/tokenUsage/updated`, `account/rateLimits/updated`; usage activity | Token mapping fixture-verified. Missing dollar cost/quotas remain unknown; no conversion of subscription quota to dollars |
| Nested agents | `collabAgentToolCall` and `subAgentActivity`; parent-correlated nested activity | Native mapping implemented, no live evidence. Mapping retention bounded |
| MCP/custom tools | Native MCP/dynamic item declarations/results; safe registry fallback | Mapping implemented; no host re-execution. MCP elicitation and delegated dynamic tool execution are unsupported and return explicit JSON-RPC errors |
| Unknown events | Native method/payload retained as inspectable notice | Fixture-verified unknown event and late output retention; late chunks do not append after authoritative completion |
| Session fork/rename/archive | Native `thread/fork`, `thread/name/set`, archive/unarchive; session controls | Fixture-verified: distinct fork identity, no user turn, child unsubscribed for explicit resume. Active turns and native goals block a history-only fork; no filesystem restore occurs |
| Checkpoints/rollback | Public methods exist in schema | Native GUI gap: local history display does not rewind native context |
| Commands/skills/config/MCP/plugins/hooks | Runtime configuration inherited; explicit `discover()` reads skills, local plugins and MCP status | Discovery fixture-verified without a model turn or tool execution. Configuration mutation/management GUI remains incomplete; inventory is not full management parity |
| Cloud/browser/hosted workflows | Provider-specific events retained | Native control gap; no private endpoints, token extraction, or invented hosted integration |

## Verification record

`npx.cmd vitest run src/main/providers/codex.test.ts`: **20 passed** on Windows, including explicit execution-mode restoration after native resume. Test teardown awaits child exit before deleting its disposable working directory. The child is Node running `scripts/fixtures/codex-app-server.mjs`, not a provider. `npm.cmd run typecheck`: passed at the final bounded adapter audit. Full application checks and release evidence belong in `conductor-agent-ui-qa.md`.

`scripts/fixtures/fake-codex.mjs` is the fixed explicit offline Electron entry point. `SYNTHETIC A` requests file approval, mutates only the disposable fixture after acceptance, executes `node --test panel.test.mjs` locally, and reports captured exit/output. `SYNTHETIC B` is labeled synthetic continuation. Neither is live-provider evidence. Model ID `synthetic-model` is not a real model. The integrated live suite subsequently submitted A exactly once through Conductor using discovered gpt-5.6-luna/low. A real approval arrived, but the harness rejected the literal quoted rg fixture search before responding. No edit/test ran; B was skipped. The captured request is reproduced offline in `scripts/fixtures/captured/codex-0.153.4-quoted-rg-approval.json`. Live round-trip approval, execution, usage and conversation recall remain unverified; see `conductor-agent-ui-qa.md`. No live retry was made.

The first real UI connection preflight failed before any native thread or user prompt because Codex's dotted CLI override parser treated quote characters as part of an MCP server name. The sanitized observed stderr is retained in `scripts/fixtures/captured/codex-0.153.4-invalid-mcp-key.json`. The corrected launcher uses simple unquoted key segments and rejects dot/quote names rather than guessing an escape syntax. `scripts/inspect-codex-isolation.mjs` then passed against the installed executable using only initialize/configuration/skill metadata methods: both optional MCP servers were disabled; six skill-disable overrides were prepared; zero threads and zero user turns were started. This metadata check does not claim that a model turn or applied per-thread skill override was live-verified.

Live isolation is explicit and process-local. The installed CLI exposes `--disable` flags, and the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents per-server enablement, per-skill enablement, and memory controls. `CONDUCTOR_LIVE_TESTS=1` requires an approved model/authentication mode and applies temporary launch overrides for optional features, web search, notifications, memories and named MCP servers. Before thread creation, native configuration/requirements/account/model/skill metadata must verify the expected connection, disabled optional integrations and allowed model. Managed integrations or unknown skill scopes block the suite; administrator skills and inherited policy remain intact. Per-path optional skill overrides apply only through the live thread's config, including resume. No user configuration file is written. A native retry notification triggers interruption, with an explicit limitation that an in-flight retry may already have begun.

## Add a mapping safely

Use the generated `ServerNotification`, `ServerRequest`, and `ThreadItem` discriminants in `codex.ts`. Preserve native thread/turn/item/request IDs in the event envelope and keep provider payloads inspectable. A complete item must emit a snapshot using the same identity as its deltas. A server request must reserve its response before sending and offer only supported answers. Add raw messages to the explicit synthetic process and assert the adapter event or outgoing response. Never execute a provider-owned tool in the renderer or host merely because its declaration arrived.
