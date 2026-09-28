# Auto-mode classifier denials and narrow owner grants

In Auto, the claude CLI's own classifier can refuse a tool call (`Permission for this action was
denied by the Claude Code auto mode classifier. Reason: [Modify Shared Resources] …`). Conductor
cannot override that classifier, and it must not try. What it does is turn the refusal into
**one narrow owner approval** and route the call into the narrowest permission flow the CLI
supports, so the tab can retry and verify the work itself.

## Boundary (owner, 2026-09-25)

- Never disable or weaken Claude Code's protections: no allow-all rules, no `bypassPermissions`,
  and nothing that lets an agent grant itself permission.
- Sensitive steps (production, shared, destructive, credentialed, external) still need an
  approval, but it is **one** approval the owner gives in Conductor.
- The owner answers in the card or with the owner's own control credential. A wizard tab holds
  the owner's authority (AGENTS.md) and answers **every** class, production included (owner
  decision 2026-09-28, gap H13); it never answers its own request.
- A grant is exactly one native allow rule for one conversation. It ends when its call has run
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
   Approve for this session and Deny (`src/renderer/src/components/permission-grants/`). Shared,
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
   running.
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
- **Precedence, observed live (2026-09-28, claude 2.1.282).** The haftheme tab
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
  - All three grants had the same rule text and the same live delivery. `refused` matched the rule
    both times and `used` matched it once, so scope, rule text and delivery path (H1, H2) do not
    explain the difference, and neither does a race (H3): each retry came 24 s or more after its
    apply. Every one of the four calls, including the one that ran, has its own
    `serverClassifierRequest` in the transcript: the classifier judged each call. A live
    flag-settings allow rule did not stop it from refusing.
  - The only difference is how the approval arrived: as a user turn, or as a queued command
    inside a running turn. The CLI's classifier transcript builder frames the two differently
    (`queued_command` attachments are rendered as mid-turn input). Its denial text also tells the
    agent to get the user's consent (`autoModeConsentFlow`). Conductor now always delivers the
    approval as a turn of its own (`retry` in `src/main/permission-grants/service.ts`), and the
    synthetic CLI encodes this precedence under `CONDUCTOR_TEST_CLASSIFIER=approval-turn`
    (`smoke-permission-grant.mjs`, step 3b).

## UNCONFIRMED

- **Precedence, what is still open:** the 2026-09-28 case is one observation. It shows that a live
  flag-settings rule does not beat the classifier, and that an approval arriving as a user turn got
  the call through. It does not show whether the rule contributes at all, whether a rule given at
  launch (`--settings`) behaves differently (no restart happened), or whether the classifier would
  refuse again in a context that weighs more heavily against the call. The owner ruled out a probe
  that deliberately provokes the classifier. Conductor keeps handing over the rule, which is
  harmless and is how an approve-once grant is spent, and still detects a grant that does not take
  effect.
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
