# Codex adapter compatibility baseline

Recorded 2026-09-07 against `codex-cli 0.153.4`; rebaselined 2026-09-21 to `codex-cli 0.155.1` (see "Rebaseline 0.153.4 → 0.155.1" below). This document separates implementation from verification. It is not a claim of complete VS Code extension parity or a successful live turn.

The inspected local runtime reports `codex-cli 0.155.1`. The executable is a native Windows `codex.exe` under the owner's installed OpenAI Codex program directory. `codex login status` reported **Logged in using ChatGPT**. No token, credential file, inherited environment, or account secret was inspected. The adapter uses this user-managed CLI connection, not an Agent SDK/API connection. It does not change account or billing configuration. No OpenAI/Codex VS Code extension directory was present under the inspected `C:/Users/stilj/.vscode/extensions`; its local extension version is therefore **unavailable**, not inferred from the CLI version.

Official documentation was opened on 2026-09-07. The supplied App Server and IDE feature URLs redirected to [App Server](https://learn.chatgpt.com/docs/app-server) and [Codex IDE extension](https://learn.chatgpt.com/docs/codex/ide). The former identifies the bidirectional rich-client interface and initialization sequence; the latter identifies editor context, focused edit review, and delegation workflows. Exact wire details below come from the installed executable's generated schema, because current documentation includes fields that differ from this version.

## Reproduce the protocol baseline

```powershell
codex --version
codex login status
codex app-server generate-ts --experimental --out src/main/providers/generated/codex
codex app-server generate-json-schema --experimental --out src/main/providers/generated/codex/schema
npx.cmd vitest run src/main/providers/codex.test.ts
```

`node scripts/generate-codex-protocol.mjs` performs the two generation steps after requiring version 0.155.1 (`CODEX_PROTOCOL_BASELINE` in `src/main/providers/codex.ts`). Generated files must not be edited manually. The generated bundle includes experimental types for compile-time checking; that does **not** enable experimental protocol behavior. `initialize.capabilities.experimentalApi` defaults to false. Plan controls require `CONDUCTOR_CODEX_EXPERIMENTAL=1` and exact runtime 0.155.1. Other 0.155.x patch versions receive a visible unverified-version limitation and experimental features remain disabled. Other minor versions fail connection with a recoverable compatibility error.

To move the baseline to a new CLI minor: bump `expected` in the generator and `CODEX_PROTOCOL_BASELINE` plus the `/^0\.<minor>\./` gate in `codex.ts`, regenerate, then diff the bundle against the committed one (the request/notification/item unions are single lines, so split them on ` | ` before diffing). Anything the adapter reads or sends that moved must change in `codex.ts` and in `scripts/fixtures/codex-app-server.mjs` together; then run the contract suite and `node scripts/inspect-codex-baseline.mjs` against the live executable.

SHA-256 of the generated baseline (before Git line-ending normalization):

| File under `src/main/providers/generated/codex` | SHA-256 |
| --- | --- |
| `ClientRequest.ts` | `38C6718F0F5AADA55187788547DF6756189035C6E23D6DD6F2D5B0F5D6828416` |
| `ServerNotification.ts` | `711F5014883DA724EEFE4AB1151CA6A0425C8FF8D5DE5480F773626EC7228F4B` |
| `ServerRequest.ts` | `1C5837ADBFBDD005F387478BA87840808D1353B47B82DCF63739A78BB1C8D3BE` (unchanged since 0.153.4) |
| `schema/codex_app_server_protocol.v2.schemas.json` | `F82D3752F35E2F16348E4CDD59E774855C79B4D8903B70187C4EFEAB9722263C` |

The 0.153.4 hashes were `83418E6F…B910F2`, `DFD31C72…556D54`, `1C5837AF…C8D3BE` (unchanged) and `E5F798FD…4F7D0A` respectively; the full values remain in this file's Git history.

## Rebaseline 0.153.4 → 0.155.1

Regenerated 2026-09-21 from the installed `codex-cli 0.155.1`. The whole delta was read member by member; nothing the adapter sends or reads was removed, renamed or re-typed on the wire. 49 generated files changed and 55 were added; `ServerRequest.ts` and every item-union, `turn/start`, `turn/interrupt`, `model/list`, approval-request/response, `AskForApproval`, `SandboxMode` and `collaborationMode` type is byte-identical to 0.153.4.

| Change in 0.155.1 | Adapter consequence |
| --- | --- |
| New client methods `userVerification/{status,enroll,delete,verify,cancel}`, `thread/attachment/{add,list,remove}`, `memory/status` | Not called. |
| `account/rateLimits/read` params: `undefined` → optional `{ supportsLunaReserve?, excludeResetCreditDetails? }` | The adapter still sends no params; live `--usage-only` inspection confirms the response. Neither flag is set, so no Luna Reserve exposure is recorded. |
| `GetAccountRateLimitsResponse.ordinaryUsageAllowed: boolean \| null` and `RateLimitSnapshot.normalModelSlug: string \| null` added | Ignored by the mapping (usage still comes from `primary`/`secondary` and per-limit buckets); fixture emits both. |
| New server notification `thread/attachment/updated` | Falls into the unknown-event path and is retained as an inspectable notice. |
| `Thread.environments`, `Thread.originator`, `Thread.daybreakEnabled` added (all nullable) | Not read. `thread/start`, `thread/resume`, `thread/fork`, `thread/read` and `thread/started` shapes are otherwise unchanged. |
| `PermissionsRequestApprovalParams.cwd` and `GuardianApprovalReviewAction` paths: `AbsolutePathBuf` → `LegacyAppPathString` | Both aliases are `string`; the adapter never reads `cwd` on a permissions request. |
| `McpServerElicitationRequestParams` gains mode `openai/userVerification` | MCP elicitation stays unsupported and is answered with an explicit JSON-RPC error, as before. |
| `McpServerStatus.toolsError`, `ConfigRequirements.application`, `BrowserUseRequirements.allowWebmcp`, `ThreadListParams.originators`, `ThreadMetadataUpdateParams.daybreakEnabled`, `FeedbackUploadResponse.promptHash`, `ResponseItem` variant `configuration_update` | Not read or sent. |

No product decision was needed: no 0.153.4 behaviour the adapter relies on was withdrawn. The two new usage-read flags (`supportsLunaReserve`, `excludeResetCreditDetails`) and `ordinaryUsageAllowed` are available for a later usage feature but deliberately left unused here.

## Mappings and evidence

All rows were recorded against CLI protocol 0.153.4 and re-verified against the 0.155.1 fixture on 2026-09-21 (none of the shapes they rely on changed); the local extension version remains uninstalled/unknown. UI entry points refer to the integrated Structured Agent pane. `fixture-verified` means an actual local synthetic child process spoke raw JSONL to the production adapter; it does not mean OpenAI inference occurred.

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
| Sandbox/approval policy | Exact per-turn request fields; composer mode selector | Fixture-verified mapping of the four composer modes onto Codex's own `/permissions` presets: Ask inherits the CLI configuration, Read only, Edit (the CLI's "Auto": workspace work unprompted, an approval request to leave it) and Auto (never asks, so it also carries network). Writes stay inside the workspace in every mode; a settings-dialog override still wins over the mode |
| Plans | `turn/plan/updated`; plan card. Gated `turn/start.collaborationMode`; Plan mode | Fixture-verified plan/default transition, explicit default mode after native resume, and native built-in mode instructions via null override. Experimental opt-in required |
| Attachments | Native localImage plus exact text context fragments; removable composer chips | Deterministic test verifies images, CRLF selection content and Unicode/spaced paths. No implicit repository attachment |
| Usage/limits | `thread/tokenUsage/updated`, `account/rateLimits/updated`; usage activity | Token mapping fixture-verified. Missing dollar cost/quotas remain unknown; no conversion of subscription quota to dollars |
| Nested agents | `collabAgentToolCall` and `subAgentActivity`; parent-correlated nested activity | Native mapping implemented, no live evidence. Mapping retention bounded |
| MCP/custom tools | Native MCP/dynamic item declarations/results; safe registry fallback; in Auto the thread starts with every enabled, unset MCP server's `default_tools_approval_mode = auto` | Mapping implemented; no host re-execution. MCP approval under Auto live-verified 2026-09-22 (section below). MCP elicitation and delegated dynamic tool execution are unsupported and return explicit JSON-RPC errors |
| Unknown events | Native method/payload retained as inspectable notice | Fixture-verified unknown event and late output retention; late chunks do not append after authoritative completion |
| Session fork/rename/archive | Native `thread/fork`, `thread/name/set`, archive/unarchive; session controls | Fixture-verified: distinct fork identity, no user turn, child unsubscribed for explicit resume. Active turns and native goals block a history-only fork; no filesystem restore occurs |
| Checkpoints/rollback | Public methods exist in schema | Native GUI gap: local history display does not rewind native context |
| Commands/skills/config/MCP/plugins/hooks | Runtime configuration inherited; explicit `discover()` reads skills, local plugins and MCP status | Discovery fixture-verified without a model turn or tool execution. Configuration mutation/management GUI remains incomplete; inventory is not full management parity |
| Cloud/browser/hosted workflows | Provider-specific events retained | Native control gap; no private endpoints, token extraction, or invented hosted integration |

