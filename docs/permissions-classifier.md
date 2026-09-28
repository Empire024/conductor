# Auto-mode classifier denials and narrow owner grants

In Guarded Auto (Claude's native `auto` mode), the CLI's classifier can refuse a tool call
(`Permission for this action was
denied by the Claude Code auto mode classifier. Reason: [Modify Shared Resources] …`). Conductor
cannot send an Allow once response after that refusal: the native request has already ended. A
narrow owner grant may let the tab retry, subject to Claude's rule matching and classifier.
Separately, the owner may explicitly enable genuine installation-wide Full Auto. Conductor Auto
then requests native `bypassPermissions` and counts it active only after provider acknowledgement.

## Boundary (owner decisions, 2026-09-25 and 2026-09-28)

- No allow-all rule, provider binary modification or managed-policy override. An agent cannot
  grant itself permission. The owner may explicitly activate Full Auto installation-wide; only an
  acknowledged native `bypassPermissions` mode counts as active. An unacknowledged or refused
  activation remains blocked and visible, with no silent fallback to Guarded Auto.
- Sensitive steps (production, shared, destructive, credentialed, external) need an approval when
  the owner has not enabled Full Auto. The native provider may still require an individual,
  request-specific approval where its policy mandates one.
- The owner answers in the card or with the owner's own control credential. A wizard tab holds
  the owner's authority (AGENTS.md) and answers **every** class, production included (owner
  decision 2026-09-28, gap H13); it never answers its own request.
- A representable grant is a narrow native allow rule for one conversation. A still-pending native
  request with no safely representable rule can instead receive an exact Allow once response,
  without changing the session's mode. A grant ends when its call has run
  (approve once), when the owner revokes it, or when its tab closes. Waiting requests and unspent
  grants survive an app restart or crash (`permission-grants.json` in the app's userData, restored
  before any runtime resumes); answered, spent and expired ones are not brought back.

## What happens

1. **Structured denial.** The Claude adapter registers the CLI's `PermissionDenied` hook
   (`conductor_denied`), which carries the exact tool, the exact input and the classifier's reason.
   The `tool_result` wording is parsed only as a fallback (`src/shared/auto-mode-denial.ts`).
   `describeGrantRequest` (`src/shared/permission-grants.ts`) derives the action, the exact
   resource (path, command, host, URL), the category, the class (local, shared, destructive or
   external) and the narrowest rule, for example `Edit(//c/…/app/prod/fix-pool.sh)` or
   `Bash(ssh … root@host bash -s < app/prod/fix-pool.sh)`. A command containing `*` or ending in
   `:*` is never turned into a rule, because the CLI would read it as a wildcard or prefix rule.
2. **The card.** The denial's notice in the conversation becomes a card with Approve once,
   Approve for this session and Deny when a narrow rule exists
   (`src/renderer/src/components/permission-grants/`). An unrepresentable call can receive Allow
   once only if the provider still has its exact `can_use_tool` request pending. An ended classifier
   denial cannot receive that response. Shared,
   destructive and external requests an agent files itself are also pushed to the owner's phone;
   a denial already reaches the phone through `phone-notifications.ts`.
3. **The grant.** On approval, `PermissionGrants` (`src/main/permission-grants/service.ts`) hands the
   live CLI its complete current rule set through the `apply_flag_settings` control request (the
   flag-settings layer, which nothing else uses). A CLI that cannot take it live is restarted
   with `--settings` once its turn ends. Conductor then tells the tab
   `[Conductor] approved: <rule> (once|for this session); retry it now` as **a user turn of its
   own**: queued behind a turn that is still working, never steered into it, and started at once
   when the tab is idle (the `retry` port, see Evidence 2026-09-28). An approve-once grant is
   withdrawn as soon as its call has run (the `PostToolUse` hook). Deny tells the tab not to retry
   or work around it. The grants list is visible and revocable in the card. A closed tab's grants
   are swept within about two seconds, and the rule is taken back out of a runtime that is still
   running. The lifecycle distinguishes owner authorization, applying a permission, observed
   execution, and a definite succeeded/failed/blocked/cancelled result. A process loss after
   authorization without a definite result is **unknown**; Conductor never retries that call
   automatically. `PreToolUse` merely precedes provider permission checks and does not prove
   execution. `tool_progress` can show a running call; `PostToolUse` or `PostToolUseFailure` supplies
   a definite outcome, including for a fast call with no progress event. A pending native Allow
   once card survives an app restart but is disabled until the same live runtime re-emits the
   same request, tool and arguments. An already authorized response without a confirmed result
   becomes unknown and is never replayed.
4. **Asking first.** An agent that knows a call will be refused (production, shared, external)
   calls `request_permission` (the `conductor` MCP server) or app-control `permissions.request`
   with exactly one of `{command | path | url}`, plus `reason` and `rollback`. The per-turn
   briefing (`PERMISSION_GRANT_HINT` in `src/main/turn-briefing.ts`) tells Claude tabs to do this,
   to split writing a script from running it, and never to hand the step to the owner to run.
