# Skills in the composer (`/skill:name`)

Typing `/skill:` in a Chat conversation lists the skills that conversation's runtime can run, each
with its description and where it came from (Project skill, User skill, Plugin skill…). Typing part
of a name works too: `/rev` finds `/skill:review-pr`. Choosing one (Enter, Tab or a click) **only
writes the runtime's own syntax into the draft** — Claude `/review-pr `, Codex `$research ` — so the
owner can add arguments; nothing is sent until the message is sent. Typing `/skill:review-pr args`
and sending it directly works as well and sends the same native text.

Adapted from t3code (`apps/server/src/provider/Drivers/ClaudeSkills.ts`,
`apps/web/src/components/chat/useComposerMenuItems.ts`, pinned at
`dd148481531a0a090780a2ade20588566db099a2`); see
`docs/perf-evidence/t3code-cloud-skill-discovery.md` for what was taken and what was left out.

## Where the list comes from

It rides the existing provider discovery call (`structured:discover`, loaded when the `/` list
first opens), not a separate harness:

| Runtime | Source | Invoked as |
| --- | --- | --- |
| Claude Code | `ClaudeAdapter.discover()` adds `skillCatalog`, a bounded scan of skill folders in the main process (`src/main/skill-discovery.ts`) | `/name args` (native, the CLI expands the skill) |
| Codex | the App Server's `skills/list`, already part of `CodexAdapter.discover()` | `$name args` in an ordinary message |
| Grok, local models | none | `/skill:x` answers inline that the runtime has no skills |

Claude roots, in Claude Code's own precedence (the first root with a name keeps it; the other is
recorded under `shadowed`):

1. **User**: `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/<name>/SKILL.md`
2. **Project**: `<project>/.claude/skills/<name>/SKILL.md`

The skill's name is its folder name (what Claude invokes); the frontmatter supplies `description`,
`user-invocable: false` (agent-only: not listed, not invocable from Chat) and
`disable-model-invocation` (listed; owner-only). `skillOverrides` in `~/.claude/settings.json`,
`.claude/settings.json` and `.claude/settings.local.json` switch a skill off the same way Claude does.
Plugin skills (`plugin:skill`) are not scanned; the CLI reports them in its own command list, and
`/skill:plugin:skill` accepts a name the CLI reported.

## Safety and bounds

- Discovery reads names and frontmatter only. No script, prompt or file in a skill folder is run,
  imported or sent to a model; descriptions are untrusted display text (control and bidi characters
  removed, one line, at most 160 characters).
- Bounded I/O (`SKILL_LIMITS`, `src/shared/skill-catalog.ts`): 400 directory entries per root, 200
  skills, SKILL.md up to 64 KiB (a larger one is skipped unread), settings files up to 256 KiB.
  Names are sorted before reading, so a truncated list is the same on every run.
- A skill folder or SKILL.md that is a symlink resolving outside its root is ignored, and a project
  `.claude/skills` that resolves outside the project is not read (`roots[].state: outside-project`).
  A user root may itself be a symlink (dotfiles), but entries must stay inside where it resolves.
- Malformed frontmatter (an unclosed `---`, a top-level line that is not `key: value`), binary
  content, and names that are not a single token are skipped and counted in `skipped`.
- Reviewer and evaluation runtimes, which Claude starts without skills, report
  `status: unavailable`. A failed scan never fails the discovery call.

## Precedence and collisions

Unchanged: Conductor and protocol mappings first, then commands the CLI reported, then the catalog's
unsupported reasons (`docs/slash-commands.md`). For skills:

- A Claude skill whose name is a Chat command or alias (`model`, `clear`, `compact`, `skills`…) is
  not listed, and `/skill:model` answers inline: sending `/model` would run the command, not the
  skill. Rename the skill folder to use it from Chat. Codex `$name` never collides.
- A reported Claude command that is also a listed skill is shown once, as `/skill:name`.
- A listed skill typed bare (`/review-pr`) runs natively even if it was created after the CLI
  reported its list. Once discovery has answered, `/skill:` with a name nobody listed is refused
  inline; before it answers, Claude is the judge, as for any other Claude command.
- `/skills` still opens Skills & connections, and `//skill:x` still sends a literal message.

## Loading and errors

While the list loads, the header says so. With `/skill:` typed and nothing to show, the list stays
open with one status line: loading, the discovery error (for example a disconnected conversation;
opening the list again retries), "This runtime has no skills Conductor can list", "No skills found…"
or "No skill matches…". A note also says when skills were left out (agent-only, switched off,
named like a command) or the list was truncated.

## Verification

- `src/main/skill-discovery.test.ts` — roots, precedence, CLAUDE_CONFIG_DIR, malformed/oversized/
  binary skips, symlink escapes, overrides, bounds, description cleaning, frontmatter subset.
- `src/shared/slash-skill-commands.test.ts` — `/skill:` resolution per provider, collisions,
  unknown after discovery, `//` escape, `/skills` unchanged.
- `src/renderer/src/panes/composer-skills.test.ts` — menu entries, Codex mapping, disabled
  providers, loading/error text, filtering, bounded order, selection drafts and never sends.
- `scripts/smoke-slash-commands.mjs` (parked window, synthetic runtimes) — a project skill is listed
  with its description and source, an agent-only one is not, and choosing it only drafts
  `/smoke-skill`.
