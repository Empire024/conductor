# Task D research artifacts — 2026-09-21

Working notes and captured primary sources behind three documents:

- `docs/local-model-shortlist.md`
- `docs/budget-provider-options.md`
- `docs/agent-runtime-options.md`

## What is here

| Path | What it is |
| --- | --- |
| `raw/ornith-ai_Ornith-1.5-9B.md` | Model card as served by Hugging Face on 2026-09-21. Benchmark tables and their harness conditions. |
| `raw/ornith-ai_Ornith-1.5-35B-A3B.md` | Same, for the MoE. |
| `raw/Kwaipilot_KAT-Coder-V2.5-Dev.md` | Same, for the Apache-2.0 alternative. |
| `raw/Qwen_Qwen-AgentWorld-35B-A3B.md` | Captured to document why it was rejected (it is a world model, not a coding agent). |
| `raw/Qwen_Qwen3.8-27B.md` | Captured for the dense-model rejection. |
| `raw/detable.js` | Throwaway helper: renders the HTML tables inside those cards as plain text so the numbers can be read. `node detable.js <card.md>`. |

The cards are kept because they are the evidence for the benchmark tables in
`docs/local-model-shortlist.md`, and because a Hugging Face card can be edited in place — these
are what was actually read.

## Method

- Facts about models came from the Hugging Face model API (`/api/models/...`, `?blobs=true`, and
  `/tree/main?recursive=true` for the LFS `oid` that is the file's sha256), not from the rendered
  web pages. Parameter counts are `safetensors.total`; GGUF architectures are `gguf.architecture`.
- Memory arithmetic was derived from each model's own `config.json` (`num_hidden_layers`,
  `full_attention_interval`, `num_key_value_heads`, `head_dim`) and is shown in the document so
  it can be checked.
- Provider facts came from vendor documentation sites only. SEO aggregator pages were read during
  screening and are cited nowhere: several disagreed with each other on the same price.
- Runtime repository health came from the GitHub API on 2026-09-21, not from README claims.

## What could not be verified, and why it matters

1. **Z.ai's Pro and Max prices, and whether $18 is introductory or recurring.** `z.ai/pricing` and
   `z.ai/subscribe` render their tables client-side and return no numbers to a fetch. Only
   `docs.z.ai/devpack/overview`'s "Starting at just 18 USD per month" is quotable. Must be checked
   at checkout; the plan is non-refundable.
2. **Kimi's USD membership ladder and per-tier credit allowances.** The help centre publishes CNY
   figures for the legacy tiers (¥49 / ¥99 / ¥199 / ¥699) but the current USD ladder is on a
   JavaScript-rendered page, and kimi.com has been carrying a notice since 2026-08-20 that the
   plans are being restructured.
3. **Moonshot's data-handling and jurisdiction terms.** Not read from a primary source. Assume PRC
   handling until confirmed.
4. **What one Z.ai "credit" is in tokens.** Undocumented, which is why the cost table in
   `docs/budget-provider-options.md` prices the pay-as-you-go API instead.
5. **Any throughput number on this machine.** Deliberate. Coworker A owns the inference
   measurements against the running llama.cpp server, and the swarm rules forbid a second
   benchmark against it concurrently. None of the shortlisted models is on disk, and downloading
   5.8–21.7 GB was out of scope. The shortlist marks throughput as derived-by-analogy or unknown,
   never as measured.
6. **Cost per accepted task for any runtime.** Would require installing OpenCode and Goose and
   running the same fixtures through each. Not authorised; the document says so rather than
   estimating.

## Things found that belong to someone else

Reported here rather than changed, per the ownership rules:

- **`docs/machine-profile.md` overstates local KV cache cost by about 4x.** It says "every 8k
  tokens of context on a 9B model costs on the order of a gigabyte of KV cache at fp16". The
  Qwen3.5-family 9B actually installed has `full_attention_interval = 4`, so only 8 of its 32
  layers hold a KV cache: 8 x 4 heads x 256 head_dim x 2 (K/V) x 2 bytes = 32,768 bytes per token,
  i.e. 0.27 GB per 8k and 1.07 GB at the configured 32,768-token context. The same correction
  applies to the 35B-A3B, which is cheaper still at 20,480 bytes per token.
- **`AdapterOptions.environment` is declared and never populated.** `src/main/providers/adapter.ts:14`
  defines it and `src/main/providers/claude.ts:164-167` passes it to the spawned process, but
  `StructuredSessions.options()` (`src/main/structured-sessions.ts:187-213`) never sets it. It is
  the natural hook for the Anthropic-compatible-endpoint path and currently a no-op.
- **Sampling parameters for local models are fixed in the client.** `client.ts` sends
  `temperature: 0.3` and no `top_p`/`top_k`. Every card for the shortlisted models recommends
  `temperature 0.6, top_p 0.95, top_k 20` for precise coding work. That belongs to coworker A's
  area, not this one.
