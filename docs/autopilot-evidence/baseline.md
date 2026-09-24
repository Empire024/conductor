# S2 checkout baseline

Worker `agent_muerh0kt_k3ncw1b`. Recorded 2026-09-24 00:05 UTC. Baseline only: no production edits, no lint install, no `npm run dev`, no Electron smoke, no publish, no commit from this worker.

Two different trees were measured. They are not the same result.

## Isolated delivery baseline (controller git.ship)

Controller `agent_muer8ymv_5sx2164` delivery `delivery-7fba8142-ca74-4df2-abd4-e33941f1cbde`.

- Message: `docs: establish durable autopilot backlog and claim audit ledger`
- Paths: `docs/autopilot-backlog.md`, `docs/autopilot-evidence/claim-matrix.md`
- `publish`: false
- Started `2026-09-23T23:56:44.701Z`, finished `2026-09-24T00:00:14.420Z`
- State: `delivered`. Commit `fc557b1cc9b48e808825ca7460e5e63b653e4695`. Push skipped. Release skipped.
- Preflight detail: `2 changed files in scope (3 other changes stay uncommitted); local delivery (no push, no release).`
- Test detail: `npm test passed in an isolated worktree holding only the requested paths.` `2026-09-23T23:56:48.031Z`–`2026-09-23T23:59:09.172Z`. Stage state `passed`.
- Build detail: `npm run build passed in an isolated worktree holding only the requested paths.` `2026-09-23T23:59:09.172Z`–`2026-09-24T00:00:11.554Z`. Stage state `passed`.
- Commit detail: `Committed fc557b1 with 2 requested paths.` Log: 2 files changed, 782 insertions; both paths created.

`git.ship.status` keeps only the last 40 stage lines (`LOG_LINES` at `src/main/delivery.ts:35`). The isolated test tail is the script-test summary, not the Vitest summary: `tests 65`, `pass 65`, `fail 0`, `duration_ms 5649.9745`. The isolated build tail ends `built in 35.46s`. Those tails are not a full log.

Controller full status snapshot, same run, not re-polled: `artifacts/autopilot/initial-delivery.json`. Its stage logs are the same 40-line tails. Working-tree typecheck, test, and build below already ran sequentially on the heavy-check slot after this delivery was `delivered`. They were not run again.

Saved copies (gitignored `artifacts/`, `.gitignore:5`):

- `artifacts/autopilot/baseline/isolated-delivery-status.json` — settled status body
- `artifacts/autopilot/baseline/isolated-delivery-midrun.json` — status while tests were still running
- `artifacts/autopilot/baseline/isolated-test.log`
- `artifacts/autopilot/baseline/isolated-build.log`
- `artifacts/autopilot/baseline/isolated-commit.log`
- `artifacts/autopilot/baseline/isolated-preflight.log` (empty)
- `artifacts/autopilot/baseline/isolated-push.log` (empty)
- `artifacts/autopilot/baseline/isolated-release.log` (empty)

Polled `git.ship.status` until state was `delivered`, not `running`, before any working-tree command. Re-checked immediately before `npm.cmd run test` and before `npm.cmd run build`. Each time the latest run was still `delivery-7fba8142` in state `delivered`. No second delivery was running. No other baseline worker was started by this task.

## Git names and HEAD

Initial, captured while that delivery was already in its test stage (`artifacts/autopilot/baseline/initial-git.txt`, exit 0):

- HEAD `e3aa6645beb0ce3682c1aa5bc33e24d717e5a423` — Persist a durable job's creator on the job instead of a database setting
- `git diff --name-only`: `feature-list.md`, `src/main/agent-control.ts`
- Untracked: `docs/autopilot-backlog.md`, `docs/autopilot-brief.md`, `docs/autopilot-evidence/`
- Cached diff: none

After the isolated commit and before working-tree typecheck (`artifacts/autopilot/baseline/post-delivery-git.txt`, exit 0):

- HEAD `fc557b1cc9b48e808825ca7460e5e63b653e4695`
- Porcelain: `M feature-list.md`, `M src/main/agent-control.ts`, `?? docs/autopilot-brief.md`

Final, after working-tree build (`artifacts/autopilot/baseline/final-git.txt`, exit 0):

- HEAD unchanged `fc557b1cc9b48e808825ca7460e5e63b653e4695`
- `git diff --name-only`: `docs/autopilot-backlog.md`, `feature-list.md`, `src/main/agent-control.ts`
- Untracked then: `docs/autopilot-brief.md`, `docs/autopilot-evidence/core-claim-audit.md`
- Cached diff: none

