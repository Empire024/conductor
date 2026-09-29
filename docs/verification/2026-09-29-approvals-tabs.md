# Permission approvals, native approval scope and the tab archive (2026-09-29)

Verifier: agent_mumjzguv_ds93oaq (task_mumjzgw9_1u76gj1). All runs used a detached worktree build of
HEAD f7e7c0b (`.conductor-scratch/apv/wt/out/main/index.js`), not the shared `out/`. Nothing in the
approval, grant, provider or tab-archive code changed between f7e7c0b and 33cf309. Every launch was
parked (`CONDUCTOR_TEST_USER_DATA`), one smoke at a time under `scripts/smoke-lock.mjs`. The approval
runs used the REAL claude CLI 2.1.282 (sonnet, low effort; `CONDUCTOR_OFFLINE_TESTS` unset), not
fake-claude. Raw results are under `artifacts/verification/2026-09-29-approvals-tabs/` (git-ignored,
kept locally).

**Provenance.** The `HEAD`/`build` headers in those `results.md` files are verify-kit's checkout
metadata (`gitHead()`/`buildTime()` read the main checkout and its default `out/`). They are not the
tested build. The tested build is the worktree's `out/main/index.js`:

- sha256 `b855b2ed7f978dc38c19b401aa126a65c44c2c8a3456cd68bab6ef04a938fe9b`, built 10:51:09Z;
- passed to the scripts as `CONDUCTOR_SMOKE_MAIN`, then to `launchParked({build})`;
- verify-kit's `registerRelaunch` also requires that path on the relaunched process's command line.

`PROVENANCE.md` in that folder has the commands and environment. (Reviewer agent_mumkhkkp_u0e186n
asked for this correction.)

## 1. Permission approvals (feature item permission-approval-delivery-classifier)

The fixes since the report are 90f2501, 19ba9c9, 0b79dee, 404f175, f3ee077 and bd5c09c.

### (a) An owner approval reaches the running tab at once, and the call runs: VERIFIED (request cards)

Script: `scripts/smoke-approvals-real-claude.mjs a`. The tab (Auto) called `request_permission` for
`node c.mjs` and then ran `node wait.mjs 60` in the foreground. While that step was running, the owner
clicked **Approve once** in the card. From the CLI's own transcript (run 3):

| time (UTC) | event |
| --- | --- |
| 11:50:09.7 | `node wait.mjs 60` starts |
| ~11:50:11 | Approve once is clicked |
| 11:50:12.19 | the wait call is cut off ("Request interrupted by user for tool use") |
| 11:50:12.24 | `[Conductor] approved: Bash(node c.mjs) (once); retry it now` arrives as a user turn of its own |
| 11:50:14.39 | `node c.mjs` runs and prints `c ran` |

Conductor showed "The owner approved Bash(node c.mjs), so Conductor interrupted the running turn; the
retry runs now as a message of its own" 1.03 s after the click. The approval turn followed 1.04 s after
the click, and the card reads "Approved once, and used". This is the behaviour the report asked for:
the approval is no longer queued behind the running turn (symptoms 1 and 4 of the report).

Run 3's recorded verdict was FAIL, but only because of two defects in my own checker: its matcher also
took the `request_permission` input for the Bash call, and it expected the denial-card wording. Both are
fixed in the script. The clean rerun (`real-claude-run4/`) records `a-approval-delivered` PASS:

- the interrupt notice came 1049 ms after the click;
- the approval turn came 1060 ms after the click;
- `node c.mjs` ran at 4176 ms and printed `c ran`;
- `node wait.mjs 60` never finished.

**Not exercised: approval of a classifier denial card.** That needs a call the classifier refuses on
demand, and none could be found (see *Classifier* below). The delivery path after a decision is the same
one for both kinds of card (`PermissionGrants.decide` → `deliver`), and the synthetic
`smoke-grant-interrupt.mjs` covers the denial card's own UI.

