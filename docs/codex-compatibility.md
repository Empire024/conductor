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
| Sandbox/approval policy | Exact per-turn request fields; composer mode selector | Fixture-verified mapping of the four composer modes onto Codex's own `/permissions` presets: Ask inherits the CLI configuration, Read only, Edit (the CLI's "Auto": workspace work unprompted, an approval request to leave it) and Auto (never asks the owner: Conductor answers the requests to leave the workspace itself, and it also carries network). Writes stay inside the workspace in every mode; a settings-dialog override still wins over the mode |
| Plans | `turn/plan/updated`; plan card. Gated `turn/start.collaborationMode`; Plan mode | Fixture-verified plan/default transition, explicit default mode after native resume, and native built-in mode instructions via null override. Experimental opt-in required |
| Attachments | Native localImage plus exact text context fragments; removable composer chips | Deterministic test verifies images, CRLF selection content and Unicode/spaced paths. No implicit repository attachment |
| Usage/limits | `thread/tokenUsage/updated`, `account/rateLimits/updated`; usage activity | Token mapping fixture-verified. Missing dollar cost/quotas remain unknown; no conversion of subscription quota to dollars |
| Nested agents | `collabAgentToolCall` and `subAgentActivity`; parent-correlated nested activity | Native mapping implemented, no live evidence. Mapping retention bounded |
| MCP/custom tools | Native MCP/dynamic item declarations/results; safe registry fallback; MCP tool approvals (`mcpServer/elicitation/request` with `codex_approval_kind = mcp_tool_call`) as approval cards, answered by Conductor itself in Auto | Mapping implemented; no host re-execution. MCP approval flow live-verified 2026-09-22 (section below); other elicitations still unsupported. MCP elicitation and delegated dynamic tool execution are unsupported and return explicit JSON-RPC errors |
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

## MCP tool approvals and the Auto mode (2026-09-22)

codex-cli 0.155 gates every MCP tool call. Under `approval_policy = never` a call that "requires approval" is refused outright — `MCP tool call requires approval, but approval policy is never` — and a server's `default_tools_approval_mode` (values `auto | prompt | writes`; `approve` is not accepted for MCP servers) only decides *which* calls require approval: `auto` clears tools annotated `readOnlyHint`, nothing clears an unannotated or writing tool. Conductor's Auto used to be exactly `never`, so after the 0.155 rebaseline every Auto conversation lost the project browser, chrome-devtools and node_repl while Edit (`on-request`) kept them.

Live probes against the installed CLI (one stub loopback MCP server, gpt-5.6-sol at low effort, one tiny turn each):

| Thread config | Tool | Turn policy | Result |
| --- | --- | --- | --- |
| server unset | read-only annotated | `never` | not offered to the model |
| `default_tools_approval_mode = "auto"` | read-only annotated | `never` | runs (also through code mode `exec`, also after `thread/resume`, also next to partial nested entries for the owner's own servers) |
| `default_tools_approval_mode = "auto"` | unannotated | `never` | refused: requires approval |
| `default_tools_approval_mode = "approve"` | unannotated | `never` | server dropped, tool unavailable |
| server unset | read-only annotated | `on-request` | runs without any request |
| server unset | unannotated | `on-request`, reviewer `user` | `mcpServer/elicitation/request` (mode `form`, `_meta.codex_approval_kind = "mcp_tool_call"`, `_meta.persist = ["session","always"]`), answered with `{ action, content, _meta }` |

Auto is therefore `on-request` — the policy Codex's own automatic mode uses — with workspace-write and network, `approvalsReviewer: "user"` so requests reach this client rather than an `approvals_reviewer` the CLI configuration names, and the adapter answering every approval itself: MCP tool approvals are accepted (`persist: "session"`, never `always`, which would write the owner's config), and a command, file-change or permission request that has to leave the workspace sandbox is accepted once, for that request only (`decision: "accept"`, a turn-scoped permission grant; never `acceptForSession` or an execpolicy amendment, which would outlive the request). The sandbox still fails the command first, so every escalation is Codex's own justified request, and the notice `Auto allowed “…” without asking.` records it in the conversation. What Auto never answers is defined by `OWNER_ONLY_ESCALATIONS` in `src/main/providers/codex.ts`, judged on where the command, the file-change paths or the permission profile reach rather than how Codex words the request: a Windows system directory or the hosts file, the registry, elevation, services/scheduled tasks/startup, the firewall/network configuration/Defender, a credential or key store, disks/boot/accounts/permissions, and recursive deletion. Such a request stays an owner card and the notice `Auto left “…” to you: it reaches <boundary>.` says which boundary; so does a file change whose paths the adapter has not seen in the item's own events (or its `grantRoot`) and a command request without a command, because Auto cannot check what it does not see. Because Codex on Windows runs every command through `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '…'`, an absolute interpreter path is reduced to its bare name before the boundaries are matched; the command's own reach is judged in full. A request that offers no plain accept stays pending for the owner (`Auto could not approve …`); a worker under a "Review coworkers" controller still answers for itself exactly as any Auto worker does (since 2026-09-23 the opt-in never lowers a coworker's mode, for Claude or Codex), and only an isolated reviewer never executes. Questions still reach the owner. Live-observed 2026-09-22 (codex-cli 0.155.1, `gpt-6-sol`): a justified PowerShell escalation arrives as `item/commandExecution/requestApproval` with `reason`, `availableDecisions: ["accept", { acceptWithExecpolicyAmendment }, "cancel"]` and no `decline`; before this change Auto left it as an owner card, which is the "Auto could not approve" the owner reported. In Edit and Read only the same MCP elicitation is an ordinary approval card (Allow once / Allow for this session / Deny); other elicitations (URL, verification, forms with fields) stay unsupported and are answered with an explicit JSON-RPC error. The composer mode is the only place these permissions are chosen: the conversation settings dialog no longer offers sandbox/approval overrides and stored ones are ignored.

Conductor's browser tools that only look at the page (`browser_snapshot`, `browser_screenshot`, `browser_console`) now carry `readOnlyHint`, so they run without a prompt in the modes that ask. The adapter also waits, bounded, for the thread's MCP servers to finish starting before reporting idle — a turn that starts a few milliseconds after connection otherwise does not see their tools — and when `thread/resume` reports `no rollout found` (a conversation that never completed a turn cannot be resumed, which is exactly what the browser toggle reconnects), it starts a fresh native thread instead of failing.
