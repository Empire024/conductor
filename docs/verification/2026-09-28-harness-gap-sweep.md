# Harness gap sweep (2026-09-28)

Owner goal: Conductor "should work like butter without unnecessary turnbacks; agents should become
extremely capable with this harness, not less; it shouldn't waste tokens."

A gap is anything in the harness that makes a capable agent fail, retry, take a detour, ask the
owner, wait, or spend tokens it should not. This doc ranks the gaps found on 2026-09-28, gives each
a fix spec an Opus fixer can execute without re-investigating, and groups the fixes into batches
that do not edit the same files.

Sweep by Fable (agent_mulhe29q_w10gmfi) with three Opus/Sonnet readers. Read-only; no code was
changed. Working files (miner script, raw aggregates, code audit, docs index) are under
`.conductor-scratch/gap-sweep/` (`mine-journal.mjs`, `journal-findings.md`, `code-findings.md`,
`docs-index.md`, `measure.mjs`, `measure-tools.mjs`).

## Evidence base

- **Journal window:** 2026-09-21T00:00Z to 2026-09-28T17:00Z. 463 of 767 structured sessions
  (284 Claude, 81 Codex, 90 local, 8 Grok), each read backwards by primary key and stopped at the
  cutoff; 548 k event rows parsed. Counts below are floors: `CA` is the controlActivity record
  (write calls only, exists since about 09-25); `app-err` is parsed from tool output (read and
  write calls). "wasted" is the failed call plus same-method retries until one succeeded.
- **Briefings:** 888 user turns in 328 native Claude/Codex sessions matched to their journal prompt.
- **Code:** working tree of 2026-09-28. Other agents are editing `agent-control.ts`,
  `control-mcp.ts` and renderer files, so every root cause quotes the exact string to search for.
  Treat line numbers as approximate.
- **Owner cost in the window:** 83 owner-answered interactions, 1,021 minutes of owner wait in
  total (p50 0.6 min, p90 10.4 min). The longest wait, 579 min, was a question raised only because
  coworkers had opened in default mode instead of Auto.
- Most known-gap fixes landed late on 09-28 (90f2501 15:32Z, 221f1ee 16:11Z, 67bb754 16:47Z), so
  nearly every occurrence predates them.

## Already fixed or in progress (confirmed, not re-filed)

| item | evidence in the window | status |
|---|---|---|
| tabs.open dropped `prompt` | 26 tabs.open calls carried a prompt before the fix, all silently dropped (e.g. agent_muhielao_scua3jp 09-25 22:33, 3 times) | fixed 221f1ee (`tabs-open-unknown-args`) |
| approvals steered mid-turn ignored | agent_muldox0q_y4hp2rg 09-28 15:07-15:11: 15 "Auto mode refused (Production Reads)" notices in 4 min, then 3 `[Conductor] approved` turns; 7 request_permission calls left `pending` | fixed 90f2501; remainder is H06 |
| wizard not resumed after restart | 3 restart messages steered on 09-25 21:59 never became a turn; agent_muh6pi5e_h3gfva8 09-25 16:57 "Wizard A was actually never resumed" | fixed 67bb754; `restart-resume-finished-gap` (feature-list.md:3) still open |
| cross-project work bypasses the target project's wizard | | in progress, agent_mulh0uge_bpw2h66 (`cross-project-to-wizard`, feature-list.md:2) |
| agent ids not searchable, agent-to-agent messages invisible | | in progress, agent_mulgywnv_l04k1qk (`agent-id-links-and-messages`, feature-list.md:4) |
| `permission-approval-delivery-classifier` (feature-list.md:23, priority high) | overlaps H06 and H18 below | open, claimed by agent_mulfzb8r_53yryww and agent_mulgbp9b_6fvvmin: H06 fixers must coordinate with them |

## Ranked gaps

Cost is per window (7.7 days) unless stated. A wasted app-control round trip costs roughly 1-3 k
tokens (call, error, reasoning, retry); a `tools.list` call costs about 10 k.

