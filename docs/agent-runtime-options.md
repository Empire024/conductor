# Alternative agent runtimes for Conductor

Researched 2026-09-21. Nothing was installed or run; every command below is a proposal.

**A runtime is not a stronger model.** Whatever OpenCode, Goose or Crush can do, they do with the
same weights Conductor can already reach. A new runtime is worth adding only if it brings
orchestration, permissions, cancellation or structured events that Conductor's three existing
adapters cannot express — or if it unlocks a *commercial* route that they cannot. One of them
does the second thing, and that turns out to be the whole case.

## The finding that reframes the question

Six runtimes were screened. Five of them speak the **Agent Client Protocol (ACP)** — a JSON-RPC
2.0 protocol over stdio, at v0.11.0 as of 2026-03-04 — and so do **Codex CLI, Gemini CLI, Kimi
CLI, Qwen Code, OpenClaw, Hermes Agent, Factory Droid, Mistral Vibe, JetBrains Junie, Cursor and
GitHub Copilot (public preview)**.

That changes the shape of the answer. The question is not "which runtime should Conductor
integrate", it is "should Conductor speak ACP". One adapter, and every one of those becomes a
tab. That is the recommendation below, with the caveat that it is a recommendation to *plan*,
not to build this week.

## Screening

Repository health read from the GitHub API on 2026-09-21.