`docs/autopilot-backlog.md` and `docs/autopilot-evidence/core-claim-audit.md` were clean or absent at the post-delivery snapshot and present after the build. This worker did not write them. `feature-list.md`, `src/main/agent-control.ts`, and `docs/autopilot-brief.md` stayed untouched. This file is the only S2 evidence document.

## Current working tree

Commands ran in `C:\Claude\conductor` after the delivery was not running, one after another. The tree included the uncommitted `src/main/agent-control.ts` and `feature-list.md` for the whole window. That is the dirty checkout, not the isolated delivery copy.

| Command | Started (UTC) | Finished (UTC) | Exit | Log |
| --- | --- | --- | --- | --- |
| `npm.cmd run typecheck` | 2026-09-24T00:01:53.3887825Z | 2026-09-24T00:02:15.5934271Z | 0 | `artifacts/autopilot/baseline/typecheck.log` |
| `npm.cmd run test` | 2026-09-24T00:02:52.5759227Z | 2026-09-24T00:04:30.7460741Z | 0 | `artifacts/autopilot/baseline/test.log` |
| `npm.cmd run build` | 2026-09-24T00:05:09.3657692Z | 2026-09-24T00:05:38.5876808Z | 0 | `artifacts/autopilot/baseline/build.log` |

`npm.cmd run typecheck` is `tsc --noEmit` (`package.json:18`). Log shows that script and `exit_code: 0`. No `error TS` lines.

`npm.cmd run test` is `vitest run && npm run test:scripts` (`package.json:19`). Vitest v3.2.7: Test Files 256 passed (256), Tests 3020 passed (3020), duration 93.40s, start 02:02:53 local. `test:scripts`: tests 65, pass 65, fail 0, duration_ms 3087.4745. Shell exit 0. Stderr lines such as `Browser MCP request failed TypeError: Do not know how to serialize a BigInt` (`test.log` around the `browser-mcp.test.ts` case) and `Remote session poll failed Error: offline` are inside passing tests, not a failing suite.

`npm.cmd run build` is `npm run typecheck && electron-vite build` (`package.json:15`). Nested `tsc --noEmit` printed no errors. Vite v7.3.6: ssr `built in 1.71s`, preload `built in 29ms`, renderer `built in 17.10s`. Exit 0. Vite printed existing dynamic-import chunk notices for `src/main/local-models/config.ts` and `src/main/local-models/resource-guard.ts`. Those notices did not fail the build.

No unique failing command, so there is no minimal reproducer and no candidate root cause for a red check.

## Lint inventory (not installed, not run)

`package.json` `scripts` (`package.json:13-66`) and `devDependencies` (`package.json:82-95`) name no eslint, biome, oxlint, prettier, or stylelint. No `.eslintrc`, `eslint.config.*`, `biome.json`, `.prettierrc`, `oxlint.json`, or `.stylelintrc` at the repo root. `node_modules/.bin` does not contain `eslint`, `eslint.cmd`, `biome`, `biome.cmd`, `oxlint`, `oxlint.cmd`, `prettier`, `prettier.cmd`, `stylelint`, or `stylelint.cmd` (`Test-Path` false). `Get-Command` for eslint, biome, oxlint, and prettier exited 1 (not on PATH). Lint was not run. Nothing was installed.

## Grok weekly quota: earlier CLI-only investigation (superseded below)

No authoritative current weekly quota percentage, limit, or reset is exposed by a zero-turn CLI or provider status call. Owner rule stands: keep using Grok until it reports it cannot work. The 95% ceiling does not apply until a real percentage exists.

Installed CLI: `grok 1.0.41 (4220f3b224a6) [stable]` at `%USERPROFILE%\.grok\bin\grok.exe`. Commands, all exit 0, no network call:

- `& "$env:USERPROFILE\.grok\bin\grok.exe" --version`
- `& "$env:USERPROFILE\.grok\bin\grok.exe" --help`
- `& "$env:USERPROFILE\.grok\bin\grok.exe" usage --help`
- `& "$env:USERPROFILE\.grok\bin\grok.exe" inspect --json`

`grok --help` has no account, quota, or limits command. `usage` is "Print persisted token and cost usage for a session" and requires `<SESSION_ID>` plus optional `[TURN]`. Help lists no quota flag. Docs say the JSON is `sessionId`, `updatedAt`, `session`, and `turns`, with `costUsdTicks` (`%USERPROFILE%\.grok\docs\user-guide\17-sessions.md:279-291`). The same page says interactive credit and billing stay on `/usage` in the TUI.

