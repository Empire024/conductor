Task done and marked complete. Report:

## What I changed

Three new documents, all inside my exclusive ownership. No code, no downloads, no installs, no purchases, and nothing outside my file list was touched (`git status` confirms the other 45 modified files are other coworkers').

| File | Lines | Committable |
| --- | --- | --- |
| `docs/local-model-shortlist.md` | 369 | yes |
| `docs/budget-provider-options.md` | 401 | yes |
| `docs/agent-runtime-options.md` | 259 | yes |
| `artifacts/swarm-2026-09-21/research/` (README + 5 captured model cards + a helper) | — | **no — `artifacts/` is in `.gitignore`** |

All four written with CRLF to match the repo.

## What I measured

No inference throughput, deliberately: coworker A owns the running llama.cpp server and rule 7 forbids a concurrent benchmark; none of the shortlisted models is on disk. Every number below is either read from a primary API or derived arithmetic, and the docs label which.

- **KV cache geometry, derived from each model's `config.json`.** The Qwen3.5 family is hybrid — `full_attention_interval = 4`, so only 8 of 32 layers (9B) and 10 of 40 (35B) hold a KV cache. That gives 32,768 B/token and 20,480 B/token → **1.07 GB and 0.67 GB at the configured 32,768 context**.
- **GGUF facts from the HF API:** Ornith-1.5-9B Q4_K_M = 5,780,090,816 B, sha256 `70c112…fab6`; Ornith-1.5-35B-A3B Q4_K_M = 21,713,463,040 B, sha256 `427398…d41f`. Architectures `qwen35` / `qwen35moe` — **byte-identical arch strings to the two GGUFs build 10901 already loads**, so llama.cpp support is certain rather than assumed.
- **Rejection by arithmetic:** Qwen3-Coder-Next Q4_K_M is 48.40 GB across 4 shards — 77% of 63 GB of RAM before KV, Electron and Docker.
- **Cost per session**, anchored on `docs/context-accounting.md`'s 160k × 192 calls: DeepSeek `deepseek-flash` $0.26–$4.78, GLM-5.3 API $9.25–$44.28, `kimi-k3` $13.54–$96.48. The cached/uncached spread (10–20×) is larger than the spread between vendors.
- **Runtime health from the GitHub API:** OpenCode 209,102★ MIT pushed today; Goose 54,536★ Apache-2.0 pushed today, 383 open issues; **Aider last pushed 2026-05-22** — four months stale, which is what disqualified it.

## What I recommend

**Local:** swap `local/qwen3.5-9b` → **Ornith-1.5-9B** (5.78 GB, same VRAM, same `gpuLayers`, published Terminal-Bench 21.3 → 46.2), then the 35B. Gated on one cheap probe: its chat template emits XML tool calls, and if build 10901's `--jinja` doesn't parse them into OpenAI `tool_calls`, `StreamAccumulator` never sees a tool call and the whole case is void. The exact probe command is in the doc.

**Remote:** keep the current stack as default (Codex/Claude were at 7%/11%). If anything, **$20 of Kimi API credit once, not monthly** — the only ≤$20 option satisfying all three Conductor paths, the only one publishing concurrency (40 at Tier2), and the only one with a 1-hour cache TTL. Then Z.ai at $18/month **through the Claude adapter only**.

**Runtimes:** add none now. The real finding is that five of six speak **ACP** — as do Codex CLI, Gemini CLI, Kimi CLI, Qwen Code and OpenClaw. One ACP adapter beats any single integration; its event model maps almost 1:1 onto Conductor's, with two genuine gaps (no usage/token accounting, and Conductor would have to implement the ACP *client* `fs/*` and `terminal/*` methods).

## The central integration finding

**A tools-only subscription cannot legally reach Conductor's local adapter.** Z.ai's FAQ: "API calls outside the plan are not available"; Alibaba's terms forbid the key in "automated scripts, application backends". Conductor is on nobody's supported-tools list; Claude Code, OpenCode, Goose and Crush are. So the Claude-adapter path isn't merely cheapest to build — it's the only in-terms one for the cheapest subscriptions, and OpenCode is what would unlock the rest.

Its cost is concrete. `AdapterOptions.environment` exists (`adapter.ts:14`) and is **never populated** — populating it per session is safe and doesn't touch `~/.claude/settings.json`. But Claude Code's documented precedence is that a settings-file `env` block **overwrites the process environment**, and every vendor quick-start tells you to write that file — so a vendor setup would silently redirect the owner's subscription tabs. Plus `ANTHROPIC_API_KEY` "is used instead of your subscription even if you are logged in", a non-first-party base URL disables MCP tool search, and `cumulativeCostUsd` (`claude.ts:503`) would price GLM tokens at Anthropic rates.

## What I did not do, and why

- No `tsc`/`vitest`: I wrote no code. Running them now would only surface other coworkers' in-flight work.
- No smoke script: nothing I produced is visible in the app.
- Couldn't confirm **Z.ai's Pro/Max prices or whether $18 is introductory** — `z.ai/pricing` and `/subscribe` are JS-rendered. Same for Kimi's current USD ladder. Both flagged as check-at-checkout; the Z.ai plan is non-refundable.
- Moonshot's data-handling terms unverified — assume PRC.
- Quoted **no remote benchmark numbers at all.** Every reachable score for GLM-5.3/K3/V4 came without a harness, and one identical checkpoint (Qwen3.6-35B-A3B) is reported at 64.40 and 73.4 on SWE-bench Verified by two different cards. An unconditioned number would be worse than none.

## Three things for other owners

1. **`docs/machine-profile.md` overstates local KV cost ~4×.** "On the order of a gigabyte per 8k tokens" is actually 0.27 GB per 8k for the installed 9B. Not my file.
2. **`AdapterOptions.environment` is declared and never set** (`structured-sessions.ts:187-213`) — the natural hook for path A, currently a no-op.
3. **`client.ts` pins `temperature: 0.3` with no `top_p`/`top_k`;** every shortlisted card recommends `0.6 / 0.95 / 20` for coding. Coworker A's area.

One caution for the controller: my `src/main/local-models/config.ts` and `llama.ts` line citations were taken against the tree as I read it, and coworker A has since modified both — worth a glance before integration.

CONDUCTOR_MEMORY[procedural]: When evaluating a local model for Conductor's PINNED_MODELS, read the facts from the Hugging Face API rather than model pages — `/api/models/<id>` gives `safetensors.total`, `cardData.license` and `gguf.architecture` (compare it against an already-configured GGUF's architecture to prove llama.cpp support), `/api/models/<id>/tree/main?recursive=true` gives the `lfs.oid` that is the pinnable sha256 plus exact byte size, and the model's raw `config.json` gives `num_hidden_layers`/`full_attention_interval`/`num_key_value_heads`/`head_dim` for real KV-cache arithmetic. | cues: local model shortlist, PINNED_MODELS, huggingface api, gguf architecture, sha256 pin, KV cache sizing, llama.cpp support