| Runtime | Repo | Stars | Last push | Licence | Verdict |
| --- | --- | --- | --- | --- | --- |
| **OpenCode** | `anomalyco/opencode` | 209,102 | 2026-09-21 17:31 UTC | MIT | **Deep dive.** ACP *and* a headless HTTP server with an SSE event stream. |
| **Goose** | `aaif-goose/goose` | 54,536 | 2026-09-21 18:05 UTC | Apache-2.0 | **Deep dive.** Rust, ACP as its primary client interface, lowest resident footprint. |
| OpenHands | `OpenHands/OpenHands` | 88,727 | 2026-09-21 18:51 UTC | MIT | Screened out. Healthy and ACP-capable, but its execution model is a container per session — on a machine that already budgets Docker for the local sandbox and 12 GB of VRAM for llama.cpp, that is the wrong shape. Revisit if Conductor ever wants isolated long-running tasks. |
| Cline | `cline/cline` | 68,958 | 2026-09-21 18:44 UTC | Apache-2.0 | Screened out. It is a VS Code extension first; driving it headless from Electron means adopting its host-bridge, which is more integration than ACP for less. |
| Crush | `charmbracelet/crush` | 28,227 | 2026-09-21 16:12 UTC | NOASSERTION (non-OSI, per GitHub's own classification) | Screened out on licence ambiguity for a shipped desktop app, and because it is a TUI whose value is the terminal experience Conductor replaces. Worth noting it *is* on Z.ai's supported-tools list. |
| Aider | `Aider-AI/aider` | 49,101 | **2026-05-22** | Apache-2.0 | Screened out on maintenance: four months without a push, 1,882 open issues, and no ACP. It is also a diff-centric pair-programmer, not an orchestratable agent. |

---

## 1. OpenCode

**Two integration surfaces, which is unusual.**

*ACP.* `opencode acp` "starts OpenCode as an ACP-compatible subprocess that communicates with
your editor over JSON-RPC via stdio" — the same transport shape Conductor's `JsonLineTransport`
already implements for Claude Code and Codex. OpenCode claims full feature parity over ACP:
built-in file and terminal tools, custom tools and slash commands, MCP servers from its own
configuration, `AGENTS.md` project rules, formatters and linters, and its agents and permissions
system. Documented gap: `/undo` and `/redo` are unsupported over ACP.

*Headless HTTP.* `opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]`,
default port 4096 bound to 127.0.0.1, optional HTTP basic auth via `OPENCODE_SERVER_PASSWORD`,
and an OpenAPI 3.1 document at `/doc`. The endpoints Conductor would use:

| Need | Endpoint |
| --- | --- |
| Create / list / delete a conversation | `POST /session`, `GET /session`, `DELETE /session/:id` |
| Stream events | `GET /event` (SSE, opens with `server.connected`); `GET /global/event` |
| **Cancellation** | `POST /session/:id/abort` → boolean |
| **Permissions** | `POST /session/:id/permissions/:permissionID` with `{ response, remember? }` |
| Fork / subsessions | fork at a message; `/session/:id/children` |

**Orchestration.** Parent/child sessions are first-class, which is closer to Conductor's own
router-and-coworkers model than anything the Claude or Codex adapters expose. `fork` is a
capability Conductor's `ProviderCapabilities` declares and both existing adapters report as
`false`.

**Cancellation.** A single idempotent `abort` per session that returns whether it worked. This is
better than what Conductor lives with today: the Claude adapter needs "the exact native
cancellation receipt" before it will authorise replay after Escape
(`src/main/providers/claude.ts:328`), and the local adapter aborts an `AbortController` and hopes.

**Permissions.** A request/response pair with a `remember` flag, i.e. exactly the shape of
Conductor's `{ type: 'interaction' }` event and `respond(InteractionResponse)`. The local adapter
cannot do approvals at all — it throws "Local models do not raise approvals or questions"
(`src/main/providers/local.ts:222`) and advertises only `accept-edits` and `read-only`. A runtime
that *can* ask would let a local model do supervised work it currently cannot be trusted with.

**Model reach.** OpenCode is provider-agnostic and takes any OpenAI-compatible endpoint. The same
config points it at MAIN's llama.cpp server or at a rented endpoint:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "conductor-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Conductor local (llama.cpp)",
      "options": { "baseURL": "http://127.0.0.1:51435/v1", "apiKey": "<the local api-key file>" },
      "models": { "local/qwen3.5-9b": { "name": "Qwen 3.5 9B" } }
    }
  }
}
```

**Maintenance health.** 209 k stars and a push the same day this was written; also 6,058 open
issues, which for a project this size reads as velocity rather than neglect, but is worth knowing
before depending on it.

**Commercial reach — the part that matters.** OpenCode is on the supported-tools list of the
GLM Coding Plan (alongside Claude Code, Cline, Crush, Goose, Cursor, Roo Code, Kilo Code and
OpenClaw) and on Alibaba Model Studio's. Those plans forbid calling their API from unlisted
software. So an ACP or HTTP adapter that drives OpenCode is *also* the only in-terms way for
Conductor to spend a GLM Coding Plan on anything other than Claude Code. See
`docs/budget-provider-options.md`.

---

## 2. Goose

**ACP is its primary interface, by policy.** Goose is "standardizing how clients talk to goose by
adopting ACP as the primary interface for all goose clients — desktop, CLI, and beyond", with a
`goose-acp` crate implementing a Streamable HTTP transport (with websocket upgrade) over a single
`POST /acp` endpoint, rolled out in phases: stabilise the ACP server, then a TypeScript TUI, then
the desktop migration. Zed-style configuration is `command: "goose"`, `args: ["acp"]`.

**Why it is worth a second look on MAIN specifically.** It is Rust. `docs/machine-profile.md`
budgets "a few hundred megabytes each" for native CLI coworkers and notes that builds and smokes
already contend for CPU. A Rust agent process is the cheapest possible fourth coworker on a
machine whose real constraint is that a 20 GB MoE is streaming from system RAM.

**Health.** 54,536 stars, pushed the same day, Apache-2.0, and notably **383 open issues** —
an order of magnitude tidier than OpenCode's 6,058. Apache-2.0 is also the safer licence to ship
alongside in a distributed desktop app.

**Against it.** No headless HTTP surface as mature as `opencode serve`; the ACP-over-HTTP work is
explicitly described as phased and in progress. Its orchestration story (recipes, subagents) was
not verified from a primary source in this research and should be before anything is built on it.
And it is on the GLM supported-tools list, so it shares OpenCode's commercial advantage without
OpenCode's second integration surface.

---

## How ACP maps onto Conductor

This is the reason the recommendation is "speak ACP", not "integrate OpenCode". Conductor's event
union in `src/shared/structured-agent.ts:124-135` and ACP's `session/update` notification carry
nearly the same information:

| ACP | Conductor `AgentEvent['data']` | Fit |
| --- | --- | --- |
| `session/update` agent message chunk | `{ type: 'text', role: 'assistant', mode: 'delta' }` | direct |
| `session/update` thought chunk | `{ type: 'text', role: 'status' }` — how the local adapter already renders Qwen's thinking | direct |
| `session/update` tool call / tool call update | `{ type: 'tool', status, input, output }` | direct |
| `session/update` plan | `{ type: 'plan', steps: [{ text, status }] }` | direct |
| `session/update` mode change, available commands | `{ type: 'session', settings }` / `{ type: 'notice' }` | direct |
| `session/request_permission` (client method) | `{ type: 'interaction' }` + `respond(InteractionResponse)` | direct; this is what `approvals: true` means |
| `session/cancel` (notification) | `interrupt()` | direct |
| `session/new` / `session/load` | `nativeSessionId`, `resume` | direct |
| `initialize` capability negotiation | `ProviderCapabilities` | direct — ACP negotiates versions and capabilities in the same handshake shape |
| `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (client methods) | **Conductor would implement these** | This is the one that needs design, see below |
| — | `{ type: 'usage', inputTokens, costUsd }` | **No ACP equivalent found.** Token and cost telemetry would be missing or vendor-specific. |
| — | `{ type: 'changes', changes }` | Conductor derives these from `beforeTool`/`afterTool` snapshots, which need tool-path visibility ACP may not give in the same form. |

