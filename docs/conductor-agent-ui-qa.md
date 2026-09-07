# Structured agent UI QA

Recorded 2026-09-07. **Owner-authorized testing delivery; full parity is not claimed.** Offline validation and the explicitly authorized replacement Codex A/B suite pass. Claude live testing is blocked by the owner's reported exhausted allowance. The owner explicitly requested updater delivery of local/testing builds without waiting for full extension parity. Publication is verified separately against the release workflow and assets, not inferred from these tests.

## Environment and reference baseline

Windows, Node 24.18.1, Electron 37.10.3, React 19.2.8, TypeScript 5.9.3, Playwright 1.63.0, Vitest 3.2.7. Existing Node SQLite/WAL, Monaco, xterm/node-pty, Git and Electron/Vite were reused; this is not a replacement application.

- Codex CLI/schema **0.153.4**. Existing local CLI login reported ChatGPT; no API billing route or credentials were changed. The Codex VS Code extension is not installed in the inspected profile. Reference: current [official IDE documentation](https://learn.chatgpt.com/docs/codex/ide) and installed generated App Server schema.
- Claude CLI and installed official VS Code extension **2.1.263**. Local full-duplex CLI connection preserves user-managed authentication, native coding prompt, configuration and permissions. No Agent SDK/API billing assumption. **Zero Claude live submissions.**
- Live Codex model **gpt-5.6-luna**, requested effort **low**, fixture workspace-write sandbox, untrusted-command approvals. Model availability was read from the installed runtime before selection; [official model reference](https://developers.openai.com/api/docs/models/gpt-5.6-luna) was consulted. Turn-start acknowledgement records the selected parameters separately from preflight thread defaults.
- No screenshot attachment was accessible in this conversation. The implemented compact rail, Markdown and IN/OUT tool pattern follows the textual visual direction.

## Executed commands and results

All ordinary tests below use synthetic processes or injected SDK/adapter boundaries and require no provider credentials.

| Exact command | Actual result |
| --- | --- |
| `npm.cmd test` | **Passed:** 37 Vitest files / 230 tests, followed by 13 Node approval-guard/packaging tests. |
| `npm.cmd run test:agent-contracts` | **Passed:** 10 files / 100 tests, followed by 5 Node guard tests. |
| `npm.cmd run build` | **Passed:** TypeScript no-emit check and production Electron/Vite build. |
| `npm.cmd run test:agent-ui` | **Passed:** production build, actual Electron Codex and Claude suites; zero inference. |
| `node scripts/smoke-structured-agents.mjs` | **Passed** again after adding default-zoom assertions: 12 check groups, no renderer exceptions. |
| `node scripts/smoke-structured-agents.mjs --provider=claude` | **Passed** again after adding default-zoom assertions: 10 check groups, no renderer exceptions. |
| `node --test scripts/live-acceptance-guard.test.mjs` | **Passed:** 5 tests, including captured real quoted-rg failure and negative command/scope cases. |
| `node scripts/inspect-codex-baseline.mjs` | Metadata-only initialize/config/model inspection passed; zero threads/turns. |
| `node scripts/inspect-codex-isolation.mjs` | Metadata-only installed-runtime check passed after the MCP override correction: two optional MCP servers disabled, six optional skill overrides prepared; zero threads/turns. |
| `node scripts/inspect-codex-baseline.mjs --usage-only` | Native rate-limit metadata read without a turn; no API-dollar telemetry. |
| `$env:CONDUCTOR_LIVE_TESTS = '0'; npm.cmd run test:agent-live` | **Skipped as designed:** no provider connection or inference. |
| Explicitly opted-in `npm.cmd run test:agent-live` with model/auth below | Original A failed; **owner-authorized replacement A and B passed**. Three aggregate Codex submissions, no Claude submissions. See chronology and amendment. |
| `npm.cmd run test:update-ui` | **Passed:** production build plus actual Electron/native NsisUpdater automatic local-feed discovery, Update pending, mouse/keyboard controls, opt-out persistence and opt-in rediscovery. Synthetic non-executable artifacts; no install. |
| `npm.cmd run update:local` | **Passed:** real NSIS package, executable and blockmap hashes, atomic publication to the owner's private local feed. First package `0.1.5-local.1788788132715`; source package version/tags unchanged. This is packaging evidence, not an installed-app restart claim. |

The final production renderer bundle is approximately 8.25 MB before packaging, including existing Monaco; its large worker chunks remain. This build result is not a rendering benchmark or an updater delivery.

## Offline pipeline evidence

The fake executables speak raw provider JSONL to production adapters. The Electron tests interact with the real renderer/preload/IPC/controller/SQLite/artifact pipeline, not prebuilt React activity props. Model IDs and assistant fixture text are explicitly synthetic. The fake runtime's local Node test is a real process; it is not evidence of live model behavior.

- Transport and adapters: initialize ordering, fragmented JSON and split UTF-8, malformed/unknown frames, separate partial tool JSON, identical legitimate chunks, streamed/final replacement, concurrent identities, nested native parents, nonzero exits, unsupported methods, interruption versus acknowledgement, explicit resume and no automatic retry.
- Backend and replay: no process on pane registration/history read; one controller per session; independent simultaneous sessions; stale-incarnation callbacks and responses ignored/rejected; approval claims once across views; validation before claim; late hook/capture cleanup; shutdown during initialization; crash-tail replay; durable budget reservation across reopen. Replay starts no inference, answers no request and performs no workspace writes.
- Review: exact two-deletion counts; mixed/multiple hunks, repeated edits, CRLF, Unicode/spaced paths, missing final newline, creation/deletion, dirty original bytes, immutable reconstruction checks, explicit rename/binary/oversized limitations, junction/path traversal rejection. Denial leaves bytes unchanged, approval edits once, Keep does not write/reapply, Undo either restores the expected original or preserves later work with a conflict result.
- Settings/context/security: actual model/effort/independent sandbox and approval turn fields; explicit resume applies Claude effort; native image formats and size limits; exact selected/unsaved context; canonical workspace checks; trusted renderer-origin/main-frame IPC guard; safe Markdown links/HTML omission; token diagnostic redaction versus untouched private authoritative file bytes.
- Actual Electron: timeline and native request action, command output/exit, expansion, immutable Monaco inline/side-by-side and change navigation, clipboard patch, Keep and conflicting Undo, code navigation, removable/inspectable context, keyboard Escape/focus, reload, close/retrieve, actual detached window/retrieve, native ID/runtime ownership and unchanged prompt count, normal/narrow split panes, 110% zoom geometry.
- Large synthetic history: 2,200 raw activities; bounded 2,000 projected items and initially 250 DOM activities. Selected text and DOM identity remain while new rows arrive; Jump to latest, earlier history and parent labels work. Latest sample: **4,385 ms** total, **3,526 ms** after the selection barrier release. This single Windows sample includes intentional fixture pausing, process delivery, SQLite, test polling and React, not isolated rendering time or a performance guarantee.

## Real UI captures

These are actual Electron screenshots. Offline captures are **fixture-verified**, never live-provider success evidence. Visual inspection was direct; no LLM screenshot evaluator or image generation was used. The captured live failure has apparent cropping at default zoom; subsequent offline DOM assertions at 110% confirm the pane fits its viewport with no timeline horizontal overflow. Live visual acceptance remains incomplete.

| Evidence | Captures and machine-readable result |
| --- | --- |
| Codex synthetic | [Normal](evidence/agent-ui/codex/normal.png), [narrow split](evidence/agent-ui/codex/narrow.png), [immutable diff](evidence/agent-ui/codex/diff.png), [detached](evidence/agent-ui/codex/detached.png), [110% zoom](evidence/agent-ui/codex/zoom-110.png), [large history](evidence/agent-ui/codex/large-history.png), [result](evidence/agent-ui/codex/results.json) |
| Claude synthetic | [Normal](evidence/agent-ui/claude/normal.png), [narrow split](evidence/agent-ui/claude/narrow.png), [immutable diff](evidence/agent-ui/claude/diff.png), [detached](evidence/agent-ui/claude/detached.png), [110% zoom](evidence/agent-ui/claude/zoom-110.png), [result](evidence/agent-ui/claude/results.json) |
| Codex real, failed A | [Pending real approval](evidence/agent-ui/live-codex/failure.png), [sanitized event trace and outcome](evidence/agent-ui/live-codex/results.json) |

## Live chronology and allowance

The local fixture preparation verified the exact original baseline fails with `contains must not be called`, deleting only the two declarations passes, and restoring the baseline fails again. Provider testing started from that restored baseline in a disposable repository, never the user's project.

1. **Preflight 1, zero submissions:** launcher configuration failed before a thread because a quoted dotted MCP key was parsed as a different server name. Captured stderr: [versioned failure](../scripts/fixtures/captured/codex-0.153.4-invalid-mcp-key.json). Fixed offline; installed-runtime metadata-only isolation then passed.
2. **Preflight 2, zero submissions:** App Server connected, but the UI harness could not target the model selector reliably. Explicit accessible labels and idle/catalog polling were fixed and tested offline.
3. **A, submitted once at 2026-09-07T12:44:33.614Z:** real streamed assistant text, command declaration and native `item/commandExecution/requestApproval` arrived. The request was a literal PowerShell-wrapped `rg -n "wasOpen|wasPinned" panel.mjs` in the isolated cwd. The harness rejected its quoted regex pipe as exceeding its allowlist and closed the app **before answering the request**. No command executed, no edit happened, no provider test ran and no final turn completion was observed.
4. **After shutdown, read-only check:** native conversation ID retained; phase `disconnected`; request `number:0` expired; exactly one persisted user message and one suite reservation; fixture bytes identical to the original baseline. This is truthful historical restoration, not successful resume/recall.
5. **Offline correction:** preserve the native captured request in [quoted-rg regression](../scripts/fixtures/captured/codex-0.153.4-quoted-rg-approval.json). Accept only that exact fixture search/body; reject unquoted pipelines, added commands, other files/cwds, broader grants and mismatched wrappers. The harness still chooses only **Allow once**, never a proposed persistent exec-policy amendment.
6. **B skipped:** A never removed the identifiers or ran the test. No silent A replay, replacement session, helper prompt or allowance reset was used. No further live run occurred after the offline fix.

Counts at the end of the original attempt: **Codex A 1, Codex B 0; Claude A 0, Claude B 0**. That attempt did not establish edit/test or recall success. The separately authorized amendment below supersedes the aggregate counts, without erasing this failure.

The opted-in invocation used:

```powershell
$env:CONDUCTOR_LIVE_TESTS = '1'
$env:CONDUCTOR_LIVE_MODEL_CODEX = 'gpt-5.6-luna'
$env:CONDUCTOR_LIVE_AUTH_CODEX = 'cli'
npm.cmd run test:agent-live
```

**Do not rerun this command to reset/retry the suite.** The original failed reservation was retained. The owner's explicit authorization for exactly one replacement A plus the unused B was recorded in both the external allowance and the additive SQLite `live_suite_amendments` table. The amended Codex limit is three, total suite limit remains four, and all other caps are unchanged. That allowance is now exhausted for Codex; another invocation refuses rather than spending more turns.

### Authorized replacement, 2026-09-07 13:41 UTC

The same fixture root/profile/suite and existing CLI authentication were retained. A new disposable smoke repository started from the original verified failing baseline. The exact invocation added only:

```powershell
$env:CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID = 'conductor-codex-1788745961011'
```

A was submitted at 13:41:34.991Z and B at 13:41:53.519Z; both completed inside their host time bounds. **Live-verified:** actual approval response through Allow once; only the two declaration lines removed; real `node --test panel.test.mjs` command exactly once with exit 0 and passing output; native two-deletion activity and expanded immutable diff; pane close/reopen and reload without another A; explicit native resume with unchanged conversation identity; B names both identifiers and the passing test without tools. After inference ended, local checks preserved the immutable artifact and later conflicting bytes during Undo.

Aggregate actual submissions: **Codex A 2 (one failed, one passed), B 1 (passed); Claude A/B 0**. No automatic retry, helper inference, account switch or API billing route was used. Reported replacement usage: A 32,293 input / 454 output / 21,760 cached; B 8,443 input / 20 output / 7,936 cached. The provider reported a weekly bucket at 10%; this is not attributable suite cost. Authoritative USD cost and original failed-A tokens remain unknown.

Evidence: [Live A](evidence/agent-ui/live-codex-replacement/live-a.png), [expanded live diff](evidence/agent-ui/live-codex-replacement/live-diff.png), [sanitized events/result](evidence/agent-ui/live-codex-replacement/results.json). Updater: [actual Electron prompt with synthetic update metadata](evidence/local-updates/local-update-pending.png), [result](evidence/local-updates/results.json). `node scripts/export-agent-ui-evidence.mjs` exports only these explicit local runs, redacts diagnostic secrets and owner paths, and never invokes a provider. Original failure evidence remains separate.

Default caps are two submissions/provider and four/suite. Reserve before dispatch; never auto-retry. Host active runtime is 90 seconds/prompt plus a separate 30-second cumulative approval wait; the UI harness has a 120-second outer bound. Stable App Server exposes no hard internal-model-step limit, so six/two-step limits cannot be guaranteed. Native retry notifications trigger interruption, but in-flight work may have begun.

Optional hooks/plugins/MCP/skills/memories/browser/network tools and delegation were isolated through verified, process-local native configuration; required administrator policy is preserved. No account/configuration/billing file was modified. Dollar thresholds default to $0.25/provider and $0.50/suite with persisted stricter overrides, but delayed/in-flight reporting can overshoot. No usage event arrived for the interrupted A: tokens and cost are **unknown**, not zero. The SQLite cost accumulator's zero means no telemetry accumulated, not free usage. A separate metadata read observed the Codex weekly bucket at 1%; that is subscription quota metadata, not the cost of this turn.

## Storage migration and developer reproduction

Existing `AgentManager` owns controllers; panes only subscribe. The existing database gains additive `structured_sessions`, `structured_events`, `structured_artifacts`, `live_suite_budget` and `live_suite_limits` tables. Legacy terminal history is retained as read-only output; an unrecorded native ID is not guessed. Authorized project folder moves rebind stored project paths without altering immutable history.

Events are journaled in order with 32 ms projection/UI coalescing, a 20,000-event tail, 2,000 hot activities and 64 KiB previews. Private artifacts are outside hot state, bounded at 512 MiB; output artifacts at 8 MiB and UTF-8 file snapshots at 2 MiB. Captures reserve at most 128 slots/32 MiB before reads. Quota exhaustion is explicit rather than overwriting immutable history. No daemon supervisor was added: hidden views continue, full backend exit disconnects owned runtimes, and reconnect/resume is explicit.

Offline reproduction uses `npm.cmd test` and `npm.cmd run test:agent-ui`. It creates new disposable temporary roots, never provider turns. The captured approval failure alone reproduces with `node --test scripts/live-acceptance-guard.test.mjs`. For adding an event or renderer, follow the [parity ledger guidance](conductor-provider-parity.md#extending-the-implementation) and provider-specific compatibility files.

## Outstanding gates and delivery status

### Release runner regression and correction

The first publication attempt, [run 34129306942](https://github.com/Empire024/conductor/actions/runs/34129306942), failed its tests and published no release. The Windows runner uses a `RUNNER~1` temporary directory alias. Comparing its lexical name to expanded canonical paths falsely rejected the local feed and generated an incorrect relative hook-artifact path. This was reproduced locally with a real 8.3 path, corrected without allowing junction escapes, and the full **230 Vitest + 13 Node** tests then passed under that alias. Native synchronous canonicalization is now consistent with asynchronous `realpath`; immutable hook paths remain relative to the canonical workspace. Existing traversal/junction tests still pass.

Exact local reproduction, in a task-scoped shell (no persistent environment changes):

```powershell
New-Item -ItemType Directory -Force -Path 'C:\claude\conductor\artifacts\ci-short-path' | Out-Null
$fsProbe = New-Object -ComObject Scripting.FileSystemObject
$env:TEMP = $fsProbe.GetFolder('C:\claude\conductor\artifacts\ci-short-path').ShortPath
$env:TMP = $env:TEMP
npm.cmd test
```

`npm.cmd run test:update-ui` rebuilds and retests the native updater after this correction. No provider turn is repeated for the path fix; the live allowance remains three Codex submissions.

Codex's capped live acceptance passed; Claude remains live-blocked by quota. Full local extension parity remains partial: command/skill execution picker and configuration/MCP/plugin management; provider checkpoints/context rollback and combined restore; Claude immediate fork; richer plan-feedback/execute controls; cross-session background steering; externally authorized file attachment paths; provider-specific hosted/browser delegation. Claude's documented Bash/subagent snapshot limitations and rename/binary/oversized restore limitations remain explicit. OS-wide atomic compare-and-swap against unrelated writers is not provided; Undo uses expected-byte checks, host locks and immediate recheck.

The owner explicitly authorized an installed-updater testing release despite those gaps. The delivery workflow commits the tested integrated state, pushes `main`, and checks the automatic release workflow plus installer, blockmap and `latest.yml`. Publication success must be verified after the push; it is not implied by this pre-publication QA record. No source package version or release tag is manually changed. Older installed versions receive the local-feed support in a normal GitHub bootstrap update; subsequent locally packaged builds use the same Download / Restart to update flow, with the default-enabled Settings option. See [local update delivery](conductor-local-updates.md).