5. **Messaging without a shell.** The `conductor` MCP server
   (`src/main/permission-grants/control-mcp.ts`) exposes `send_message` (agents.steer),
   `submit_task` (agents.submit), `report`, `handoff`, `request_permission` and `list_permissions`.
   Each tool runs as the calling conversation through app control, so no bearer token appears in
   a command line.

**While the approval turn waits** (gap H06, `deliver`/`follow` in `service.ts`, swept every second):

- The retry text names the conversation that made the call and when it was asked and approved.
- A heads-up, `[Conductor] approval queued: <rule>…`, is steered once into the running turn as soon
  as it can take one, telling the agent not to retry until the approval message arrives and to wrap
  up. It never carries the approval itself. It is a confirmed steer (`steerAccepted`) that never
  falls back to the queue, where it would sit behind the queued approval turn (Codex takes no steer
  while a turn is dispatching, compacting or ending); a refused one is tried again on the next sweep,
  an unconfirmed one counts as sent. An interrupt that expedites the queue can still send an unread
  heads-up together with the retry, just ahead of it, which the wording allows for.
- After 2 min with the turn still running, the tab says how long the turn has run and its last
  tool. An owner approval only gets that notice (Esc interrupts and sends the queue; Stop holds
  it). A wizard approval interrupts the turn with the queue expedited, so the retry runs at once.
- An approval turn still queued after 30 min is taken back out of the queue and its grant expires
  with a notice: a "retry it now" that late is no longer about the current work.
- A conversation still stopping its last turn (`interrupting`) is waited for up to 30 s; after that
  the approval stands and the retry is handed over again from the sweep. The decision never fails
  once the grant is applied.
- A handoff moves only grants approved in the last 10 min. An older unspent grant (a session
  grant is never spent) expires with a notice in the predecessor's tab instead of reaching the
  successor as a "retry it now" for a call it never made.

If the tab retries on its own while its approval turn still waits in the queue and is refused, the
grant stands and that denial's card joins the approved request; nothing is asked twice. If the
classifier still refuses the call after the approval turn started, the grant is marked
**ineffective** and withdrawn. The owner is told to switch the conversation to Edit, where the next
attempt raises an ordinary Allow card.

## Evidence

- **The case (2026-09-25):** the haftheme controller in Auto was refused `Write` of
  `app\prod\fix-lsphp-pool.sh` with `[Modify Shared Resources]`. The recorded `tool_result` is in
  `scripts/fixtures/haftheme-denial-2026-09-25.json`.
- **claude 2.1.282, checked statically:** the installed binary contains the `apply_flag_settings`
  control subtype and the `PermissionDenied` hook event name. This was a string search of the
  binary only: nothing was run against the classifier.
- **Parked smoke** `scripts/smoke-permission-grant.mjs` (`node scripts/smoke-lock.mjs -- node
  scripts/smoke-permission-grant.mjs`) passed 6/6 checks in two consecutive runs on 2026-09-26. It
  replays the recorded denial through the real adapter, main process and renderer, with a synthetic
  CLI (`scripts/fixtures/fake-claude.mjs`, `SYNTHETIC CLASSIFIER`) standing in for claude:
  - a local write is unaffected;
  - the card shows the exact action, resource, category, class and rule;
  - Approve once sends exactly that rule through `apply_flag_settings`, the tab retries and writes
    the file, and the grant is spent and withdrawn;
  - a different external action is still refused;
  - Deny keeps it blocked;
  - Approve for this session ends when the tab closes.
- **Haftheme sequence, observed live (2026-09-28, claude 2.1.282).** The haftheme tab
  (`agent_muldox0q_y4hp2rg`, native session `ff698e13-…`) was refused
  `cd …/app && ssh … root@45.63.56.18 'bash -s -- --check' < prod/fix-lsphp-pool.sh 2>&1 | tail -40`
  as `[Production Reads]`. Sources: Conductor's durable timeline (one runtime,
  `981b5f4d-…`, started 15:04:29Z, never restarted) and the CLI's own transcript.
  - 15:07:48Z first refusal. 15:09:12Z Approve for this session: the rule went live
    (`apply_flag_settings`) and the approval was **steered** into the turn, which was still working.
    The CLI recorded it only as a `queued_command` attachment, folded in at 15:10:02Z. The retry at
    15:10:05Z was refused (15:10:09Z) and the grant was declared ineffective.
  - 15:10:15Z second session approval, steered again (folded in at 15:10:36Z). The retry at
    15:10:39Z was refused (15:10:53Z).
  - 15:10:55Z Approve once, steered again. The turn was stopped at 15:10:58.089Z before the steer
    was folded in (an owner or wizard Stop, not the adapter). Conductor re-queued the cancelled steer as a
    new turn, so the approval reached the CLI as a **user message** (15:10:58.172Z). The retry at
    15:11:01Z ran (15:11:31Z), and the PostToolUse hook spent the grant.
  - The three grants had the same displayed rule and were applied live. That rule did not
    match this command, so these retries cannot establish precedence between a matching allow
    rule and the classifier, or between a queued steer and a user turn. The final retry ran in a
    different classifier context after an owner-approved user turn; this is an observation, not
    proof that delivery form was the cause.
  - **Corrected the same day (rule matching, below):** that rule could never have matched. The
    command was piped (`… | tail -40`) and read a file after a `cd` (`cd …/app && ssh … <
    prod/fix-lsphp-pool.sh`). The CLI checks a pipeline part by part and never lets a rule allow an
    input redirect after a `cd`. So every attempt went to the classifier, and the approval turn only
    changed what the classifier saw. The user turn is still how Conductor delivers an approval.
