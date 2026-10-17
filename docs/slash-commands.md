# Slash commands in Chat

A Chat conversation talks to Claude Code over stream-json and to Codex over the App Server, not
through their terminal UIs. Neither protocol runs the terminal UI's built-in commands for us: a typed
`/permissions` used to reach Codex as plain prompt text (the model answered it, nothing changed),
and Claude Code answers it with "/permissions isn't available in this environment". An unknown
`/name` even costs Claude a model turn.

So the composer resolves every leading `/command` itself before anything is sent
(`src/shared/slash-commands.ts`, `resolveSlashCommand`). Each command does exactly one of these:

| Handling | What happens |
| --- | --- |
| **Conductor** | The Conductor control that does the same job runs: the mode picker, model picker, settings, history, change history, a new tab… The draft is cleared. |
| **Protocol** | Conductor calls the runtime's own request (`structured:command` → `StructuredSessions.slashCommand` → `adapter.slashCommand`). Codex `/compact` is `thread/compact/start` and `/review` is `review/start`; both start a native turn that reports itself like any other. |
| **Native** | The runtime runs the text as typed. Claude Code runs its headless commands (`/compact`, `/context`, `/init`, `/usage`, `/goal`, skills, custom commands) and answers with a synthetic assistant message. |
| **Prompt** | The CLI's command is a canned request; Conductor sends the same request as a message (Codex `/init`, Codex `/recap`). |
| **Unsupported** | An inline notice above the composer says why, and the draft stays. Nothing reaches the model. |

Anything that is neither in the catalog nor reported by the runtime is **unknown**: the notice says
so and points at `/help`. To send a message that really starts with a slash, type `//`:
`//permissions is a word` sends `/permissions is a word`. A path such as `/src/app.ts is broken` is
not a command (a name must be followed by a space or the end).

Precedence, for Claude: a Conductor or protocol mapping wins (the composer owns the model, effort,
mode, title and session, so Claude's `/model`, `/effort`, `/rename` and `/clear` are Conductor's);
then a command the CLI reported in its `initialize` commands or init `slash_commands` runs natively;
then the catalog's unsupported reason. Until discovery has answered (the list loads when `/` is
typed), an unrecognised Claude name is left to the CLI.

The `/` list (`composerCommands`) shows only commands that do something for the conversation's
provider, each once under its own name (`/approvals`, `/clear` and `/cost` find `/permissions`,
`/new` and `/usage`), followed by what the runtime reported: Claude commands and skills, Codex
`$skills`. Enter or a click runs the chosen command exactly as if it had been typed and sent; Tab
puts a command that takes arguments (or one the runtime reported) into the draft so they can
follow. A `$skill` always goes into the draft, because it prefixes a prompt.

## Commands

Arguments in brackets are optional.

| Command | Claude Code | Codex |
| --- | --- | --- |
| `/permissions` `/approvals` `[ask\|auto\|edit\|read-only\|plan]` | Opens the mode picker, or sets the named mode | Same (the reported bug) |
| `/model [name]` | Model picker, or the model whose id or label matches | Same |
| `/effort [level]` | Effort slider, or sets the level | Same |
| `/plan [prompt]` | Plan mode on; with a prompt, sends it in plan mode | Plan mode when the runtime offers it |
| `/edit` | Leaves plan mode (Claude: Edit mode) | Leaves plan mode |
| `/compact [instructions]` | Native | `thread/compact/start` (no instructions) |
| `/review [base <branch>\|commit <sha>\|instructions]` | Unsupported: use `/code-review` or `/security-review` | `review/start`, inline: uncommitted changes, a base branch, a commit, or custom instructions |
| `/init` | Native (CLAUDE.md) | The AGENTS.md generation prompt |
| `/status`, `/pwd` | Inline: runtime, model, effort, mode, context, workspace, session, sign-in | Same; Codex `/context` and `/usage` show it too |
| `/context`, `/usage` (`/cost`) | Native (`/cost` runs `/usage`) | Inline status |
| `/diff` `/rewind` `/undo` | Local change history, with revert | Same |
| `/new` `/clear` | A new conversation of the same provider, in a new tab | Same |
| `/fork` | Unsupported (Claude conversations do not fork) | Copy of the conversation |
| `/rename [name]` | Rename dialog, or renames | Same |
| `/resume` | Reconnects a disconnected conversation, otherwise saved conversations | Same |
| `/history`, `/stop`, `/attach` (`/mention`), `/settings` (`/config`, `/debug-config`), `/copy`, `/export`, `/archive`, `/diagnostics` (`/events`), `/help` | Conductor controls | Same |
| `/mcp`, `/skills` (`/apps`, `/plugins`, `/hooks`, `/agents`) | Skills & connections dialog; `/mcp reconnect …` runs natively | Skills & connections dialog |
| `/goal` | Native | Unsupported: a native goal starts turns outside Conductor's supervision |
| `/recap` | Native | A recap prompt |
| `/login` `/logout`, `/quit` `/exit`, `/side` `/btw`, `/memory`, `/add-dir` `/cd` `/worktree`, `/experimental` `/setup-default-sandbox`, `/feedback` `/bug`, `/ps` `/tasks`, terminal settings (`/vim`, `/theme`, `/statusline`, `/keymap`, `/ide`, …) and CLI-only commands (`/rollout`, `/app`, `/voice`, `/release-notes`, …) | Inline reason | Inline reason |

Claude's own headless list for 2.1.301 was read from the CLI's `initialize` response (68 commands
with the owner's plugins); Codex 0.159.1's built-ins from the TUI's command table. When a CLI adds a
built-in, add it to `SLASH_COMMANDS` with one of the handlings above; `src/shared/slash-commands.test.ts`
checks that every listed Codex built-in resolves and that no Claude terminal-only command is passed
through.

## Verification

- `src/shared/slash-commands.test.ts`, `src/renderer/src/panes/composer-commands.test.ts`,
  `src/renderer/src/panes/slash-command-actions.test.ts`, and the App Server cases in
  `src/main/providers/codex.test.ts` (`thread/compact/start`, `review/start` targets, a refused
  review leaves the thread connected, nothing starts while a turn runs).
- `node scripts/smoke-slash-commands.mjs` after a build (parked window, synthetic runtimes; run it
  under `scripts/smoke-lock.mjs`): the Codex and Claude menus, `/permissions` opening and setting
  the mode with nothing sent, `/compact` and `/review` as native Codex turns, inline answers for
  `/vim` and an unknown name, `/status`, `//` literals, Codex `/init`, and Claude passthrough.