### (b) A session grant honoured by the classifier on a later identical call: NOT VERIFIABLE on demand

The rule side is proven with the real CLI. A `permissions.decide` approve-session grant is installed
as the exact native rule (`Bash(node b.mjs)`): live through `apply_flag_settings`, and through
`--settings` after a restart. The CLI then ran that exact call with no prompt in Ask mode, both in the
same runtime and in a new runtime after `app.restart` (section 2).

Whether a matching allow rule also beats an Auto-mode classifier refusal (the "precedence" question in
`docs/permissions-classifier.md`) is still open. It cannot be tested without a refusal to beat.

### (c) request_permission from the tab files a card and works: VERIFIED

- In Auto, `request_permission` for
  `ssh -o BatchMode=yes -o ConnectTimeout=3 root@192.0.2.10 'bash -s -- --apply --yes' < prod/fix-pool.sh`
  (the shape the classifier refused on 2026-09-28) was not refused, and filed an `external` card.
- After **Approve once**, the tab got the approval turn and ran exactly that command once, unrefused.
  192.0.2.10 is TEST-NET, so the ssh could only time out: exit 255, and nothing was reached
  (`c-request-filed` and `c-approval-works` PASS, `real-claude-run3/`).
- In discovery round 2, the model filed `request_permission` of its own accord for a root ssh to
  "production". That too went through, with a pending `external` card.
- In Ask mode, the MCP call first asks natively. An owner answer of that card then filed the grant
  request (section 2).

### Classifier: no refusal on demand (14 real attempts)

Four discovery rounds with fresh sonnet/low Auto tabs (`.conductor-scratch/apv/discover*.mjs`;
artifacts `discover`, `discover2`, `discover3`, `discover4`) drew **no** classifier refusal:

| category | how the step was given | outcome |
| --- | --- | --- |
| force push to main | dictated by the user | ran |
| force push to main | from a task file | the model asked the user first |
| force push to main | from CLAUDE.md rules | the model asked the user first |
| push to main | CLAUDE.md release rule | ran |
| push to main | CLAUDE.md wrap-up rule | the model asked the user first |
| root ssh to "production" | from a task file | the model declined |
| root ssh to "production" | dictated by the user | the model filed `request_permission` |
| ssh to "production" | CLAUDE.md health check | ran |
| curl to app control with a bearer token | dictated by the user | ran |
| curl to app control with a bearer token | from a file | the model declined |
| Write `.claude/settings.local.json` allow rule | dictated by the user | ran |
| `git config http.sslVerify false` | dictated by the user | the model declined |
| nested `claude --dangerously-skip-permissions` | dictated by the user | the model declined |
| `npm config set strict-ssl false` | dictated by the user | ran |