## Verification record

Rebaseline 0.155.1, 2026-09-21: `npx tsc --noEmit` passed against the regenerated bundle without adapter type changes. `npm.cmd run test:agent-contracts`: **13 files, 305 tests passed** (`codex.test.ts` **42 passed**, fixture reporting `codex-cli 0.155.1`), plus the live-acceptance guard. `npm.cmd run build` passed. Live, metadata-only, zero threads and zero turns: `node scripts/inspect-codex-baseline.mjs` against the installed 0.155.1 executable returned the same five-model catalog and effort ladders as the 0.153.4 capture (GPT-6-Astra default), and `--usage-only` returned one `codex` bucket through `account/rateLimits/read` with the response shape the adapter maps. `codex login status` still reports **Logged in using ChatGPT**. No live turn was submitted; live round-trip evidence below is unchanged.

`npx.cmd vitest run src/main/providers/codex.test.ts` (0.153.4 record): **20 passed** on Windows, including explicit execution-mode restoration after native resume. Test teardown awaits child exit before deleting its disposable working directory. The child is Node running `scripts/fixtures/codex-app-server.mjs`, not a provider. `npm.cmd run typecheck`: passed at the final bounded adapter audit. Full application checks and release evidence belong in `conductor-agent-ui-qa.md`.

`scripts/fixtures/fake-codex.mjs` is the fixed explicit offline Electron entry point. `SYNTHETIC A` requests file approval, mutates only the disposable fixture after acceptance, executes `node --test panel.test.mjs` locally, and reports captured exit/output. `SYNTHETIC B` is labeled synthetic continuation. Neither is live-provider evidence. Model ID `synthetic-model` is not a real model. The integrated live suite subsequently submitted A exactly once through Conductor using discovered gpt-5.6-luna/low. A real approval arrived, but the harness rejected the literal quoted rg fixture search before responding. No edit/test ran; B was skipped. The captured request is reproduced offline in `scripts/fixtures/captured/codex-0.153.4-quoted-rg-approval.json`. Live round-trip approval, execution, usage and conversation recall remain unverified; see `conductor-agent-ui-qa.md`. No live retry was made.