Two of those rows are the real work.

**The client-methods inversion.** In ACP the *client* — Conductor — optionally implements file
reads, file writes and terminal management, and the agent calls back into it. Conductor already
has the pieces (`workspacePath()` containment in `src/main/agent-artifacts.ts`, the Docker
sandbox, the `beforeTool`/`afterTool` snapshot hooks), but they are wired for adapters that run
tools themselves. Implementing the ACP client side would mean Conductor becomes the sandbox for
somebody else's agent — which is a *better* security position than trusting a third-party
runtime's own permission model, and a bigger piece of work than any adapter to date.

**Usage accounting.** Conductor's context-cost work rests on `{ type: 'usage' }` events from the
provider (`source: 'provider'`). If ACP does not carry them, an ACP tab is invisible to
`scripts/measure-context-churn.mjs` and to the routing policy the swarm is building. That is a
reason to *not* make ACP the primary path for mechanical work until it is solved.

## Cost per accepted task

No runtime changes what a token costs. What a runtime changes is how many tokens a task takes
and how often a task is accepted, and **neither was measured here** — measuring it honestly means
running the same bounded fixtures through OpenCode, Goose and Conductor's own loop against the
same model, which is a download and an install this task was not authorised to do.

What can be said:

- The dominant term is the model, not the harness. `docs/context-accounting.md` records 160,000
  mean context tokens over 192 calls per session; `docs/budget-provider-options.md` shows the
  cached-versus-uncached spread for one session is 10–20x. A harness that keeps a stable prefix
  is worth more than a harness with better prompts.
- The one runtime-specific saving with a plausible mechanism is **OpenCode's parent/child
  sessions**, which are a built-in version of the fresh-tab handoff this swarm is designing. If
  Conductor builds its own, the saving is captured without a new runtime.
- The one runtime-specific *cost* is that every new harness re-reads the repository. Four agents
  independently rediscovering the same files is already ranked as a waste in the swarm plan; a
  fourth runtime with its own `AGENTS.md` conventions adds one more rediscoverer.

## Ranked recommendation

1. **Add no runtime now.** Conductor has three adapters covering the frontier CLIs and a local
   loop. Nothing screened here is a stronger model, none of them fixes a capability the owner is
   currently blocked on, and the swarm's own measurements say the leverage is in context
   handling, not in harness choice. "Keep the current stack" is the right answer for this batch.
2. **Write the ACP decision down as the next architectural step, and design it before building
   it.** The two open questions are concrete: does ACP carry usage/token accounting, and is
   Conductor willing to implement the ACP *client* methods (`fs/*`, `terminal/*`) so that it
   remains the sandbox rather than trusting a third party's? Answer those two and the rest of the
   mapping table above is mechanical. One adapter would then reach OpenCode, Goose, Gemini CLI,
   Kimi CLI, Qwen Code, OpenClaw and Hermes Agent.