`grok inspect --json` top-level keys: `grokVersion`, `channel`, `cwd`, `projectRoot`, `projectTrusted`, `projectInstructions`, `permissions`, `loginPolicy`, `hooks`, `skills`, `agents`, `plugins`, `marketplaces`, `mcpServers`, `lspServers`, `configSources`, `externalCompat`. None named quota, limit, usage, rate, reset, billing, allowance, or credit.

`%USERPROFILE%\.grok\settings_cache.json` payload `settings` (cache `fetched_at` `2026-09-24T00:07:31.478921300Z`, `grok_version` `1.0.41`) has no weekly percentage. The only nearby keys are null: `subagent_rate_limit_max_attempts`, `usage_billing_redirect_url`, `auto_compact_threshold_percent`, `subagents_sampling_limit`, `subagents_limit_behavior`. Config schema rate-limit keys are retry counts, not an account balance (`%USERPROFILE%\.grok\docs\user-guide\26-config-reference.md:414`, `:420`, `:451`, `:454`).

The account figure is TUI-only. `/usage` opens a modal; the dashboard **Usage limit** tab shows account allowance (`04-slash-commands.md:420-429`, `23-dashboard.md:198-201`). That is an interactive modal, not a status command, and it was not opened.

`grok.exe` contains a billing parser ("Failed to parse billing data") whose field names include `creditUsagePercent`, `currentPeriod`, `monthlyLimit`, `used`, `onDemandCap`, `onDemandUsed`, `prepaidBalance`, `billingPeriodStart`, `billingPeriodEnd`, `includedUsed`, `totalUsed`. Strings `weeklyLimit`, `quotaPercent`, `rateLimits`, `/v1/billing`, `billing/status`, and `usage/status` are absent. These strings alone do not establish the account's allowance period; the worker did not open the TUI loader ("Loading usage" / "Couldn't load usage") or call an endpoint. The live controller observation below establishes that this account displays a weekly limit.

Conductor `src/main/providers/grok.ts` agrees: `contextUsage` (`grok.ts:618-622`) maps context used/size and optional cost; `usage` (`grok.ts:625-643`) maps `_meta.usage` token counts and `costUsdTicks`. There is no `rateLimits` field. Other `_x.ai/*` notifications are ignored (`grok.ts:485-487`). Launch is `grok agent --no-leader stdio` (`grok.ts:72-74`), which does not request quota.

Log of this check: `artifacts/autopilot/baseline/grok-quota.txt`.

Settlement: weekly quota percentage is unavailable. Authoritative read is `& "$env:USERPROFILE\.grok\bin\grok.exe" usage --help` (exit 0, grok 1.0.41): session `<SESSION_ID>` token and cost only, no limit, reset, or percentage. No zero-turn status command exists beside that help. The 95% ceiling stays unused until Grok itself reports a percentage or that it cannot continue.

## Controller addendum: authoritative Grok allowance found

At approximately 2026-09-24 00:16 UTC, controller `agent_mues2ka2_oclznv3` opened installed Grok 1.0.41 with `grok dashboard` in a text-only tool PTY. No model prompt was submitted. The initial sandbox launch exited 1 because its managed-policy lock was inaccessible; the explicitly approved escalated read reached the dashboard. `/usage` followed by Enter to select the show command opened the **Usage limit** tab:

```text
Weekly limit (SuperGrok)
13%
Resets: October 1, 00:43
```

This directly observed weekly allowance supersedes the earlier unavailable conclusion. The displayed reset has no explicit timezone in the modal; retain it as displayed. The owner's clarification restores the original 95% Grok ceiling when authoritative usage is available, so 95% applies again. Context tokens, session costs, and binary field names are not used as substitutes. Two consecutive Ctrl+C closed the dashboard with exit 0. No desktop window, billing change, model turn, install, or second server was started.

The read route comes from installed CLI docs `04-slash-commands.md:420-429` and `23-dashboard.md:198-201`; the account value comes from the live modal, not those docs. App control still lacks a cheap quota method (G1 remains open).

## Not done by this worker

Not committed. Controller verifies this report and ships `docs/autopilot-evidence/baseline.md` only. The scratch credential file used to call app control is gone; a name search found no `s2-auth` copy under Temp or this checkout. Do not include `feature-list.md`, `src/main/agent-control.ts`, `docs/autopilot-brief.md`, `docs/autopilot-backlog.md`, or `docs/autopilot-evidence/claim-matrix.md`. Passing these checks is checkout health at `fc557b1` plus the dirty `src/main/agent-control.ts` that was already in the tree. It is not acceptance of product behavior.