The first real UI connection preflight failed before any native thread or user prompt because Codex's dotted CLI override parser treated quote characters as part of an MCP server name. The sanitized observed stderr is retained in `scripts/fixtures/captured/codex-0.153.4-invalid-mcp-key.json`. The corrected launcher uses simple unquoted key segments and rejects dot/quote names rather than guessing an escape syntax. `scripts/inspect-codex-isolation.mjs` then passed against the installed executable using only initialize/configuration/skill metadata methods: both optional MCP servers were disabled; six skill-disable overrides were prepared; zero threads and zero user turns were started. This metadata check does not claim that a model turn or applied per-thread skill override was live-verified.

Live isolation is explicit and process-local. The installed CLI exposes `--disable` flags, and the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents per-server enablement, per-skill enablement, and memory controls. `CONDUCTOR_LIVE_TESTS=1` requires an approved model/authentication mode and applies temporary launch overrides for optional features, web search, notifications, memories and named MCP servers. Before thread creation, native configuration/requirements/account/model/skill metadata must verify the expected connection, disabled optional integrations and allowed model. Managed integrations or unknown skill scopes block the suite; administrator skills and inherited policy remain intact. Per-path optional skill overrides apply only through the live thread's config, including resume. No user configuration file is written. A native retry notification triggers interruption, with an explicit limitation that an in-flight retry may already have begun.

## Add a mapping safely

Use the generated `ServerNotification`, `ServerRequest`, and `ThreadItem` discriminants in `codex.ts`. Preserve native thread/turn/item/request IDs in the event envelope and keep provider payloads inspectable. A complete item must emit a snapshot using the same identity as its deltas. A server request must reserve its response before sending and offer only supported answers. Add raw messages to the explicit synthetic process and assert the adapter event or outgoing response. Never execute a provider-owned tool in the renderer or host merely because its declaration arrived.

## MCP tool approval under Auto (2026-09-22)

codex-cli 0.155 gates every MCP tool call on the server's `default_tools_approval_mode` (or the tool's own `approval_mode`; the values are `auto | prompt | writes | approve`). Left unset, the call "requires approval", and under `approval_policy = never` Codex does not ask, it refuses: `MCP tool call requires approval, but approval policy is never`. Conductor's Auto is exactly `never` (plus workspace-write and network), so after the 0.155 rebaseline every Auto conversation lost its MCP tools — the Conductor browser, chrome-devtools, node_repl — while Edit (`on-request`) kept them.

Live probe against the installed CLI: one stub loopback MCP server with a single read-only tool, model gpt-5.6-sol at low effort, read-only sandbox, one turn each.

| Thread config | Turn policy | Result |
| --- | --- | --- |
| server unset | `never` | the model reports the tool as unavailable; no call reaches the server |
| server `default_tools_approval_mode = "auto"` | `never` | the tool call runs and its result is returned verbatim |
| server unset | `on-request` | the read-only tool runs without any approval request |

Also verified: a nested `{ mcp_servers: { name: {…} } }` entry in `thread/start.config` merges with the CLI's own `mcp_servers` table (chrome-devtools and node_repl stayed listed by `mcpServerStatus/list` next to the added server), and the dotted key form is accepted too.

The adapter therefore reads `config/read` once before `thread/start` or `thread/resume` when the persisted mode resolves to `never`, and passes `default_tools_approval_mode = "auto"` for every enabled server the owner left unset plus the Conductor browser; a server or tool mode written in config.toml is kept, and nothing is written to the CLI configuration. Because this is thread configuration, structured-sessions reconnects the same native conversation when the owner's mode crosses the never-asks boundary in either direction, exactly as it does for the browser toggle, and the adapter says so when a `never` turn reaches a thread that was connected in an asking mode. `effectiveSettings.mcpToolApproval` shows which way the current thread was started. Bundled Codex plugins (`codex_apps`, `cua_repl`) are not in `mcp_servers` and keep their own signed approval templates.
