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
- A wizard tab may answer only **local** requests. Shared, destructive and external requests
  (production included) are answered only by the owner: in the card, or with the owner's own
  control credential.
- A grant is exactly one native allow rule for one conversation. It lives in memory only, and it
  ends when its call has run (approve once), when the owner revokes it, when its tab closes, or
  when the app restarts.

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
   `[Conductor] approved: <rule> (once|for this session); retry it now`. An approve-once grant is
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

If the classifier still refuses a call the owner granted, the grant is marked **ineffective** and
withdrawn. The owner is told to switch the conversation to Edit, where the next attempt raises an
ordinary Allow card.

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

## UNCONFIRMED

- **Precedence:** whether the real CLI in Auto lets a session allow rule (`--settings`, or
  `apply_flag_settings`) decide a call **before** its classifier sees it. The owner ruled out a
  probe that deliberately provokes the classifier, so this stays open. Conductor handles either
  outcome: a grant that does not take effect is detected when the call is refused again, and the
  owner is sent to the Edit-mode Allow card.
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
   This is external, so only the owner can answer it, and it reaches the owner's phone. After the
   approval, run exactly that command once and verify the result.

Each approval covers only its exact call. A changed command needs a new request.
