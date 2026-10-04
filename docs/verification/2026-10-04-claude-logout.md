# 2026-10-04 Claude logout: evidence, root cause, fix

Owner report: the Claude login was lost again around 2026-10-03/04 and work stopped until the
owner was back at the desktop and logged in. This note records what the machine's own records
show. No token or code value was read into this document; the credentials file was inspected only
for its shape, times and expiry fields (`.conductor-scratch/claude-login/creds-shape.mjs`).

## What happened (timeline, UTC)

Sources: Claude CLI transcripts under `~/.claude/projects/**.jsonl` (synthetic assistant messages
with `error: "authentication_failed"` and real model answers), Conductor's journal
(`structured_sessions` projections plus `structured_events` read per conversation through the
`structured_events_accounting` index, window 2026-10-02T12:00Z to 2026-10-04T18:00Z), the CLI's
own `~/.claude/history.jsonl` (`/login` entries), the credentials file's mtime and expiry fields,
and the meta-wizard journal (`%APPDATA%/Conductor/meta-wizard/journal.jsonl`) for app restarts.

| Time (UTC) | Evidence |
| --- | --- |
| 10-04 00:13 to 07:48 | Real Claude answers every ~20 min (one wizard), plus a burst 05:40 to 06:03 (up to 5 conversations). Last real answer 07:48:19Z. |
| 07:48 to 16:32 | No Claude CLI answered anything: 8.7 h without a turn. |
| 16:32:08 | First and only failed turn: Haftheme controller (`agent_mutir0bi_oco17ka`, CLI session `1e2e825d`): `Failed to authenticate: OAuth session expired and could not be refreshed`. Conductor recorded it as `provider_auth_expired` (03256da works). |
| 16:32 to 17:42 | No other Claude turn ran, so no other tab failed; the controller and its coworkers were idle and stayed idle. |
| 17:42:52 | Owner typed `/login` in an interactive CLI in `C:\claude` (`history.jsonl`). |
| 17:43:20 | `~/.claude/.credentials.json` rewritten (new pair, `expiresAt` = +8 h). |
| 17:44:13 | Conductor's monitor saw the rewritten stamp and resumed the tab ("Login restored; Conductor asked this conversation to continue."); first real answer 17:44:16Z. |

`providerAuth.outage.claude` is empty now (the outage closed on resume).

The previous outage looks the same: 10-01 08:38:49Z a timer wizard (`76c2caf5`, a turn every
30 min since 01:00Z) failed with the same text at the first turn after its access token expired;
two other conversations failed at 09:22Z and 11:44Z; the owner logged in at 10-02 03:09:39Z.
Before that the owner's last `/login` was 2026-08-04: the same OAuth session had lasted 58 days.

## Did the 03256da alert and resume work?

- **Resume: yes.** The credentials file was rewritten at 17:43:20Z and the stopped tab was resumed
  at 17:44:13Z, 53 s later. That is within one 3-min probe interval.
- **Alert: it ran, but nothing durable proves it reached the owner.** `noteFailure` raises the alert
  unconditionally on an outage's first failure, and the outage existed (the resume needed it). But
  the alert result went only to the main process's console, which the installed app does not keep,
  and `phoneAccess.announce` neither writes to the attention log nor records the push result. Both
  paired phones with push subscriptions show `pushFailures: 0` (a failed push increments it), which
  is consistent with a delivered push but is not proof. **Fixed:** the outage now records what the
  alert reported (`alertResult`: desktop toast, phone push result and open phone streams) in the
  persisted `providerAuth.outage.<provider>` setting, and a closed outage is kept with its
  `restoredAt` in `providerAuth.lastOutage.<provider>`, so the next outage leaves evidence; tapping
  the phone alert now opens the new Log in screen.

## Why the OAuth session dies

Facts from the installed CLI (2.1.287, read from its bundled source, not from docs):

- An access token lives 8 h (`expiresAt` = write time + 8 h, here 17:43:20Z to 01:43:20Z).
- The CLI treats a token as expired 5 min early (`n + 300000 >= expiresAt`) and then refreshes it
  with `grant_type: refresh_token`, storing the `refresh_token` the server returns (rotation).
- Processes that share one config directory coordinate the refresh through a lock (the CLI even has
  the message "another Claude Code process is refreshing it or exited mid-refresh"). So several
  Conductor tabs and the `claude auth status` probe, all on `~/.claude`, do not race each other.
  The controller's first suspect (concurrent tabs) is covered by the CLI itself.