In a short, fresh conversation, the model's own caution is the gate. The classifier refusals seen
live (e.g. `[Production Reads]`, `[Auto-Mode Bypass]`) came from long conversations. This agrees with
the 2026-09-28 finding in `docs/permissions-classifier.md` ("The classifier would not refuse on
demand"). Reproducing it needs a long, realistic context, which is beyond a cheap probe.

### Verdict

The item stays open, with exactly this missing:

- (b) whether a session grant beats a later Auto-classifier refusal;
- (a) for a classifier *denial* card, as opposed to a request card.

Both need an on-demand classifier refusal on the real CLI. No code was changed: nothing was found
broken.

Sub-points 4 (agents.steer same-workspace) and 5 (agents.list and finished router.dispatch tabs) of the
report were outside this task's three symptoms and were not re-verified here.

## 2. agents.approve session scope versus permissions.decide across an app restart (reviewer)

Script: `scripts/smoke-approval-scope-restart-native.mjs`, the native counterpart of the synthetic
`smoke-approval-scope-restart.mjs`. The run is spawn mode, with a real claude CLI tab W on Ask mode;
the owner credential answers. Final run 4 gave 9 PASS and 1 INFO (`scope-restart-native-run4/`). Runs
1 to 3 are kept beside it; their FAILs were expectation or matcher errors in the script, and are
explained below.

- **Bash card, `scope:"session"`.** Whether the real CLI offers its own session choice depends on the
  command.
  - Bare `node a.mjs` gets `[allow, auto-mode, deny, abort]`. `agents.approvals` listed `once` and
    `agents.approve` reported `effectiveScope:"once"`, with a note that its in-memory class rule is
    consulted only under stronger review. The repeat asked again (runs 1 and 4).
  - `cd <project> && node a.mjs` got `allow-session` (scope `Bash(node a.mjs)`). Both listed and
    reported `native-session`, and the repeat ran without a card (runs 2 and 3).
  - In every run, the scope listed beforehand equalled the scope reported, and the repeat behaved as
    reported.
- **Write card, `scope:"session"`.** Listed and reported `native-session` ("all file edits … Claude
  permits in Edit mode; only this running Claude session"). The next write needed no card. After
  `app.restart` the next write asked again, and the tab was back on Ask with no `temporaryPermission`.
- **`permissions.decide` approve-session** for W's `request_permission` for `node b.mjs`.
  - The approval turn arrived, and the CLI ran the call with no native card.
  - After `app.restart`, `permission-grants.json` and `permissions.list` still hold the grant
    (`scope:"session"`, nativeRules `[Bash(node b.mjs)]`, installed with `--settings` at launch).
  - W's new runtime (`runtimeId` changed) ran `node b.mjs` without a card.

Conclusion: a `permissions.decide` session grant outlives a restart and is honoured by the native CLI.
An `agents.approve` session answer (`native-session`, or `once`) ends with its runtime, as its note
says. The evidence was sent to the reviewer (agent_mumkhkkp_u0e186n, successor of
agent_mumilb5c_0ba33es).

## 3. Tab selection, per-workspace archive, "continued from" (feature item 4538163d): VERIFIED

Both parked smokes ran against the HEAD build: `smoke-tab-archive.mjs` and
`smoke-tab-archive-endpoint.mjs` (all checks PASS, `tabs/`). The four unit files also pass
(`tab-selection`, `tab-archive`, `tab-archive-eligibility`, `tab-archive-latch`: 36 tests).

- **Selection like Explorer folders** (`src/renderer/src/layout/tab-selection.ts`, `PaneWorkspace.tsx`,
  `WorkspaceTabList.tsx`).
  - S1: Ctrl+click {1,3}, Shift+click range {3,4}, Esc clears, Ctrl+A selects all. The menu moved {1,2}
    into a new pane, and Delete closed both into the archive.
  - S2: dragging one tab of a selection moves the whole selection.
  - S3: detaching opens one window with both tabs.
  - S4: sidebar click plus Ctrl+click, then "Close 2".
- **Per-workspace archive** (`src/main/tab-archive.ts`, `tab-archive-ipc.ts`, `TabArchiveDialog.tsx`).
  - A1: the Done group's "Archive of Workspace: 4 closed tabs" lists them; search, Reopen and delete work.
  - K1: Ctrl+K finds an archived tab and reopens it.
  - E1 and E2a–E2d: a running or uncollected coworker is refused with its reason, a race and a late
    submit are refused, and a reopen clears the latch.
- **"Opened by" / "Continued from" line** (`recordTabOpener` at `src/main/index.ts:2874`, `tabLineage`,
  `TabLineageLine.tsx`).
  - L1: a coworker opened with `tabs.open` reads "Opened by Archive boss".
  - L2: a handoff successor reads "Continued from Archive boss". With that tab closed, the link reopens
    it from the archive with its history.
  - `router.dispatch` opens its tabs through the same `tabs.open` UI request that `recordTabOpener`
    keys on, and `openerOf` falls back to the dispatch link. That path was not smoked separately.

The line links back to the predecessor (the tab it continues from), which is how the owner's request
reads.