| # | gap | evidence (n / agents, examples) | cost | root cause | fix (spec below) | size |
|---|---|---|---|---|---|---|
| H01 | Refusal bodies are invisible from PowerShell, and the briefing sends agents there; the static paragraph is also stale (says git.ship pushes) and offers no route to the controller | AC1: 130 hidden-400 errors / 91 agents, 179 wasted calls (agent_muao0zp1_k5ntc32 09-21 03:32; agent_mul69e93_at3uf5h 09-28 12:36). Largest single loss | ~180 wasted calls, blind retries, owner questions; every error text improved below is worthless to a PowerShell caller until this lands | `agent-control-server.ts:200` recommends Invoke-RestMethod; `:261` answers every refusal as 400; docs/agent-control.md has no hit for ErrorDetails/curl.exe/400 | one briefing sentence + docs; rewrite the stale clauses | S |
| H02 | Every app-control call is hand-written shell: quoting/JSON failures, the bearer token on the command line, and classifier "Auto-Mode Bypass" denials of the call itself | AC5: 42 failures / ~33 agents, ~63 wasted calls (28 bare "Exit code 1", "empty pipe element" 4, "Bad escaped character" 4); AC13: 10 classifier refusals of control calls / 5 agents; 7 calls stored the token in clear | ~75 wasted calls, plus H17 | `control-mcp.ts` exposes only six fixed tools; no generic call | add a `control({method,args})` MCP tool for Claude (Codex in H14) | S-M |
| H03 | `git.ship` collides: a second delivery is refused with "wait for it or cancel it first", there is no queue, and a superseded run's outcome is lost | AC2: 101 refusals / 16 agents (CA), 36 / 27 (app-err); R3: 24 identical git.ship.status poll loops (agent_mugozcvg_u4q1l40 09-25 13:17; agent_mudapx6n_29pz582 09-22 23:34) | ≥ 40 wasted calls, poll loops, idle swarm workers, double ships | `delivery.ts:443-445` busy text; `delivery.ts:388-391` keeps only the latest run; `agent-control.ts:1991` "no longer the latest one" | queue per project, keep last 10 runs, busy text with the next step | M |
| H04 | Smoke admission (verify-kit loadCheck) counts the wrong tabs and names none | 119 smoke outputs "mid-turn tab(s) besides the caller" / 40 sessions (09-24 19:24 to 09-28 16:59); the granted sweep smoke failed admission twice | verification skipped or delayed; owner asked which tab blocks | `verify-kit.mjs:1010-1037` sends a per-workspace `scope` the server ignores for a conversation credential, so each loop returns the caller's own agents.list including every uncontrolled tab in other projects; `:42` counts `waiting_approval`; `:305` reason names no tab and no override | count own-project tabs only, name them, honour an ignore list | S-M |
| H05 | `orchestration.tasks.update` refuses with "Invalid id": workers send `taskId` (the key the dispatch result and footer use), unknown fields pass silently | AC4: 37 (CA) / 25 (app-err) / 26 agents (agent_mugy63ol_ghkj4ju 09-25 13:10 sent `"taskId":"task_..."`) | ~33 wasted calls; tasks left not-done so controllers poll | `agent-control.ts:1552-1555` uses `text(args,'id',160)`; `:97-98` throws `Invalid id`; dispatch results at `:2256` and footer `:2242` say `taskId`/"task" | accept `taskId` alias, reject unknown keys by name, footer shows the exact call | S |
| H06 | Approvals reach a running turn late or never: the retry queues behind the turn until the owner interrupts; an approval during `interrupting` throws and loses the retry; `request_permission` itself gets classified | D13: 45 steered messages waited > 1 min, 7 > 5 min, max 76 min; D9: 7 request_permission left `pending`, 2 refused by the classifier; Haftheme tab agent_muldox0q_y4hp2rg | owner interrupts; coworkers idle for up to an hour | `permission-grants/wiring.ts:126-132` steers the heads-up only if steering is possible at that instant; `wiring.ts:33` TURN_UNDER_WAY lacks `interrupting` so `structured-sessions.ts:667-668` throws after the grant is applied (`service.ts:338-351`); `service.ts:471` sweep has no retry path | resend heads-up from sweep, 120 s notice with an interrupt action, never throw after applying | M |
| H07 | A coworker cannot message its controller (`send_message` = agents.steer is refused as "cannot control itself or an ancestor"), `agents.status` on the controller is refused too, and coworkers are never told how to report | 13 app-err + 1 CA / 12 agents (agent_mulgywnv_l04k1qk 09-28 16:52; agent_muefkj5w_zlwsrqd 09-23 18:29); every worker falls back to `report` or the task record | 1 wasted call + a detour per worker; controllers poll agents.status | `control-mcp.ts:34` maps send_message to agents.steer; `agent-control.ts:1336` mutate list lacks `agents.status`; `:580-587` ancestor throw; footer `:2242` "coordinate through the provided app protocol"; `turn-briefing.ts:41` FINISH_HINT names no controller | route ancestor steer/status like report; coworker hint names the controller and `report` | S |
| H08 | `report` refuses text over 2,000 characters; the agent rewrites and resends the whole report | AC3: 28 refusals / 12 agents in 7 h on 09-28, 27 rewrites (agent_mul0ptgr_w331pvo 10:04; agent_mul7nzvh_qm77ujk 12:24) | 56 wasted calls, each regenerating ~2.5 k chars | `agent-control.ts:1322` `text(args,'text',2000)` → `:97` throws | never refuse: deliver the first 2,000 chars and keep the rest as an artifact the controller can read | S |
| H09 | Model ids need an exact match: `opus` is refused, `opus[1m]` works; the renderer default is the refused id; router.dispatch drops already-opened tabs when a later task is invalid | 5 CA + 2 app-err / 4 agents (agent_mul9e858_6xf9pq1 09-28 13:12; this sweep's controller 16:44); G11 not counted (duplicates look like normal opens) | 2 extra round trips per dispatch (refusal + models.list); duplicate coworkers | `agent-control.ts:1014-1015`, `:616`, `:2493`, `:1939` exact `model.id ===`; `shared/project-backlog.ts:29` heavy default `opus`; `:1013` names no provider; dispatch `open()` at ~`:2213` sits outside the per-task try | resolveModel with aliases and a listing error; validate all tasks before opening | S-M |
| H10 | `agents.finish` is refused while background tasks or the turn run, with no wait option; controllers loop | AC6: 26 (CA) / 8 agents (agent_muhladkf_ie1mt9v 09-26 00:12: "refused because two of my watcher tasks were still running") | ~26 wasted calls + 10 "did not happen" notices | `coworker-autoclose.ts:158,170` throw; no `waitSeconds` | `agents.finish({waitSeconds})` waits for settle, then finishes | S |
| H11 | Argument-schema drift: `schedules.pause` wants `taskId` (7 tries in one tab), handoff format refused ~15 times, extra args on agents.report / git.ship.status | AC8+AC9: ~35 refusals / ~20 agents (agent_mul69e93_at3uf5h 09-28 11:42) | ~43 wasted calls | `schedule-control.ts:41` allowlist without aliases; `agent-control.ts:131` handoff text points at a doc instead of listing the sections | id aliases; every "accepts only" error lists the signature; handoff error lists the required sections | S |
| H12 | Briefing bloat: leases resent with fresh heartbeats every message; memory recall is 38 % of all briefing bytes; the "once per runtime" static block is resent on 40 % of turns because resumes count as new runtimes; `tools.list` is 37-41 KB | 3.6 MB over 888 turns (p50 2.5 KB, p90 9.3 KB, max 24 KB); 441 KB (12 %) repeats lines already sent in the session; 114 KB are lease heartbeat lines; static block on 357/888 turns | ~0.9 M tokens of briefing in the window, plus ~10 k tokens per tools.list call per new runtime | `agent-collaboration-store.ts:74,312-345`; `turn-briefing.ts:175-181` ledger resets on every runtime; `agent-control.ts:1222` tools.list has no filter | lease delta, ledger survives resume, `tools.list({brief,prefix})` | M |
| H13 | A wizard cannot answer local/external approvals, contrary to AGENTS.md ("approvals are reviewed and answered for the owner") | AC10: 8 refusals / 2 wizard tabs on 09-28 11:24-11:38 (agent_mul36oi2_t90a5gk, agent_mul69e93_at3uf5h) | owner interrupt per approval | `permission-grants/service.ts:323` `actor === 'wizard' && !wizardMayDecide(request)` | let the wand answer every class, or say which classes it may answer in the wizard briefing | S, owner decision |
| H14 | Codex and Grok get no conductor MCP tools, yet cross-project replies tell every wizard (Astra included) to "Reply with send_message"; Codex steering queues until the turn ends | D11: 29 queued messages / 14 Codex tabs; G10 (no count: the tool never existed) | shell round trips with the token, classifier denials, replies that never happen | `control-mcp.ts:98` `spec.provider !== 'claude'`; `providers/codex.ts:409` thread config without the conductor server; `agent-control.ts` deliverToWizard text (~`:870`) | serve the MCP server to Codex; provider-aware reply text | M, owner decision |
| H15 | About 50 error strings end without a next step (dead-end "caller no longer has an open tab", unknown method with no echo or suggestion, read-only refusals, conflicts that do not name the other party, 401/429) | AC11: 6 "another agent already controls" / 5 agents; AC14: 3; "no longer has an open tab" 6 / 2; local.servers "Unknown control method" 10 / 7 (docs ahead of the installed build) | a wasted call and a guess each; the dead ends strand finished work | table in Part 2 of `.conductor-scratch/gap-sweep/code-findings.md`; `agent-control.ts:421,1124,2343`, `:1573` and 4 more, 14× "read-only or planning", `:589,567,1473,1483,2190`; `agent-control-server.ts:217,223,239`; `control-mcp.ts:136,170,174,177` | one text pass, with a build-version hint on unknown methods | S |
| H16 | Coworkers hit Claude Code's own denials with no harness guidance: classifier denials, classifier outage, and Conductor's PreToolUse hook timing out ("every tool call is now blocked") | D1: 63 denials / ~25 agents; D2: 59 outage refusals / 7 agents on 09-28 09:03-14:05; D3: ~25 hook timeouts / 9 agents on 09-25 (agent_mugozcvg_u4q1l40 12:33) | agents stop and hand work to the owner (agent_mud4e9tq_8o89wie 09-22 20:59) | Claude Code side for D1/D2; `providers/claude.ts:243` hook timeout for D3 | notice with a retry rule on outage; hook health and a fail policy | M, owner decision |
| H17 | The app-control token is stored in clear in conductor.db when passed as `CONDUCTOR_CONTROL_TOKEN=<hex>` or embedded in `node -e` scripts; only `Bearer <x>` is masked | 7 calls in one tab plus swarm scripts | credential at rest; classifier "Auto-Mode Bypass" denials when the token is on a command line | `structured-store.ts:17-21` sanitizeDiagnostic patterns | mask the exact live token and any `CONDUCTOR_CONTROL_TOKEN=` value | S |
| H18 | Shell hygiene the harness could pre-empt: Bash heredoc scripts mangled, `Blocked: sleep` polling, `run_and_summarize` timing out on a long test | 54 heredoc failures / 52 agents; 43 sleep blocks / 42 agents; AC12: 5 run_and_summarize timeouts / 5 agents | ~100 wasted calls, once per long session | no hint in the static block; `local-assist` tool description does not state its timeout | two sentences in the Claude static block; timeout stated in the tool description | S |
| H19 | Local-model control refusals name neither the method nor the key, and small models repeat the refused call | D7: 37 denials / ~12 agents; R6: 40 "repeating an action without progress" notices / 24 tabs | wasted local rounds, runs stopped | `local-models/tools.ts:66,79` | name the method, the allowlist and the offending key | S |

## Fix specs

Each spec: desired behavior, files, the test that proves it, size. Search for the quoted string
rather than trusting a line number.

### H01 Refusal bodies and the stale static paragraph (S)

Root cause: `agent-control-server.ts:200` briefing text: "Use the native shell's HTTP client
(PowerShell Invoke-RestMethod or curl.exe)". Windows PowerShell 5.1's Invoke-RestMethod throws
"(400) Bad Request" and keeps the body only in `$_.ErrorDetails.Message`; `-SkipHttpErrorCheck`
does not exist in 5.1. The same paragraph says git.ship does "tests, build, commit, push, release
check" (AGENTS.md: a delivery is a local commit; only `publish:true` pushes), says "you cannot drive
yourself or your ancestors" with no alternative, and sends every new runtime to a 40 KB
`tools.list`.

Desired:
1. Replace the client sentence with: `Prefer the conductor MCP tools when you have them (H02). From a shell use curl.exe -s; a refused call is HTTP 400 whose JSON body {"error":"..."} says what to do next, and Invoke-RestMethod hides it unless you catch it: try { Invoke-RestMethod ... } catch { $_.ErrorDetails.Message }.`
2. Replace the git.ship clause with: `git.ship({message,paths?}) runs tests, build and a local commit on the host (publish:true, only when asked, also pushes and builds the release); never escalate the sandbox for git.`
3. Replace the ancestor clause with: `You cannot control yourself or your ancestors; to reach your controller use report (agents.report) or send_message.`
4. Replace the discovery clause with: `tools.list({brief:true}) lists methods; tools.list({prefix:"agents."}) gives full signatures for one family.` (H12 adds the filter; ship this text with H12 or after it.)
5. `docs/agent-control.md`: add a "Reading a refusal" paragraph with the same two lines, and a model-alias table (opus → opus[1m], fable → claude-fable-5-1, astra → gpt-6-astra, sol → gpt-5.6-sol, sonnet, haiku; keep it in sync with `agent-manager.ts:84-90`).
6. AGENTS.md "Ask the owner" section: one bullet: `If tools.list lacks a method named in these docs, the installed build is older than the checkout: run app.update (or ask a wizard to) instead of working around it.` (AC7: `local.servers` returned "Unknown control method" 10 times.)

Files: `src/main/agent-control-server.ts`, `src/main/agent-control-server.test.ts`,
`docs/agent-control.md`, `AGENTS.md`.
Test: `agent-control-server.test.ts` asserts `briefing(spec)` contains `ErrorDetails`, `curl.exe`,
`publish:true`, `agents.report`, and does not contain `push, release check`. Net size stays about
1.7 KB.

### H02 A generic `control` MCP tool (S-M)

Root cause: `control-mcp.ts` exposes six fixed tools; everything else goes through a hand-written
HTTP call with the bearer token in the command line. That produces quoting failures (AC5), hidden
400 bodies (AC1), token leakage (H17) and classifier denials of the call itself (AC13, "Auto-Mode
Bypass" on router.dispatch, agents.steer and request_permission).

Desired:
- Add tool `control` with input `{method: string, args?: object}` to the conductor MCP server. It
  calls `AgentControl.call(scope, method, args)` with the same credential and classes as the HTTP
  endpoint (`control-method-classes.ts`), so owner-only and destructive rules are unchanged.
- A refusal returns `isError: true` with the exact `{error}` text (never a bare status).
- Description: `Call any Conductor app-control method (tools.list, agents.*, tabs.*, git.ship, ...) without a shell; same scope and rules as the HTTP protocol. Refusals come back as text that says what to do next.`
- The briefing (H01) and `docs/agent-control.md` name it first; the HTTP paragraph stays for
  providers without MCP (H14 removes that need for Codex).
- Keep the six existing tools; `send_message`/`report` stay the coworker's normal path.

Files: `src/main/permission-grants/control-mcp.ts`, `src/main/permission-grants/service.test.ts`
(block "the conductor MCP server", ~`:225`).
Tests: `control({method:'tools.list',args:{brief:true}})` returns the method list; a refused
mutation returns `isError` with the server's error text; an owner-only method from a non-wizard
credential is refused with the same text the HTTP endpoint gives.
Owner decision: none. It adds no reach; it moves existing reach off the shell.

### H03 git.ship queue and run history (M)

Root cause: `delivery.ts:443-445` refuses a second ship with
`Delivery ${active.run.id} is already running for this project; wait for it or cancel it first.`
(the agent must not cancel another worker's run). `delivery.ts:388-391` `current()` keeps only
`this.latest.get(projectId)`, so `git.ship.status({runId})` for a superseded run answers
`agent-control.ts:1991` "That delivery is no longer the latest one for this project" and `wait()`
(`:471-473`) "No delivery ${runId} is known for this project."

Desired:
1. **Queue.** A `git.ship` while another delivery runs is accepted and returns
   `{runId, status:'queued', behind:<runId>, position:n}`. Runs execute FIFO per project. Each
   queued run re-runs preflight when it starts (the snapshot is taken in preflight, so a queued run
   verifies the tree as it is then; `paths` keeps it isolated as today).
2. `git.ship.status({runId, waitSeconds})` waits on a queued or running run and returns its final
   state. `git.ship.status({})` with no runId returns the caller's most recent run, not the
   project's.
3. Keep the last 10 runs per project in a bounded map; `wait()` and `status` answer from it. Remove
   the "no longer the latest one" error.
4. If queueing is made opt-in (owner decision), the busy text becomes:
   `Delivery <id> (requested by "<title>") is already running for this project; nothing was started. Call git.ship.status({runId:"<id>",waitSeconds:100}) until it settles, then call git.ship again, or pass queue:true to run after it.`
5. `git.ship.cancel` stays owner/wizard/own-run only.

Files: `src/main/delivery.ts`, `src/main/delivery.test.ts`, `src/main/agent-control.ts`
(`git.ship.status`, signature at `toolSignatures`), `src/main/agent-control.test.ts`.
Tests: two ships back to back → second is `queued`, runs after the first, both outcomes readable by
runId; `wait(projectId, A.id)` after B started returns A's final state; a queued run whose preflight
fails reports the failure on its own runId.
Owner decision: queue by default (recommended: it is what every worker does by hand today) or
opt-in `queue:true`.

### H04 verify-kit load check (S-M)

Root cause: `scripts/verify-kit.mjs:1010-1037` `midTurnTabs` loops projects × workspaces and posts
`scope:{projectId,workspaceId}`, but `agent-control-server.ts` ignores `scope` for a conversation
credential (`const scope = owner ? this.control.ownerScope(input.scope) : credential!.scope`). Every
iteration therefore returns the caller's own `agents.list`, which (via `reachableElsewhere`,
`agent-control.ts:944`) includes every uncontrolled tab in every other project, so a Haftheme
wizard's turn blocks a Conductor smoke; same-project tabs in other workspaces and other projects'
coworkers are never counted. `:42` `MID_TURN_PHASES` includes `waiting_approval` (waiting on the
owner is not load). `:305` reason is `${n} mid-turn tab(s) besides the caller` with no names and no
override, although `sample.midTurn.tabs` has them. Hard-fail consumers:
`scripts/run-local-acceptance.mjs:88-92`, `scripts/smoke-codex-async-questions.mjs:43-44`.

Desired:
1. One `agents.list` call; keep `projectId`/`crossProject` per tab.
2. `MID_TURN_PHASES = starting|running|interrupting`; `waiting_approval` goes to `midTurn.waiting`
   (INFO).
3. `judgeLoad` counts only the caller's project by default; other projects' tabs are listed in
   `midTurn.elsewhere` (INFO) and affect `quiet` only with `loadCheck({otherProjects:'count'})`.
   Machine load is already measured by CPU, GPU and llama `/slots`.
4. Reason text: `2 mid-turn tab(s) besides the caller: "Worker A" (agent-x, running), "Worker B" (agent-y, starting). Wait for them to settle and re-run, or, if they are yours, pass loadCheck({selfTabs:['agent-x']}) or set CONDUCTOR_LOAD_IGNORE_TABS=agent-x,agent-y.`
5. Honour `CONDUCTOR_LOAD_IGNORE_TABS`.

Files: `scripts/verify-kit.mjs`, `scripts/verify-kit.test.mjs` (imports `judgeLoad`, `midTurnTabs`
at `:7`), `scripts/run-local-acceptance.mjs` if its `allowed` list needs the new fields.
Tests: other-project running tab → quiet; same-project running tab → not quiet and the reason names
title and id; `waiting_approval` not counted; stub fetch sees exactly one agents.list call; the
ignore env var removes a listed id.
Owner decision: whether other projects' turns count as load. Recommendation: INFO only, because
`docs/machine-profile.md` limits are about CPU/GPU, which loadCheck measures directly.

### H05 orchestration.tasks.update aliases and errors (S)

Root cause: `agent-control.ts:1552-1555` reads `text(args,'id',160)`; `:97-98` throws
`Invalid id`. The dispatch result (`:2256`, `:2273`) and the native footer (`:2242` "Conductor
orchestration task: <id>. Mark it done with orchestration.tasks.update") hand the worker a `taskId`,
so workers send `{taskId, status, result}`; unknown keys are not rejected.

Desired:
- Accept `taskId` as an alias of `id`. Reject unknown keys by name, as `tabs.open` does
  (`:1099`): `orchestration.tasks.update accepts only id, title, description, priority, status, assignedAgentId; result, summary is not an argument. Put results in agents.report or the task description.`
- Missing id: `orchestration.tasks.update needs id (the task id from router.dispatch, e.g. task_...); orchestration.snapshot lists them.`
- Footer text becomes: `Mark it done with orchestration.tasks.update({id:"<task.id>",status:"done"}) only after finishing.`
- Generalise: `text()` at `:95-98` gets the method name in its error (`agents.report: text is required`), which fixes the bare `Invalid ${key}` for every method.

Files: `src/main/agent-control.ts`, `src/main/agent-control.test.ts`.
Tests: update with `taskId` succeeds; unknown `result` key is refused naming it; `Invalid id`
never appears.

### H06 Approval delivery into a running turn (M)

Coordinate with the open item `permission-approval-delivery-classifier` (feature-list.md:23,
claimed by agent_mulfzb8r_53yryww and agent_mulgbp9b_6fvvmin) before starting; this spec is the
harness half of that item.

Root cause:
- `permission-grants/wiring.ts:126-132`: after `sessions.queue(...)`, the heads-up is steered only
  `if (state.capabilities?.steering)` at that instant. Claude's steering is true only while
  `ready && active && transport.connected` (`providers/claude.ts:150`); Codex's is false while
  dispatching (`providers/codex.ts:323`). Nothing retries or escalates; `service.ts:350-352` tells
  the owner "retries it in a message of its own once its current turn ends" with no bound;
  `service.ts:471` `sweep()` has no pending-retry path.
- `wiring.ts:33` `TURN_UNDER_WAY` lacks `'interrupting'` (`service.ts:84` ACTIVE_PHASES has it).
  In that phase `steerOrStart` throws "The conversation is still stopping its last turn"
  (`structured-sessions.ts:667-668`) after the grant was applied (`service.ts:338-351`), so the
  owner's decide call errors and the retry is never delivered.
- `request_permission` itself is sometimes denied by the classifier as "Auto-Mode Bypass" (D9: 2
  of ~12 calls). H02 removes the shell form; the MCP form is already a tool call the classifier
  sees as MCP.

Desired:
1. Record `headsUpSent` per grant. In `sweep()`, for a grant whose retry is still queued and whose
   heads-up was not sent, steer it once when `capabilities.steering` becomes true.
2. After 120 s with the retry still queued and the phase under way, post one notice on the grant
   card and to the approver (owner or wizard): `The approved call is queued behind a turn that has run <n> min (last tool: <name>). Interrupt the turn to run it now (agents.interrupt).` Add an "Interrupt and retry" card action; a wizard approver may interrupt automatically (owner decision).
3. Phase `interrupting`: poll up to 30 s at 500 ms (pattern at `service.ts:613`), then
   `steerOrStart`; if still not settled, `queue` and return. Never throw after the grant is applied.

Files: `src/main/permission-grants/wiring.ts`, `src/main/permission-grants/service.ts`,
`wiring.test.ts` (block "delivering an approval", `:35`), `service.test.ts`. Renderer card action is
a separate renderer task (renderer files are under edit by others).
Tests: steering false at decide and true on the next sweep → exactly one heads-up; fake clock →
one notice after 120 s; phase `interrupting` then `completed` → `steerOrStart` once, no throw.
Owner decision: automatic interrupt by a wizard approver after the timeout.

### H07 Coworker to controller: send_message, agents.status, and the coworker hint (S)

Root cause: `control-mcp.ts:34` maps `send_message` to `agents.steer`; `agent-control.ts:1336`
`mutate = !['agents.snapshot','agents.history','agents.artifact'].includes(method)` treats steer and
`agents.status` as mutations; `:580-587` ends with `throw new Error('An agent cannot control itself or an ancestor')`.
Two instructions walk agents into it: footer `:2242` "coordinate through the provided app protocol"
and the briefing's "you cannot drive yourself or your ancestors". `turn-briefing.ts:41` FINISH_HINT
never names the controller or `report`; `callOpen` (~`:1117`) submits the prompt with no footer.

Desired:
1. `agents.steer` (and thus `send_message`) whose target is the caller's controller or any ancestor
   delivers the text exactly as `agents.report` does (origin label, steered or queued) and returns
   `{reportedTo:'controller', agentSessionId}`. `agents.submit` to an ancestor stays refused, with
   the text `...; use send_message or report to reach it`.
2. Add `'agents.status'` to the non-mutating list (`:1336`); it is a read (`:1337` lists it as
   `read`; `local-models/tools.ts:53` allows it).
3. Coworker hint (replace FINISH_HINT): `You are a coworker of "<controller title>" (<controllerId>). Report results with report (agents.report({text}), first 2000 chars delivered, the rest kept as an artifact). When your work is delivered and reported, end with agents.finish({}).` `TurnBriefingDependencies` gains `controller?(id) => {id,title}|null`, wired in `agent-manager.ts`. `tabs.open({prompt})` coworkers get the same hint (they get no footer today).
4. Footer `:2242`: "...Report to it with report (agents.report) when finished."
5. `control-mcp.ts:35` description: "...including your own controller".

Files: `src/main/agent-control.ts`, `src/main/permission-grants/control-mcp.ts`,
`src/main/turn-briefing.ts`, `src/main/agent-manager.ts`, tests `agent-control.test.ts` (near
`:407`, `:1205`), `permission-grants/service.test.ts` (`:225`), `turn-briefing.test.ts` (`:37`).
Tests: child's steer to controller resolves with `reportedTo:'controller'` and the controller's
timeline has the text; child's `agents.status` on the controller resolves; `agents.status` on a tab
controlled by a third agent resolves while `agents.steer` still rejects; first coworker compose
names the controller and `report`, second does not repeat it.

### H08 report never refuses (S)

Root cause: `agent-control.ts:1322` `text(args,'text',2000)` → `:97` "The text is 2,486
characters; the limit is 2,000."

Desired: accept up to 20,000. Deliver the first 2,000 characters (cut at a line break) followed by
`\n[... 486 more characters: agents.artifact({id:"<id>"})]`; store the full text as an artifact of
the reporting session (`structured_artifacts`, kind `report`). Return `{delivered:2000, total:2486, artifactId}`. The signature at `:172` says so. Never throw for length.

Files: `src/main/agent-control.ts`, `src/main/agent-control.test.ts`.
Test: a 2,486-char report resolves, the controller gets 2,000 chars plus the pointer, and
`agents.artifact` returns the whole text.

### H09 Model aliases, provider errors, dispatch atomicity (S-M)

Root cause: `agent-control.ts:1014` `entry.models.find(model => model.id === args.model)` then
`:1015` `throw new Error('Choose a model from models.list')`; same exact match at `:616`
(agents.configure), `:2493` (handoff), `:1939` (durable jobs). The Claude list
(`agent-manager.ts:84-90`) has `opus[1m]` and no bare `opus`; `shared/agent-model-selection.ts:6-9`
notes it. `shared/project-backlog.ts:29` heavy default is `opus`. `:1013` "This native provider is
unavailable" names no provider. In `dispatchRouter` the `open()` call (~`:2213`) is outside the
per-task try (~`:2222`), so task 2's bad model rejects the whole call after task 1 was opened and
prompted; the retry duplicates task 1.

Desired:
1. `resolveModel(entry, requested)`: exact id → case-insensitive id → `${requested}[1m]` → unique
   id or label containing the token (`fable` → `claude-fable-5-1`, `astra` → `gpt-6-astra`). Result
   carries `modelResolvedFrom`. Used by tabs.open, agents.configure, handoff, jobs.
2. Errors: `Model "opus" is not offered for claude here. Choose one of: opus[1m] (Claude Opus 5.5 (1M context)), claude-fable-5-1 (...), sonnet (...), haiku (...).`; when another provider has it: `"gpt-6-astra" is a codex model; pass provider:"codex" (you asked for claude).`; provider: `Provider "grok" is not available here; available: claude, codex, local (models.list).`
3. `project-backlog.ts:29` heavy default → `opus[1m]`.
4. `router.dispatch` validates provider, model, effort and permission for every task before
   opening anything; refuses with `Task 2 ("<title>"): <error>; no task was opened.` Also wrap
   `open` in the per-task catch so a late failure yields `{title, accepted:false, error}`.

Files: `src/main/agent-control.ts`, `src/shared/project-backlog.ts`,
`src/main/agent-control.test.ts`.
Tests: `tabs.open({model:'opus'})` opens `opus[1m]` with `modelResolvedFrom`; `nonsense` rejects
listing every id; `gpt-6-astra` with claude rejects with `provider:"codex"`; dispatch
`[valid,{model:'nope'}]` rejects with `/Task 2/` and opens no tab.
Owner decision (light): resolve silently when unique (recommended, reported in the result) or only
suggest.

### H10 agents.finish waits (S)

Root cause: `coworker-autoclose.ts:158` `cannot be finished yet: ${busy}. Finish it once agents.status shows it settled` and `:170` `This tab cannot finish yet: it has N background tasks still running`. Controllers poll.

Desired: `agents.finish({agentSessionId?, waitSeconds?})` (max 300): wait until the turn settles and
background tasks reach 0, then finish; on timeout, refuse with the current blocker and
`Retry with waitSeconds or agents.interrupt it first.` A self-finish with running background
tasks that belong to the same conversation is allowed when `force:true` (they die with the CLI
anyway; today the agent cannot end its own tab).

Files: `src/main/coworker-autoclose.ts`, `src/main/agent-control.ts` (signature),
`coworker-autoclose.test.ts`, `agent-control.test.ts` (near `:2379`).
Test: finish with `waitSeconds:5` on a tab that settles after 1 s resolves; on one that does not,
rejects naming the blocker.

### H11 Argument aliases and self-describing "accepts only" errors (S)

Root cause: `schedule-control.ts:41` `'schedules.pause': ['taskId']` with no aliases (7 tries in
agent_mul69e93_at3uf5h); `agent-control.ts:131` handoff error points at
docs/token-thrift-policy.md instead of listing the sections; "accepts only" errors at `:393, :664,
:917, :1099, :1234, :1320` are fine but inconsistent with methods that silently ignore extras.

Desired:
- One `validateArgs(method, args, allowed, aliases)` helper used by every method with a fixed
  argument list; aliases `id|scheduleId → taskId` for schedules.*, `taskId → id` for
  orchestration.tasks.update, `agentId|tabId → agentSessionId` where unambiguous. Error:
  `<method> accepts only <list>; <extra> is not an argument (did you mean <alias>?).`
- Handoff: `agents.handoff requires handoff: text of 200-12000 characters with these sections on their own lines, in order: <list from HANDOFF sections>.`

Files: `src/main/agent-control.ts`, `src/main/schedule-control.ts`, tests
`agent-control.test.ts` (`:1259-1269`), `schedule-control.test.ts`.

### H12 Briefing bloat (M)

Root causes and desired behavior, three independent parts:
1. **Lease lines** (`agent-collaboration-store.ts:74`, `:312-345`; caller `turn-briefing.ts:219-228`): active leases are resent on every message with fresh `heartbeat=`/`expires=`. Keep `leaseKey = sorted(agent|path|intent)` in the ledger and send lease lines only when the set changed (added: full line; released: `- Released: <path> by <agent>`). Drop `heartbeat=`; render `expires in ~N min`. Header only with content. Test in `turn-briefing.test.ts`: two composes with the same leases, the second has no lease line; `agent-collaboration-store.test.ts`: no `heartbeat=`.
2. **Ledger reset on resume** (`turn-briefing.ts:175-181` `observe()` resets on every new runtime): a resume or reconnect of the same provider session keeps the model's context, so the 4.2-4.6 KB static block and the recalled memories (38 % of all briefing bytes) are resent needlessly on 40 % of turns. Reset the ledger only when the provider session id changes or after `CONTEXT_RESET`; keep the per-runtime key by provider session id, not process. Needs one probe per provider that a resumed CLI session still holds the earlier system context (Claude `--resume` does; Codex thread resume does). Test: a runtime restart with the same provider session id does not resend the static block.
3. **`tools.list` filter** (`agent-control.ts:1222`, 37-41 KB): `tools.list({brief?:true, prefix?:string, methods?:string[]})`; `brief` returns `method: '(args)'` only (about 4 KB); `prefix`/`methods` return full text for those; unknown keys refused by name; no-args unchanged. Test: brief is under 6 KB with every key; `prefix:'git.'` has only `git.*`.
4. **Legacy PTY submit path** (`agent-manager.ts:544-550`) prepends the control paragraph and full coworker briefing to every message. Check whether any live tab still uses the non-structured path; if so route it through `TurnBriefings.compose`.

Files: `src/main/agent-collaboration-store.ts`, `src/main/turn-briefing.ts`,
`src/main/agent-control.ts` (tools.list only), `src/main/agent-manager.ts`, their tests.

### H13 Wizard answers local/external approvals (S, owner decision)

Root cause: `permission-grants/service.ts:323` `if (actor === 'wizard' && !wizardMayDecide(request)) throw new Error('Only the owner can answer a ${request.class} request; the card is in the conversation's tab')`.
AGENTS.md says the wand makes the tab the owner for app control and "its coworkers' approvals are
reviewed and answered for the owner". The wizard hit this 8 times in 14 minutes.

Owner decision: (a) the wand answers every class (recommended: the wand is the owner's authority,
and the wizard is a frontier model reviewing a coworker), or (b) keep the restriction and say so
in the wizard briefing and in AGENTS.md, with the refusal text naming the classes it may answer:
`A wizard answers <classes> requests; this one is <class>, which only the owner answers from the card in "<tab>".`
Files: `src/main/permission-grants/service.ts`, `service.test.ts`, AGENTS.md.

### H14 Conductor MCP tools for Codex (M, owner decision)

Root cause: `control-mcp.ts:98` `if (!this.endpoint || this.disabled || spec.provider !== 'claude') return ''`; `providers/codex.ts:409` thread config merges only browser and local-assist servers; `agent-control.ts` `deliverToWizard` (~`:870`) says "Reply with send_message to <id>" to every wizard, and the `tabs.open` signature (`:151`) "the wizard replies with send_message". Codex steering is unsupported mid-turn (`structured-sessions.ts:704`), so 29 messages queued until the turn ended; that is a provider limit, but an MCP `report` from the Codex side removes the need for most of them.

Desired: serve the conductor MCP server (including H02's `control`) to Codex; filter
`request_permission`/`list_permissions` out of `tools/list` for non-Claude credentials; Codex
auto-answers MCP elicitations for enabled servers (`codex.ts:68-73`). Until then, make the reply
text provider-aware: `Reply with ${provider==='claude' ? 'send_message' : 'agents.steer'} to <id>`.
Settle the config merge with a stdio JSON-RPC probe first (memory: codex-app-server-protocol-probes).
Files: `src/main/permission-grants/control-mcp.ts`, `src/main/providers/codex.ts`,
`src/main/local-assist/mcp-config.ts`, `src/main/agent-control.ts` (texts), tests in
`service.test.ts` and the codex adapter test (`mcp_servers.conductor` present).
Owner decision: a new tool surface for Codex.

Done (batch 5, not yet shipped): offline probe on codex-cli 0.155.1 (initialize, config/read,
thread/start, mcpServerStatus/list; no model turn): a thread config whose `mcp_servers` holds
`conductor` and `conductor-local` starts both ready beside the CLI's own servers, with the bearer
header, a matching Host and no Origin, so ConductorMcpServer's checks pass unchanged.
`ConductorMcpServer.configure` mints Codex's form (`mcp_servers.conductor`, `http_headers`,
`tool_timeout_sec: 180` because Codex's default 60 s is shorter than git.ship.status waits);
`codexConductorThreadConfig` (local-assist/mcp-config.ts) validates it and the adapter merges and
relays it like conductor-local; structured-sessions passes it to Codex (not the permission grants).
A Codex credential's tools/list leaves out request_permission/list_permissions and a call to them is
refused with the tools it has. The `report` tool takes 20000 characters (H08).

### H15 Error-text pass (S)

Use Part 2 of `.conductor-scratch/gap-sweep/code-findings.md` as the checklist (about 50 strings
with a suggested suffix each). The must-haves:
- `agent-control.ts:421,1124,2343` "The caller no longer has an open tab" →
  `This conversation's tab was closed while its turn was running, so Conductor accepts no control calls from it (report, send_message and git.ship included) and nothing was done. End this turn with your result as your final message: the paths you changed, the commit message you meant to ship and what you verified; your controller or the owner reads it with agents.history.` (Optional, owner decision: still allow `agents.report` when a link names a controller.)
- `:1573` and `:1530, :1994, :2072, :2132` "Unknown control method; use tools.list" →
  `Unknown control method "<name>" in build <version>. Did you mean <closest>? tools.list({prefix:"<family>."}) lists that family; if the method is newer than this build, app.update installs the checkout's build.` Alias map (`agents.send|agents.message|agents.reply → agents.steer`, `git.commit|git.push → git.ship`, `tabs.create|agents.open|agents.start → tabs.open`, `agents.close|agents.done → agents.finish`, `agents.get → agents.status`) then edit distance ≤ 3.
- 14× "This conversation is read-only or planning" (`:648, 1321, 1470, 1480, 1506, 1511, 1516, 1521, 1891, 1932, 1998, 2095, 2121, 2133`) → one constant: `This conversation is read-only or planning, so <method> was refused. The owner can switch this tab out of plan/read-only in its composer; otherwise hand the change to a writable coworker (tabs.open) or report what should be done (agents.report).`
- Conflicts name the other party: `:589` → `"<tab>" is controlled by "<title>" (<id>); send_message that controller, or ask it to agents.release the tab.`; `:567` likewise; `:1473` names the lease holder, path and expiry; `:1483` names the task owner; `:2190` says which of missing/finished/owned applies.
- `agent-control-server.ts:217` 401, `:223` 429 (`...wait for one of them to answer; do not resend a mutation that timed out: check agents.list / git.ship.status first`), `:239` (add the example body); `control-mcp.ts:136, :170` (list the tools), `:174` (`the call may already have taken effect; check before repeating`), `:177`.
Files: `src/main/agent-control.ts`, `src/main/agent-control-server.ts`,
`src/main/permission-grants/control-mcp.ts`, tests alongside. Each new text gets one assertion.

### H16 Claude Code denials and Conductor's hook (M, owner decision)

Evidence: D1 63 classifier denials (Production Reads 8, Interfere With Workloads 7, Auto-Mode
Bypass 4, ...); D2 59 refusals during a classifier outage on 09-28 09:03-14:05; D3 ~25 calls blocked
on 09-25 by "PreToolUse hook did not respond before its timeout (host client may be unreachable)"
(`providers/claude.ts:243` registers `conductor_before` with `timeout`).

Desired:
1. Outage: when the harness sees `Classifier unavailable`/`gave no verdict` denials, post one
   notice to the tab: `Claude's auto-mode classifier is unavailable; this is transient. Retry the same call in 60 s; if it is still refused after 3 tries, request_permission for it.` (turn-briefing nudge, once per runtime.)
2. Hook: log hook round-trip time; if the host was unreachable, the notice says so and the wizard is
   told (`app.state` health flag). Owner decision: fail-open for read-only tools when the hook host
   is down, or keep fail-closed.
3. The H02 `control` tool moves app-control calls off the shell, which is where the "Auto-Mode
   Bypass" verdicts came from (a bearer token in a command line looks like a bypass).
Files: `src/main/providers/claude.ts`, `src/main/turn-briefing.ts`, tests.

Done (batch 4, not yet shipped): PreToolUse registers `matcher: PRE_TOOL_USE_MATCHER`, a regex
that leaves out Read, Glob, Grep, LS, NotebookRead and the readOnlyHint tools of conductor-local
and conductor-browser (checked against the 2.1.282 matcher: non-list matchers are `new RegExp`,
and no legacy alias names a read), so reads never wait for the hook; the rest stay fail-closed.
The approval gate's durable-denial fence no longer sees those five MCP reads (it already let the
built-in reads through). A CLI the app started waits 20 s against Conductor's 15 s budget. Every
hook answer is timed (slow ones over 2 s logged); `app.state.claudeHooks` (owner/wizard scope,
assembled in `src/main/agent-control.ts`) reports `unreachable` (a failure in the last 10 min),
counts, average/max/last ms and the last failure. Claude Code's "PreToolUse hook did not respond"
/ "failed with an unexpected error" results become one `hookUnreachable` notice per runtime; the
classifier-outage notice is also one per runtime now. `OUTAGE_NUDGES` in turn-briefing.ts adds the
retry rule to the next message once per runtime per kind (ledger `outagesNudged`, persisted).

### H17 Mask the control token everywhere in the journal (S)

Root cause: `structured-store.ts:17-21` `sanitizeDiagnostic` masks `Bearer <x>`, `sk-`/`gh` keys and
`api_key|access_token|refresh_token|password|authorization` assignments. `CONDUCTOR_CONTROL_TOKEN=<64 hex>`
and a literal token inside `node -e` scripts are stored in clear (7 calls in one tab, plus swarm
scripts).

Desired: mask `CONDUCTOR_CONTROL_TOKEN\s*[=:]\s*\S+`, any `[a-f0-9]{64}` that equals the live control
credential (the store can be given the current token, or the sanitizer a predicate), and
`token\s*[=:]\s*[a-f0-9]{64}`. Backfill is not required (the DB is 6.4 GB); note it in the doc.
Files: `src/main/structured-store.ts`, `structured-store.test.ts`.

Done (batch 3, not yet shipped): `maskSecrets` masks `CONDUCTOR_CONTROL_TOKEN=`, `token: <64 hex>` and any 64-hex run a live server recognises (`registerSecretCheck`, registered by agent-control-server). Backfill added after all, on the controller's word: `redactSecretsStep` walks structured_events, the archive, resident projections and archive tails, then projection and spec rows, 200 rowid-ordered rows per step every 100 ms from 60 s after launch, with a durable cursor in structured_meta (`secret_redaction_v1`). Read-only dry run on the owner's 6.5 GB journal (2026-09-28, 209 s, 103 live tokens): events 5,129,180 scanned / 5,559 candidates / 1,488 to rewrite in 59 conversations; archive 1,408 / 18 / 1; projections 778 / 336 / 65; specs 778 / 0 / 0. Not covered: 6 of 1,343 output artifact files (agent-artifacts/*.txt) hold a token.

### H18 Shell-hygiene hints and the local-assist timeout (S)

Desired: add two sentences to the Claude static block (once per runtime, `turn-briefing.ts`):
`Write scripts with the Write tool and run them with node; Bash heredocs get mangled here. Do not sleep-poll: agents.status, git.ship.status({waitSeconds}) and run_and_summarize wait for you.`
`run_and_summarize` description (`src/main/local-assist/mcp-server.ts`) states its timeout and
says: `for a run longer than <N> min (the full npm test), run it as background Bash and summarize its log file instead.`
Files: `src/main/turn-briefing.ts`, `src/main/local-assist/mcp-server.ts`, tests.

### H19 Local-model refusals name the method and key (S)

Root cause: `local-models/tools.ts:66` `'Conductor method is unavailable in this mode'` covers both
"not allowlisted" and "read-only turn"; `:79` `'Conductor scope and unsupported arguments cannot be overridden'` names neither the key nor the allowed ones. Small models repeat the call (R6: 40 "repeating an action without progress" notices in 24 tabs).

Desired: `"<method>" is not a Conductor method a local model may call; these are: <LOCAL_CONTROL_METHODS>.` / `"<method>" changes something and this turn is read-only; ask your controller (agents.report) to do it.` / `<method> does not take <key>; it takes <fields>. projectId, workspaceId and agentId come from your session and cannot be passed.`
Files: `src/main/local-models/tools.ts`, `local-models/tools.test.ts`.

## Batches

Each batch has at most three fixes and no shared files, so three Opus fixers can run in parallel and
ship with `git.ship({paths})`. `agent-control.ts` appears at most once per batch. Highest value first.

| batch | fix | files |
|---|---|---|
| 1 | H01 refusal bodies + stale paragraph + docs | `src/main/agent-control-server.ts`, `agent-control-server.test.ts`, `docs/agent-control.md`, `AGENTS.md` |
| 1 | H04 verify-kit load check | `scripts/verify-kit.mjs`, `scripts/verify-kit.test.mjs`, `scripts/run-local-acceptance.mjs` |
| 1 | H07 coworker ↔ controller (send_message, agents.status, coworker hint) | `src/main/agent-control.ts`, `src/main/permission-grants/control-mcp.ts`, `src/main/turn-briefing.ts`, `src/main/agent-manager.ts`, their tests |
| 2 | H03 git.ship queue and run history | `src/main/delivery.ts`, `delivery.test.ts`, `src/main/agent-control.ts`, `agent-control.test.ts` |
| 2 | H02 generic `control` MCP tool | `src/main/permission-grants/control-mcp.ts`, `permission-grants/service.test.ts` |
| 2 | H12 parts 1, 2, 4 (leases, ledger on resume, PTY path) | `src/main/agent-collaboration-store.ts`, `src/main/turn-briefing.ts`, `src/main/agent-manager.ts`, tests |
| 3 | H09 + H05 + H11 + H08 argument/alias pass (one fixer; all in agent-control.ts) | `src/main/agent-control.ts`, `src/shared/project-backlog.ts`, `src/main/schedule-control.ts`, tests |
| 3 | H06 approval delivery (coordinate with feature-list.md:23 claimants) | `src/main/permission-grants/wiring.ts`, `service.ts`, `wiring.test.ts`, `service.test.ts` |
| 3 | H17 token masking + H18 hints + H19 local refusals | `src/main/structured-store.ts`, `src/main/local-assist/mcp-server.ts`, `src/main/local-models/tools.ts`, `src/main/turn-briefing.ts` (H18 sentence only; H12 has landed by then), tests |
| 4 | H15 error-text pass + H10 finish wait + H12 part 3 (tools.list filter) | `src/main/agent-control.ts`, `src/main/agent-control-server.ts`, `src/main/permission-grants/control-mcp.ts`, `src/main/coworker-autoclose.ts`, tests |
| 4 | H13 wizard decides local/external (after the owner decides) | `src/main/permission-grants/service.ts`, `service.test.ts`, `AGENTS.md` |
| 4 | H16 classifier-outage nudge and hook health | `src/main/providers/claude.ts`, `src/main/turn-briefing.ts`, tests |
| 5 | H14 conductor MCP for Codex (after the owner decides; probe first) | `src/main/permission-grants/control-mcp.ts`, `src/main/providers/codex.ts`, `src/main/local-assist/mcp-config.ts`, `src/main/agent-control.ts` (reply texts), tests |

Sequencing notes:
- Batch 1's H01 text says `tools.list({brief:true})`; that filter lands in batch 4 (H12 part 3).
  Either ship H01 without that sentence and add it in batch 4, or move the tools.list filter into
  batch 1's H07 slot (same file). Recommended: move it into H07's slot; it is 30 lines.
- H05's `text()` change (method name in `Invalid <key>`) touches the same helper H08 uses; they
  are in the same slot on purpose.
- The controller publishes once after the batches are verified together (AGENTS.md chain of
  command); workers never pass `publish:true`.

## Owner decisions

1. **H03:** queue a second `git.ship` by default (recommended) or only with `queue:true`.
2. **H04:** other projects' running turns count as smoke load or are INFO only (recommended INFO;
   CPU/GPU are measured directly).
3. **H06:** may a wizard approver interrupt a turn automatically after the approved retry has waited
   120 s?
4. **H09:** resolve model aliases silently when unique (recommended, reported in the result) or
   only suggest.
5. **H13:** does the wand answer local/external approval classes? (Recommended yes; AGENTS.md
   already promises it.)
6. **H14:** give Codex the conductor MCP tools (new tool surface; needs a protocol probe first).
7. **H15:** allow `agents.report` from a conversation whose tab closed mid-turn, when a link still
   names its controller.
8. **H16:** fail-open for read-only tools when Conductor's PreToolUse hook host is unreachable, or
   keep fail-closed.

## Top 10 by value

1. H01 refusal bodies and stale paragraph (180 wasted calls; unblocks every other error text)
2. H02 generic `control` MCP tool (removes shell quoting, token leakage and bypass denials)
3. H03 git.ship queue (101 refusals, poll loops, idle swarms)
4. H04 smoke admission counts the right tabs (119 blocked smoke runs)
5. H06 approvals reach the running turn (owner interrupts, hour-long idles)
6. H07 coworker ↔ controller path and hint (every worker detours once)
7. H12 briefing bloat (~0.9 M tokens per week; tools.list 10 k per runtime)
8. H05 tasks.update alias (37-62 refusals)
9. H09 model aliases and dispatch atomicity (2 extra round trips per dispatch; duplicate coworkers)
10. H08 report never refuses (56 wasted calls in one afternoon)