- `claude auth status` does not rewrite the credentials file (mtime unchanged across probes run
  during this investigation). No Conductor code writes or deletes `~/.claude/.credentials.json`;
  `provider-auth.ts` only reads its mtime.

What Conductor does that breaks this: **the model-upgrade watch** (`src/main/model-upgrades`,
shipped f4b7987 on 2026-09-30, installed the same day) probes each CLI's model catalog 2 min after
every app start and every 6 h after that, and for the probe it **copied the owner's
`.credentials.json`, refresh token included, into a throwaway `CLAUDE_CONFIG_DIR`** and started a
full Claude CLI there (stream-json `initialize`). The same applied to a scratch copy of a newer CLI
version and to Codex's `auth.json`. A CLI in that scratch home:

1. cannot see the lock in `~/.claude`, and
2. when its copied access token is within 5 min of expiry (always the case when the owner's tabs
   were idle across the token's expiry, as on 10-04 07:48 to 16:32), refreshes it, spending the
   refresh token the owner's file still holds. The new pair is deleted with the scratch home.

The owner's next refresh then presents a spent refresh token and fails with exactly "OAuth session
expired and could not be refreshed". If the copy refreshes in the same minutes as a real refresh
(both race on an app restart, when every tab restarts its CLI), presenting an already-rotated
token can also revoke the family, and the failure surfaces at the next expiry, up to 8 h later.
That matches 10-01: the app restarted at about 00:21Z and 00:54Z, each restart followed 2 min later
by a probe, and the wizard failed at 08:38Z, at the first turn after an 8 h token minted in that
window expired.

How sure this is: the mechanism is in the code (Conductor's copy, the CLI's 5-min refresh margin
and rotation handling, its per-directory lock). The correlation is strong: one OAuth session lasted
58 days until the watch shipped, then three logins were needed in five days. What is **not**
proven: the exact probe times (the watch keeps only `lastCheckAt`, 17:02:17Z, and deletes its
scratch homes) and the server's reuse policy. Proving it would mean refreshing a copy of the
owner's live credentials on purpose, which logs the owner out, so that experiment was not run.

## Fix

- `probeCatalog` (src/main/model-upgrades/cli-source.ts) never gives a scratch home a refresh token:
  `scratchSignIn` keeps the access token and drops `refreshToken` (Claude) or blanks
  `refresh_token` and sets a fresh `last_refresh` (Codex). If the access token is within 15 min of
  expiry the probe skips this round rather than refresh a copy. With a long-lived token set, nothing
  is copied and the token goes in through the environment.
- A long-lived token (`claude setup-token`, 1 year, `CLAUDE_CODE_OAUTH_TOKEN`) removes refreshes
  altogether: Settings > Providers > Claude login > Set up long-lived token. Stored with Electron
  safeStorage in userData and injected into every Claude CLI process Conductor starts.
- Logging in from the phone: the login alert and the Attention screen carry a Log in action that
  runs `claude auth login` (or `setup-token`) in a PTY Conductor owns, shows the sign-in URL on the
  phone, takes the pasted code and resumes the stopped tabs once `claude auth status` confirms it.

No extra serialization of Conductor's own Claude processes was added: the evidence shows that
processes sharing `~/.claude` are already serialized by the CLI. Only the copy escaped that, and
the copy can no longer refresh.

## Verified behaviour of the login flows (PTY probes, empty scratch config, no code ever submitted)

- `claude setup-token` / `claude auth login` with `BROWSER` pointing at a missing executable do
  not open a browser. They print "Browser didn't open? Use the url below to sign in" (setup-token)
  or "If the browser didn't open, visit:" (login), then an OSC 8 link plus the plain URL
  `https://claude.com/cai/oauth/authorize?...&redirect_uri=https://platform.claude.com/oauth/code/callback...`,
  then `Paste code here if prompted >`. The redirect is the manual-code page, so signing in on a
  phone works.
- A wrong code: `auth login` prints `Login failed: Request failed with status code 400` and exits
  1; `setup-token` prints `OAuth error: Request failed with status code 400` and stays open.
- With `CLAUDE_CODE_OAUTH_TOKEN` set, `claude auth status` reports `authMethod: "oauth_token"`
  and `loggedIn: true` without validating the token (a fake one also reports logged in), so
  rejection is detected from a failed turn, not from the probe.
- `codex login --device-auth` prints `https://auth.openai.com/codex/device` and a one-time code
  that expires in 15 min; nothing is pasted back. Conductor supports it in the same phone flow.