- **Rule matching, probed (2026-09-28, claude 2.1.282, owner-ordered).** Probing it through the
  classifier gave no clean signal. A call the user's own prompt dictates passes with or without a
  rule. The model itself declined a root ssh taken from a runbook before the classifier was asked.
  And the classifier's verdict on a nested `claude` run changed with the conversation's context.
  Rule matching was therefore probed where it is deterministic: headless `claude -p
  --permission-mode manual`, where a Bash call no rule allows is refused outright.
  `scripts/probe-permission-rule-matching.mjs` reruns it (10 cases, exit 1 on any difference):
  - An exact rule for a whole pipeline never matches it ("contains multiple operations. The
    following part requires approval: …"). An exact rule for each non-read-only `|` part does;
    `tail -5` needs none. `--settings` and `.claude/settings.local.json` behave identically, so
    writing the rule to a settings file would change nothing.
  - `&&` and `;` chains, `cd … &&` included, match the exact whole rule.
  - An input redirect matches the exact rule for that file only (`< input.txt` does not allow `<
    other.txt`).
  - An input redirect after a `cd` in the same command is never allowed by any rule: "Input
    redirection from 'input.txt' requires manual approval: the file it names depends on glob
    expansion or a directory change in the same command." In Auto that means the classifier decides.
  - Conductor therefore installs, for every grant, the exact rule the owner saw plus one exact rule
    per `|` part (`nativeGrantRules` in `src/shared/permission-grants.ts`). Each is a literal piece
    of the approved command, with no wildcard. A `cd … && … < file` command gets no card rule at all
    (`changesDirectoryBeforeInput`); its refusal tells the agent to ask again naming the file from
    the project root. `permissions.list` shows each grant's `nativeRules` and `installedIn`.
  - The rules stay in the conversation's session permissions (the flag-settings layer: live through
    `apply_flag_settings`, or `--settings` at launch). Revoking a grant, spending an approve-once
    grant or closing the tab takes them out again. A project's `.claude/settings.local.json` would
    also hand the rule to every other Claude tab of that project and outlive the grant, which the
    boundary above rules out. The SDK-style answer (`canUseTool` with `updatedPermissions`) does not
    apply either: a classifier refusal in Auto leaves no pending permission request to answer.
  - Whether a matching allow rule then also beats the classifier in Auto was not settled by a clean
    A/B. The classifier would not refuse on demand. One observation leans yes: this Conductor tab's
    own approved call, a simple `node … | tail` pipeline, ran mid-turn before its "retry it now"
    turn arrived. But its whole-command rule did not match (see the first point), so the classifier
    let it through in context, and that observation says nothing about rule precedence.

## UNCONFIRMED

- **Precedence, what is still open:** whether an allow rule that does match (see Rule matching)
  is honoured before the Auto classifier judges the call. The haftheme case never had a matching
  rule, so it does not answer this. A clean A/B needs a call the classifier refuses reliably in a
  fresh context, and none was found. Conductor still detects a grant that does not take effect
  (`ineffective`) and still delivers the approval as a user turn of its own.
- Whether the classifier also judges `conductor` MCP tool calls (`send_message` and the rest), and
  with which reasons. A message is no longer a `curl` command line, which removes the shape that
  was refused as `[Auto-Mode Bypass]`. The topic of a message may still be judged.
- **Not built:** a per-project "Edit inside this project's folders" setting. It only makes sense
  once precedence is confirmed; until then a standing rule might not work, and Edit mode already
  gives the owner that choice per conversation.

## For the haftheme controller

Do not ask the owner to run anything. Split the pool fix into two narrow requests, each approved
once in its own tab:

1. `request_permission({ path: "app/prod/fix-lsphp-pool.sh", reason: "write the pool fix script (not run)", rollback: "delete the file" })`
   Then write the script after `[Conductor] approved: Edit(…); retry it now`.
2. `request_permission({ command: "ssh -i <key> root@<host> bash -s < app/prod/fix-lsphp-pool.sh", reason: "apply the pool fix on production", rollback: "<the script's own revert>" })`
   This is external, so it reaches the owner's phone; the owner or a wizard tab answers it. After the
   approval, run exactly that command once and verify the result.

Each approval covers only its exact call. A changed command needs a new request.
