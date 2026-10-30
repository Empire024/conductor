# t3code adoption: skill discovery in the composer (Claude Cloud implementation)

Owner-authorized t3code adoption, implemented in a Claude cloud session for the GPT controller to
integrate. Feature doc: `docs/skill-discovery.md`.

## Pins

| What | Value |
| --- | --- |
| t3code source | `pingdotgg/t3code` at `dd148481531a0a090780a2ade20588566db099a2` (read-only, blob-less fetch into a scratch directory; nothing in it was run) |
| t3 files studied | `apps/server/src/provider/Drivers/ClaudeSkills.ts`, `apps/web/src/components/chat/useComposerMenuItems.ts`, plus their helpers `packages/client-runtime/src/providerSkills.ts`, `apps/web/src/providerSkillSearch.ts`, `apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts` |
| Conductor BASE | `3f9534920f6950def7eb315e5d3f5706949ed88c` (`origin/main` when the session started; the owner's local main is ahead of it) |
| Implementation commit | `436f58fea49417c3cf78e79c6c50566f4651c16b` on `claude/t3code-skill-discovery-9m3zlh` |
| Integration patch | `docs/perf-evidence/t3code-cloud-skill-discovery-integration.patch` = `git diff --binary BASE implementation` (17 files, +908/−31, no binaries; sha256 `74d8c1bf9ec5c1a940682cba0bae2b878af91f5a2184043a12465c206ded68ed`). This evidence file and the patch are in a later commit, so they are not part of it. Checked: `git apply --index` on a clean BASE worktree reproduces the implementation tree exactly. Not checked: applying it to the owner's local main (not reachable from the cloud). |

## What was taken from t3, and what was not

Taken:
- Claude roots and precedence: user (`CLAUDE_CONFIG_DIR` or `~/.claude`) `/skills` before project
  `.claude/skills`, first name wins; folder name is the invocable name.
- Frontmatter semantics: `description`, `user-invocable: false` (agent-only, hidden),
  `disable-model-invocation` (owner-only), YAML 1.1 booleans; `skillOverrides` from the user,
  project and project-local settings files, a file with an invalid value contributing nothing.
- Menu: explicit `/skill:name` entries with a concise description and source, deduplicated against
  reported provider commands of the same name; skills filtered out when disabled or agent-only.

Not taken (deliberately, to stay bounded):
- Plugin skill roots (`installed_plugins.json`, manifests, worktree common-dir resolution) and the
  managed-settings path. Claude reports plugin skills in its own command list; `/skill:plugin:x`
  accepts a name the CLI reported.
- `--add-dir` launch-arg roots (Conductor does not launch Claude with them).
- t3's `$skill` inline mention grammar and multi-skill dispatch rewriting
  (`ClaudeSkillDispatch.ts`): Conductor sends exactly what the draft says.
- A YAML library: the parser reads the scalar/block subset SKILL.md files use; anything else is
  malformed and skipped.
- Fuzzy ranking: Conductor keeps its prefix matching (plus the bare skill name), which is
  deterministic and already bounded at 60 entries.

Added beyond t3: bounded I/O (entry/skill/file/settings caps, sorted before the cut), symlink
containment for entries and the project root, description sanitizing (control/bidi characters,
one line, 160 chars), collision refusal against Conductor's command catalog, and explicit
loading / error / unsupported / empty states in the list.

## Paths

New:
- `src/shared/skill-catalog.ts` — catalog types, `SKILL_LIMITS`, name rule, source labels, syntax per provider.
- `src/main/skill-discovery.ts` (+ `.test.ts`) — Claude scan and frontmatter parser.
- `src/renderer/src/panes/composer-skills.ts` (+ `.test.ts`) — discovery → menu entries, status text.
- `src/shared/slash-skill-commands.test.ts` — resolution tests.
- `docs/skill-discovery.md`.

Surgical hooks:
- `src/main/providers/claude.ts` — import + `discover()` adds `skillCatalog` (isolated reviewer/evaluation runtimes report unavailable).
- `src/shared/slash-commands.ts` — `SlashHandling` gains `{ kind: 'skill' }`; `resolveSlashCommand` gains an optional 4th `skills` argument and a `skill:` branch; `skillCommandCollision`; listed skills count as reported Claude names.
- `src/renderer/src/panes/composer-commands.ts` — `ComposerCommand.kind/source`, skill entries replace the old raw Codex `$name` entries, dedupe, bare-name matching, `composerCommandChoice` (pure selection logic).
- `src/renderer/src/panes/StructuredAgentPane.tsx` — 6 small hunks: skill state, resolve call, `skill` handling in submit, discovery error kept (and retry), `/skill:` status-only list, `chooseCommand` via `composerCommandChoice`.
- `src/renderer/src/panes/CommandAutocomplete.tsx`, `StructuredAgentPane.css` — source badge, status line, wider label for skill rows.
- `src/renderer/src/panes/composer-starters.ts` — skill label is its draft text.
- `src/renderer/src/panes/composer-commands.test.ts` — the Codex skill test now expects `skill:research`.
- `scripts/smoke-slash-commands.mjs` — one Claude `/skill:` check; `docs/slash-commands.md` — pointer.

Not touched: audio, other projects, `feature-list.md`, timing / cloud-runs / thread-view modules,
release workflow, package version.

## Behavior

- `/skill:` lists the conversation's skills: `/skill:review-pr  Review the open pull request · Project skill`.
- Enter, Tab or click drafts `/review-pr ` (Claude) or `$research ` (Codex); nothing is sent.
- Sending `/skill:review-pr args` sends `/review-pr args` natively (Claude) or `$review-pr args` as a message (Codex).
- `/skill:model` (or any Chat command/alias) answers inline: it would run the command, not the skill.
- `/skill:unknown` after discovery answers inline; before discovery Claude decides, as before.
- Grok and local models: `/skill:x` answers that the runtime has no skills; no entries are listed.
- `/skills`, `/mcp`, `//` escapes, aliases, Conductor-over-native precedence: unchanged (tested).

## Tests run (this session, Linux container)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| New/affected focused files: `skill-discovery`, `slash-skill-commands`, `composer-skills`, `composer-commands`, `composer-starters`, `slash-commands`, `slash-command-actions` | 7 files, 49 tests passed (plus 7/7 composer-skills after a typing fix) |
| `vitest related --run` over every touched source file (41 files, 700 tests, ~90 s) | 698 passed, 2 failed in `src/main/agent-control.test.ts` — **both pre-existing on BASE**: "auto-approve policy answers a card it covers itself" fails deterministically on BASE; "without a wizard opens the tab in the workspace of that project's root controller" failed 3 of 4 runs on BASE (session-id ordering flake). Neither touches this change. |
| `node scripts/smoke-slash-commands.mjs` under `xvfb-run`, after `electron-vite build`, `CONDUCTOR_TEST_USER_DATA` parked window, synthetic runtimes | exit 0, 11 checks including the new skill check (screenshot `artifacts/slash-commands/9-claude-skill-menu.png`, not committed: `artifacts/` is ignored) |
| Same smoke under `scripts/smoke-lock.mjs` | checks all passed but exit 3: smoke-lock's process accounting is Windows-only (`Win32_Process`), so cleanup is unaccounted on Linux. Per AGENTS.md that is **not a pass**; the controller should rerun it under smoke-lock on the host. |
| Full `npm test` (full Vitest + `test:scripts`) | **not run** (deliberately, per the brief) |
| `git.ship` / `app.update` acceptance | not available in the cloud; for the controller |

Environment notes: dependencies were installed with `npm ci --ignore-scripts`; Electron's binary
(`node_modules/electron/install.js`) and `node-pty` (`npm rebuild node-pty`) were then installed
explicitly so the Electron- and pty-dependent suites could load. No model inference, local model,
other provider or nested agent process was used; the smoke uses Conductor's synthetic fixtures.

## Effort

Estimated, not measured: one focused session (roughly an hour reading t3 and Conductor's
slash/discovery path, two for implementation and tests, half an hour for smoke and evidence). Integration on the owner's main should be
small: the hooks are in six existing files, the rest is new modules; the largest conflict risk is
`StructuredAgentPane.tsx` (very long lines around the composer), then `composer-commands.ts`.

## Limits and follow-ups

- Plugin skills get no description or source in the `/skill:` list unless the CLI reports them; a
  plugin-root scan (t3's `discoverPluginSkillRoots`) is the natural follow-up.
- Claude skills are read when the `/` list first opens in a conversation; a skill added later is
  listed after the conversation is reopened (typing `/name` still works: the CLI decides).
- The collision check uses Conductor's command catalog; a new Claude built-in not in
  `SLASH_COMMANDS` could still shadow a same-named skill.
- `~/.claude/skills` is read from the real home of the process; Windows paths are handled by
  `node:path`, but the scan was only exercised on Linux here.
