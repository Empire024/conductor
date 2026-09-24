# Local assist: the local model reads so the frontier model does not

Frontier coworkers (Claude Code, Codex) spend most of their tokens reading: test runs, build
output, logs, big files. Local assist hands that reading to the local model on this machine in
the same turn and returns a few dozen lines. Code: `src/main/local-assist/`.

## Tools (`conductor-local` MCP server)

Every Claude and Codex conversation gets these, whether or not browser tools are on. They are
served from a loopback endpoint the way the browser tools are (`mcp-server.ts`): a per-session
bearer token in a 0600 config file (never on a command line), refused to any browser `Origin`
or foreign `Host`, and released when the conversation closes. Local-model conversations and
approval reviewers do not get them.

| Tool | What it does | Who may call it |
| --- | --- | --- |
| `run_and_summarize({command, cwd?, question?, maxLines?=30, timeoutSec?=600})` | Runs the command **on the host** in the conversation's directory, streams the full output to `.conductor-scratch/local-assist/<time>.log`, and returns exit code, duration, the log path, a local-model summary of at most `maxLines` focused on failures (test names, file:line, first error), and the **last 15 raw lines verbatim**. | Only a conversation in **Auto**, not planning. Auto can already run shell commands; anything else is refused so the tool never widens a permission. |
| `local_ask({prompt, files?, maxLines?})` | Reads up to 12 project files on the host (each capped at 512 KB, line-numbered), and the local model answers: summarise, extract, classify, find where X happens. | Any permission (read-only). Paths must resolve inside the conversation's directory; credential files (`isSecretPath`) are refused. |
| `summarize_file({path, question?})` | `local_ask` over one file. | Same. |

The briefing tells each Claude/Codex runtime once (with the machine line, `turn-briefing.ts`
`LOCAL_ASSIST_HINT`): *for tests, builds and long logs call run_and_summarize; for reading
large files call local_ask*. AGENTS.md "Machine limits" says the same.

## Which model, and never blocking the caller

`model-runner.ts`:

- Uses the llama.cpp server that is already running (one server at a time,
  `docs/machine-profile.md`), whatever model it holds.
- If none is running, starts the fastest configured model that fits the GPU (Qwen 3.5 9B, then
  Ornith 9B, then Dolphin X1 8B) through the admission-locked `startServer`, unless an
  interactive local conversation is mid-turn. A start keeps going in the background if the
  caller's budget runs out, so the next call is fast; a failed start is remembered for 5 min.
- One assist generation at a time. An interactive local turn and a busy slot go first.
- Total wait for server + queue + slot is about **20 s**, then the tool returns the raw tail
  plus failure-looking lines (pattern match) and says why the model was not used.
  A generation still running after 90 s is abandoned the same way.
- `reasoning_effort: none`, temperature 0.2, answer capped to `maxLines`.

The model reads an excerpt, not the whole log: head, every failure region with context, and
the last 120 lines, within about 60k characters (`digest.ts`).

## Measurement

Every call appends one line to `<userData>/local-assist/savings.jsonl` (`savings.ts`): tool,
project, conversation, provider, raw characters, returned characters, local input and output
tokens, whether the model answered. Saved ≈ `raw/4 − returned/4` frontier tokens per call
(0 when the model was not used for `local_ask`). The usage view shows
**"Local models saved ≈ N tokens this week"** (`WeeklyUsage.tsx`, from `usage:weekly`'s
`localSavings`). The file is pruned to 30 days past 2 MB.

## Linux dependencies for the local sandbox

The local-model sandbox is a network-less Linux container; the Windows `node_modules` holds
Windows native binaries (Rollup, esbuild), so `tsc`/`vitest` could not run inside it.

- `prepareLinuxDependencies` (`src/main/local-models/sandbox.ts`) builds a Linux `node_modules`
  in a Docker volume `conductor-linux-deps-<lockfile hash>` with a one-time container **with**
  network (only `package.json` and `package-lock.json` are bound in). This downloads packages,
  so it is only ever an explicit owner action: `npm run local -- prepare-deps --cwd <project>`.
  It is never started silently.
- Once prepared (marker under the local runtime dir plus the volume), the normal sandbox mounts
  the volume read-only over `/workspace/node_modules`; a new lockfile means a new key.
- Until then, a local task's acceptance command (set by the task contract, never by the model)
  runs on the host in an isolated temp copy of the working tree, with `node_modules` junctioned
  in (`DockerSandbox.runAcceptance`).

## Not yet wired (see the W17 report)

- `usage.limits` / `local.savings` in app control, and a `local.sandbox.prepare` control method
  that asks the owner, need lines in `src/main/agent-control.ts`.
- `DockerSandbox.runAcceptance` needs the acceptance call in `src/main/local-models/agent.ts`.