3. **If one runtime is prototyped first, prototype OpenCode — over its HTTP server, not ACP.**
   `opencode serve` gives an OpenAPI 3.1 contract, an SSE stream, a one-call abort and a
   permission endpoint with `remember`, all testable with `curl` before a line of adapter code
   exists. Its ACP mode can come later; the HTTP surface is the cheaper way to learn whether the
   event stream renders usefully in a Conductor tab.
4. **Keep Goose as the fallback and the licence-safe option.** Apache-2.0, 383 open issues, Rust,
   and a stated policy of making ACP the one interface. If the ACP adapter gets built, Goose is
   the second agent to point it at, and the one to ship with if OpenCode's licence posture or
   issue backlog ever becomes a problem.
5. **Do not adopt Aider.** Four months without a push is disqualifying for something Conductor
   would spawn as a subprocess in a shipped app.
6. **Revisit OpenHands only if isolated long-running tasks become a requirement.** Its
   container-per-session model is a real capability, and it is the wrong one for a machine with
   12 GB of VRAM and one llama.cpp slot.

## Proposed exploration commands — none were executed

Everything here is read-only against a runtime installed by the owner, and none of it opens a
window over the owner's screen.

```powershell
# One-off, no global install: stand up the headless server on a spare port.
npx -y opencode-ai@latest serve --port 4097 --hostname 127.0.0.1

# Read the contract before writing any adapter code.
Invoke-RestMethod http://127.0.0.1:4097/doc | ConvertTo-Json -Depth 4 | Out-File `
  artifacts\swarm-2026-09-21\research\opencode-openapi.json -Encoding utf8

# Watch the event stream shape - this is the thing a Conductor adapter would have to render.
curl.exe -N http://127.0.0.1:4097/event

# Exercise the three verbs that matter, in order: create, abort, permission.
Invoke-RestMethod -Method Post http://127.0.0.1:4097/session
Invoke-RestMethod -Method Post http://127.0.0.1:4097/session/<id>/abort
```

```powershell
# ACP, if the owner prefers to evaluate the protocol rather than the product.
# Both of these speak JSON-RPC 2.0 over stdio - the same transport JsonLineTransport already owns.
opencode acp
goose acp
```

Neither should be pointed at a GLM Coding Plan key until the recurring price and the
credit-to-token conversion are confirmed at checkout (`docs/budget-provider-options.md`).

## Sources

All read 2026-09-21.

- <https://api.github.com/repos/…> — stars, last push, licence and open-issue counts for all six repositories, read directly from the GitHub API
- <https://agentclientprotocol.com/protocol/overview> — JSON-RPC 2.0 transport, `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/set_mode`, `session/update`, `session/request_permission`, `fs/*`, `terminal/*`, `elicitation/create`
- <https://agentclientprotocol.com/get-started/agents> — the list of ACP-speaking agents
- <https://zed.dev/blog/acp-progress-report> — v0.11.0 (2026-03-04) and editor adoption
- <https://opencode.ai/docs/server/> — `opencode serve`, port 4096, `/doc`, `GET /event`, `POST /session/:id/abort`, `POST /session/:id/permissions/:permissionID`, `OPENCODE_SERVER_PASSWORD`
- <https://opencode.ai/docs/acp/> — `opencode acp`, feature parity, the `/undo` and `/redo` gap
- <https://github.com/aaif-goose/goose/discussions/7309> and <https://github.com/aaif-goose/goose/discussions/7697> — ACP as goose's primary client interface; the `goose-acp` Streamable HTTP transport and its rollout phases
- <https://docs.z.ai/devpack/quick-start> — the GLM Coding Plan's supported-tools list (Claude Code, Roo Code, Kilo Code, Cline, OpenCode, OpenClaw, Crush, Goose, Cursor)
- <https://www.alibabacloud.com/help/en/model-studio/coding-plan> — Alibaba's supported-tools list, including OpenCode
- <https://huggingface.co/ornith-ai/Ornith-1.5-9B> — the OpenCode provider-configuration snippet adapted above
