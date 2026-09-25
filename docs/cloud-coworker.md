# Cloud coworker

A controller (through app control) or the owner (through the launcher's **Claude Cloud** tile)
starts a **Claude Code cloud session** on the project's GitHub repository with a chosen model and
task. It shows up as an owner-visible `cloud` tab; Conductor follows it to the branch and pull
request it pushes, pulls its transcript and token usage, and fetches the result into a worktree of
its own so the controller verifies it locally and ships with `git.ship`. Conductor never merges and
never pushes `main` for it.

Code: `src/main/cloud/` (runs.ts: the run store and CLI driving; screen.ts: a small VT screen for
the client's TUI; control.ts: `cloud.*`; ipc.ts, register.ts), `src/shared/cloud.ts`,
`src/renderer/src/panes/CloudPane.tsx` and `CloudLaunchForm.tsx`. Fixture client:
`scripts/fixtures/cloud-cli.cjs`. Smoke: `scripts/smoke-cloud-coworker.mjs`.

## Using it

App control (this project, the caller's workspace):

| Method | What it does |
| --- | --- |
| `cloud.start({prompt, model?, effort?, ref?, title?, focus?})` | Creates the session and opens its tab (background unless `focus:true`). `model` from `models.list` provider `cloud` (default `claude-opus-5-5`); `ref` = base branch/tag/SHA **on GitHub**. |
| `tabs.open({provider:"cloud", prompt, model?, branch?})` | The same, in tabs.open's words (`branch` = base ref). |
| `router.dispatch({tasks:[{provider:"cloud", title, prompt, model?}]})` | The same per task (no `projectTaskIds`). |
| `cloud.list()` / `cloud.status({runId, lines?})` | Runs and their state; `status` re-checks origin now and adds what the client printed. |
| `cloud.transcript({runId, refresh?, limit?})` | The session's messages (user, assistant, tool calls, results) and `usage`; `refresh:true` pulls them now. Pulled once by itself when the branch is first pushed. |
| `cloud.fetch({runId})` | Fetches the pushed branch into `<userData>/cloud/worktrees/<runId>` (detached) and returns path, commit and diff stat. |
| `cloud.send({runId, message})` | Steer / follow up. Needs the CLI's attach gate (see below); otherwise refused with the reason and the session link. |
| `cloud.interrupt` / `cloud.attach` | Only with a live view (attach gate). |
| `cloud.stop({runId})` | Stop following: a live client interrupts and closes; otherwise `note` says the session finishes its turn in the cloud and where to stop it. |

Who may: reads are open to the project; starting, steering and pulling (they spend the owner's
cloud credit or run the CLI) follow `nodes.run`: the owner, a wizard tab, or a writable non-local
conversation.

Statuses: `starting` (creating) → `running` (session exists, nothing pushed) → `pushed` (its
branch is on origin; it may still be working, the head commit and PR keep updating) → `stopped`
(Conductor stopped following). `failed`: the client exited before a session existed (`error` holds
its last lines). Runs survive an app restart and are followed again; origin is polled every minute
for 24 hours.

**The cloud starts from GitHub.** Local deliveries are unpushed commits, so a cloud session does
not see them unless the batch was published or `ref` names a pushed branch.

**Verifying and shipping a result:** `cloud.fetch` → review/test in the worktree → bring the change
into the checkout the way any coworker's work arrives (cherry-pick the fetched commit or copy the
files) → `git.ship({message, paths})`. The pull request on GitHub is left for the owner.

## How it works (Claude Code 2.1.281/282, verified 2026-09-25)

- **Create.** `claude --cloud "<task>" --model <m> [--effort] [--ref] --name <title> --debug-file <f>`
  in a node-pty PTY (the CLI creates a cloud session only from a terminal). The client creates the
  session, prints `Created cloud session … View: https://claude.ai/code/<id>`, and **exits**. Its
  debug log carries `Creating session with payload` (the `model` and the outcome branch, e.g.
  `claude/add-cloud-coworker-log`) and `Successfully created remote session: <id>`.
- **Live view (gated).** Conductor then tries once to attach: `claude --cloud <session_id>`. On the
  owner's account the CLI refuses: *"Attaching to an existing cloud session is not enabled for your
  account"* (flag `tengu_remote_backend`); the run records `liveView:false` and never retries. The
  same gate covers `claude -p "<msg>" --cloud <id>`, so **steering, interrupting and stopping a
  cloud session are not possible from the CLI on this account.** Where the gate is open, the live
  client streams the session in the tab and messages are typed into it.
- **Result.** Origin is asked (`git ls-remote origin refs/heads/claude/* refs/pull/*/head`) for the
  outcome branch; the cloud appends a suffix (`claude/add-cloud-coworker-log-ogcvln`), so the
  payload's branch is a prefix. Failing that, the one `claude/*` head that appeared since the run
  started. The pull request is the `refs/pull/N/head` whose commit equals the branch head (no `gh`
  needed).
- **Transcript and usage.** `claude --teleport <session_id>` in a scratch worktree of the run
  (`<userData>/cloud/teleport/<runId>`, never the project folder) downloads the session's events and
  saves them as a local conversation under `~/.claude/projects/<folder>/`; it then sits in its own
  prompt. Conductor waits until that file holds the assistant messages, closes the prompt with
  Ctrl+C (nothing is ever typed into it), detaches the worktree and deletes the local `claude/*`
  branch the teleport created. The messages' `model` and `usage` give the tab its model and token
  counts. (The cost in dollars is not reported for cloud sessions.)
- **Folder trust.** If the CLI asks whether to trust the folder (once per folder), the run answers
  yes: it is the owner's registered project.
- **Environment.** The client gets the app's environment without `CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, the messaging socket and similar marks of a Claude Code session that may
  have launched Conductor.

## Spike: routes considered

| Route | Result |
| --- | --- |
| (a) `claude --cloud` in a PTY | **Chosen** for creating. Unattended, uses only the owner's own CLI login. |
| (a') headless variants | `claude -p --cloud "<task>"` is hard-disabled in this build (`cloudPrintEnabled` is false); the stream-json headless cloud client is gated by `tengu_violin_wood` (off). |
| attach / message an existing session | Gated by `tengu_remote_backend` (off on this account). |
| `--teleport` | Works unattended: the transcript route. |
| (b) the sessions HTTP API | Not used: it needs the CLI's OAuth token taken out of its store, which the brief rules out. |
| (c) browser harness on claude.ai/code | Not used. `C:\Claude\chatgpt-agent` drives chatgpt.com in its own visible Chrome profile; driving claude.ai would need a claude.ai login in that profile and a window on the desktop. It is the remaining route to steer or stop a session from Conductor on this account (owner decision). |
| Agent tool `isolation:"remote"`, RemoteTrigger | Excluded by the brief. |

Other findings: folder sync (uploading the local working tree to the session) is gated off, so the
session clones GitHub and uncommitted local work never leaves the machine.

## End-to-end proof (2026-09-25)

`artifacts/cloud-coworker/real-evidence.json` and `real-tab-fetched.png`: a parked Conductor
started session `session_01R3e2LmvwSW9r973sJNkhoW` through `tabs.open({provider:"cloud"})`
(Opus 5.5, base `main`); the session pushed `claude/add-cloud-coworker-log-ogcvln` (`c86d864`) and
opened PR #3; Conductor found both on origin, recorded the refused live view, pulled the 11-entry
transcript (8 assistant messages, 2.8k output tokens), fetched the branch into a worktree and
stopped following. Every other scenario runs against the fixture client:
`node scripts/smoke-lock.mjs -- node scripts/smoke-cloud-coworker.mjs`.
