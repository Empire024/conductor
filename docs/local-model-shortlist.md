# Local model shortlist for MAIN

Researched 2026-09-21 for the token-thrift swarm. Nothing here was downloaded, installed or
started: every command and config block below is a proposal for the owner to run.

Read `docs/machine-profile.md` first — it records the 12 GB of VRAM, 63 GB of RAM and the
one-llama.cpp-server-at-a-time rule that every candidate is measured against.

## How to read the evidence labels

| Label | Meaning |
| --- | --- |
| **measured here** | A number this machine produced. There are none in this document; see "Throughput" below for why. |
| **published (conditions named)** | A vendor or lab number whose harness, scaffold and sampling settings are stated in the source. |
| **published (conditions unknown)** | A number without its harness. Treated as marketing, not evidence. |
| **derived** | Arithmetic from primary facts (file sizes, `config.json` shapes). The arithmetic is shown so it can be checked. |

## What runs today

Read from `D:\ConductorLocal\config\config.json` on 2026-09-21 (read-only):

| Id | GGUF | Quant | On disk | Context | `--n-gpu-layers` | Port |
| --- | --- | --- | --- | --- | --- | --- |
| `local/qwen3.5-9b` | `lmstudio-community/Qwen3.5-9B-GGUF` | Q4_K_M | 5.63 GB | 32,768 | 999 (all) | 51435 |
| `local/qwen3.6-35b-a3b` | `ggml-org/Qwen3.6-35B-A3B-GGUF` | Q4_K_M | 20.42 GB | 32,768 | 10 | 51436 |

llama.cpp in use: `version: 0.4.0-dev (build 10901, commit 28ff09582)`, installed through WinGet
(`ggml.llamacpp`). The server is launched with `--jinja`, so the GGUF's own chat template drives
tool calling, and with `--parallel 1` (`src/main/local-models/llama.ts:29-45`).

## Screening

Every candidate the brief named, plus what the Hugging Face model index actually surfaced on
2026-09-21, screened against "fits MAIN, is served by llama.cpp build 10901, is newer or better
than what is already configured".

| Candidate | Total params | Smallest usable GGUF | Verdict |
| --- | --- | --- | --- |
| **Ornith-1.5-9B** | 9.65 B dense | Q4_K_M **5.78 GB** | **Deep dive.** Same architecture and KV shape as the configured 9B; large published agentic gains. |
| **Ornith-1.5-35B-A3B** | 35.95 B MoE / 3 B active | Q4_K_M **21.71 GB** | **Deep dive.** Same class as the configured 35B; large published agentic gains. |
| **KAT-Coder-V2.5-Dev** | 34.66 B MoE / 3 B active | Q4_K_M (bartowski imatrix build) | **Deep dive.** Apache-2.0 alternative in the same footprint, agentic-coding post-train. |
| Qwen3-Coder-Next | 80 B MoE / 3 B active | Q4_K_M **48.40 GB** (4 shards) | Rejected: weights alone are 77% of the 63 GB of RAM, before KV cache, Electron, Docker and Windows. Does not fit MAIN. |
| Qwen3.8-Flash-Next | 180 B | — | Rejected: about 100 GB at Q4. Also `license: other`, not Apache/MIT. |
| GLM-5.3 / GLM-5.3-Flash (open weights) | 744 B / 320 B | — | Rejected on size. These are the models to *rent* (see `docs/budget-provider-options.md`), not to host. |
| Qwen3.8-27B (dense, Apache-2.0, 2026-08-14) | 27.78 B dense | ≈17 GB at Q4_K_M | Rejected: a dense 27B cannot sit in 12 GB of VRAM, so most layers stream from system RAM at ~1 active parameter per weight read. `docs/machine-profile.md` already rules out dense >24 B. Worth revisiting only if the owner accepts single-digit tokens/s. |
| Qwen-AgentWorld-35B-A3B | 34.66 B MoE / 3 B active | — | Rejected on purpose, not size: it is a *language world model* that simulates environments ("predicting the next environment state given an agent's action"), not a coding agent. Interesting for building evaluation harnesses; useless as a Conductor coworker. |
| gpt-oss-20b | 21 B MoE | ≈12 GB (mxfp4) | Rejected on age: last touched 2025-08-26. Every 2026 model in this table outclasses it on the same benchmarks. |
| Gemma-4-31B, Muse-Glimmer-30B | 31 B / 30 B dense | — | Rejected on size for the same reason as Qwen3.8-27B; both appear in the comparison columns below and lose to Ornith-1.5-35B-A3B anyway. |

---

## 1. Ornith-1.5-9B — the drop-in replacement for the configured 9B

**Primary sources.** Model card <https://huggingface.co/ornith-ai/Ornith-1.5-9B> (repo last
modified 2026-08-23); GGUF repo <https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF> (last
modified 2026-08-24, revision `abdd624b12ebf020b767fff532ff44fe552b28c3`). Both read through the
Hugging Face model API on 2026-09-21.

| Fact | Value | Evidence |
| --- | --- | --- |
| Total weights | 9,653,104,368 parameters | `safetensors.total` from the HF model API |
| Quantization to use | Q4_K_M, **5,780,090,816 bytes** (5.78 GB), sha256 `70c1…fab6` | HF tree API, `lfs.oid` |
| Alternative | Q5_K_M, 6,642,544,576 bytes, sha256 `e4d9…247d` | same |
| GGUF architecture | `qwen35` | HF `gguf.architecture` |
| llama.cpp support | **Certain.** The configured `local/qwen3.5-9b` GGUF also reports `qwen35`, and build 10901 loads it today. | `lmstudio-community/Qwen3.5-9B-GGUF` `gguf.architecture` = `qwen35` |
| Native context | 262,144 tokens; ~1 M with YaRN `factor: 4.0` | model card |
| License | MIT | `cardData.license` |
| Vision | An `mmproj` file is published (0.92 GB). Conductor's local adapter sends text only, so it is not needed. | GGUF repo listing |

**Provenance caution.** `ornith-ai` is not a lab the owner already trusts. The card describes
Ornith-1.5 as built "on top of Qwen3.5 and Gemma4 with additional continued pretraining,
mid-training, and post-training", with a blog at `ornith.ai` / `deep-reinforce.com`. The GGUF
repo had 5.86 M downloads on 2026-09-21, and the safetensors repo 533,783 — high, but downloads
are not provenance. Conductor's `PINNED_MODELS` table exists exactly for this: pin the revision
and the sha256 below and `setup`/`start` re-verify the bytes
(`src/main/local-models/config.ts:53-65`).

### KV cache and memory (derived)

Qwen3.5 is a hybrid: `full_attention_interval = 4`, so only 8 of 32 layers keep a real KV cache;
the other 24 are Gated DeltaNet layers whose recurrent state is constant per sequence (about
25 MB total at these dimensions), not per token.

```
KV bytes/token = full_attn_layers x num_key_value_heads x head_dim x 2 (K and V) x 2 (fp16)
               = 8 x 4 x 256 x 2 x 2 = 32,768 bytes
```

| Context | KV cache (fp16) | Weights + KV |
| --- | --- | --- |
| 32,768 (the configured value) | **1.07 GB** | 6.85 GB |
| 65,536 | 2.15 GB | 7.93 GB |
| 131,072 | 4.29 GB | 10.07 GB |

All of these fit in 12 GB of VRAM with `--n-gpu-layers 999`, the current setting. The
configuration needs no change beyond the file.

> **Reported, not changed:** `docs/machine-profile.md` says "every 8k tokens of context on a 9B
> model costs on the order of a gigabyte of KV cache at fp16". For the Qwen3.5-family 9B actually
> installed here it is 0.27 GB per 8k — about four times cheaper — because three quarters of its
> layers are linear-attention. That paragraph is worth correcting; I do not own that file.

### Published quality (conditions named)

From the Ornith-1.5-9B card. The card states every result is "averaged over five independent
runs" and names each harness. `Qwen3.5-9B` is the model configured on MAIN today.

| Benchmark (harness) | **Ornith-1.5-9B** | Qwen3.5-9B (today) | Qwen3.6-35B-A3B (today) |
| --- | --- | --- | --- |
| Terminal-Bench 2.1 (Harbor/Terminus-2, 128K ctx) | **46.2** | 21.3 | 52.5 |
| Terminal-Bench 2.1 (Claude Code 2.1.126, max_new_tokens 131072) | **47** | 18.9 | 49.2 |
| SWE-bench Verified (OpenHands harness, temp 1.0, top_p 0.95, 256K ctx) | **70.6** | 53.2 | 73.4 |
| SWE-bench Pro (same) | **47.5** | 31.3 | 49.5 |
| NL2Repo (400K ctx, 48K output) | **32.4** | 16.2 | 29.4 |
| MCP-Atlas (500-task public subset, Claude 4.8 Opus judge) | **54.2** | 46.8 | 62.8 |
| Toolathlon-Verified (official service, 128K max tokens) | **41.2** | 29.6 | 41.7 |
| ClawEval (temp 0.6, 256K ctx) | **66.5** | 53.2 | 68.7 |

The headline for Conductor: on the two benchmarks that most resemble what a local coworker
actually does — Terminal-Bench (a shell agent) and Toolathlon (tool calling) — a 5.78 GB model
would move from 21.3 to 46.2 and from 29.6 to 41.2, reaching roughly the level of the 20.4 GB
MoE that currently has to run mostly from system RAM.

These are the vendor's own numbers on its own card, with an evaluation setup that is stated but
not independently reproduced. Treat the ordering as credible and the absolute values as the
vendor's.

### Tool-use evidence

- The card shows a worked OpenAI-style `tools` / `tool_calls` round trip and states the model
  "emits well-formed function calls that the server parses into the standard `tool_calls` field".
- The GGUF chat template emits XML-shaped calls
  (`<tool_call><function=name><parameter=x>…`), which is the Qwen3-Coder convention. llama.cpp's
  `--jinja` path — already enabled in `llamaServerArgs` — is what converts those into the
  OpenAI `tool_calls` deltas `src/main/local-models/client.ts` accumulates.
- **This is the one thing to verify before trusting it.** The tool-call grammar differs from
  Qwen3.5-9B's, and `src/main/local-models/agent.ts` repairs the tool protocol on a 400. A first
  run that produces text-shaped `<tool_call>` blocks inside `content` instead of parsed
  `tool_calls` would mean llama.cpp build 10901 does not recognise this template variant. The
  verification is one request; see "Proposed commands" below.

---

## 2. Ornith-1.5-35B-A3B — the drop-in replacement for the configured 35B

**Primary sources.** <https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B> and
<https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF> (both last modified 2026-08-23/24;
GGUF revision `12393612fd4f730ff5aadc23e9b8f9648aa49ceb`), read 2026-09-21.

| Fact | Value |
| --- | --- |
| Total / active | 35,951,822,704 parameters, ~3 B active per token (8 of 256 routed experts + 1 shared) |
| Quantization | Q4_K_M, **21,713,463,040 bytes** (21.71 GB), sha256 `4273…d41f` |
| GGUF architecture | `qwen35moe` — identical to the configured `ggml-org/Qwen3.6-35B-A3B-GGUF`, so build 10901 loads it |
| Native context | 262,144 tokens |
| License | MIT |
| KV geometry | 40 layers, `full_attention_interval 4` → 10 full-attention layers, 2 KV heads, head_dim 256 |

KV cache (derived): `10 x 2 x 256 x 2 x 2 = 20,480 bytes/token` → **0.67 GB at 32k**, 1.34 GB at
64k, 2.68 GB at 128k. Cheaper per token than the 9B.

**Fit.** 21.71 GB of weights is 1.29 GB more than the 20.42 GB already configured for
`local/qwen3.6-35b-a3b`, which runs with `--n-gpu-layers 10` and spills the rest to system RAM.
The same `gpuLayers: 10` should hold; if VRAM is tight after the extra 1.3 GB, drop to 8. The
machine profile's 32 GB-free figure covers it.

### Published quality (conditions named)

Same card, same five-run protocol and harnesses. `Qwen3.6-35B-A3B` is the model configured today.

| Benchmark (harness) | **Ornith-1.5-35B-A3B** | Qwen3.6-35B-A3B (today) | Qwen3.5-397B | Gemma-4-31B |
| --- | --- | --- | --- | --- |
| Terminal-Bench 2.1 (Terminus-2) | **67.8** | 52.5 | 53.5 | 42.1 |
| Terminal-Bench 2.1 (Claude Code) | **68.5** | 49.2 | 48.6 | – |
| SWE-bench Verified (OpenHands) | **79** | 73.4 | 76.4 | 52 |
| SWE-bench Pro | **59.6** | 49.5 | 51.6 | 35.7 |
| SWE-bench Multilingual | **71.4** | 67.2 | 69.3 | 51.7 |
| NL2Repo | **46.2** | 29.4 | – | 15.5 |

If these hold, MAIN's 21.7 GB local model would beat a 397 B model on agentic coding. That claim
is extraordinary enough that the acceptance test matters more than the table: run it on the
bounded local-acceptance fixtures the controller prepares, not on the benchmark scores.

---

## 3. KAT-Coder-V2.5-Dev — the Apache-2.0 alternative in the same footprint

**Primary source.** <https://huggingface.co/Kwaipilot/KAT-Coder-V2.5-Dev>, last modified
2026-07-28, read 2026-09-21. GGUF builds: `bartowski/Kwaipilot_KAT-Coder-V2.5-Dev-GGUF`
(`gguf.architecture` = `qwen35moe`, imatrix-quantized, 386 k downloads).

| Fact | Value |
| --- | --- |
| Total / active | 34,660,610,688 parameters, 3 B active; base model `Qwen3.6-35B-A3B` |
| License | Apache-2.0 |
| Context | 262,144 |
| Modality | Text only — "the vision/multimodal components are not included" |
| Published claim | "SOTA results in the field of Agentic Coding among models with similar parameter scales"; abnormal tool labels reduced from 9.34% to 0.28% |

Its own comparison table reports **SWE-bench Verified 69.40** for itself against **64.40** for
Qwen3.6-35B-A3B. Note that Qwen's own card reports **73.4** for that same model, and Ornith's
card reports **73.4** as well. The 9-point gap between Kwaipilot's 64.40 and Qwen's 73.4 for one
identical checkpoint is the reason this document insists on harness conditions: Kwaipilot does
not name its scaffold, so its numbers cannot be placed on the same axis as the other two cards.

**Why it is third, not first.** Apache-2.0 is a cleaner licence than MIT-from-an-unfamiliar-org
for some owners, and a Kuaishou-affiliated lab is a known quantity. But on unnamed-harness
numbers it is behind Ornith-1.5-35B-A3B in the same memory budget, there is no first-party GGUF
(only a community requant), and the safetensors repo had 9,767 downloads against Ornith's
401,566. Keep it as the fallback if Ornith's tool-call template or provenance does not survive
the verification run.

---

## Throughput

**No throughput was measured for this task, deliberately.** Coworker A owns the inference
measurements on the running server, and the swarm rules forbid a second benchmark against the
same llama.cpp process while a native coworker is using it. None of the three candidates is on
disk, so measuring any of them would require a 5.8–21.7 GB download, which is also out of scope.

What can be said without measuring:

- **Ornith-1.5-9B will run at the same speed as `local/qwen3.5-9b` does today**, within noise.
  Identical architecture, identical layer count, identical KV geometry, file 2.7% larger, same
  full GPU offload. Whatever A measures for the configured 9B transfers directly. *(derived)*
- **Ornith-1.5-35B-A3B will be slightly slower than `local/qwen3.6-35b-a3b`**, because 1.29 GB
  more of it streams from system RAM per token at the same `gpuLayers: 10`. Both are 3 B-active
  MoEs, so the per-token weight traffic is otherwise the same. *(derived)*
- Absolute tokens/s for either: **unknown** until A's numbers land. Do not quote a figure.

## Ranked recommendation

1. **Swap `local/qwen3.5-9b` to Ornith-1.5-9B.** Best return per gigabyte on this machine by a
   wide margin: a 5.78 GB download, no configuration change beyond the pin, no VRAM change, and
   a published jump from 21.3 to 46.2 on Terminal-Bench and 29.6 to 41.2 on Toolathlon. The 9B
   is Conductor's default local model (`DEFAULT_LOCAL_MODEL`), so this is the change that most
   of the local token-saving work would actually run on. Gate it on the tool-call verification
   below.
2. **Then swap `local/qwen3.6-35b-a3b` to Ornith-1.5-35B-A3B.** Bigger published gain, bigger
   download (21.71 GB), and it is the model used less often. Do it second so the 9B's
   verification de-risks the tool-call template first — the two share one.
3. **Keep the current stack if either verification fails.** Qwen3.5-9B and Qwen3.6-35B-A3B are
   pinned, verified, working and understood. The whole case for Ornith rests on one vendor's
   own benchmark card; a model that cannot emit parsed `tool_calls` through build 10901 is worth
   zero to Conductor no matter what it scores.
4. **Do not add a third model.** The machine runs one llama.cpp server at a time. A third entry
   in `PINNED_MODELS` buys nothing but disk and a way to get the admission rule wrong.
5. **Do not chase Qwen3-Coder-Next or anything above ~24 GB of weights.** 48.40 GB at Q4_K_M
   against 63 GB of total RAM is not a tight fit, it is a swap-thrash.

## Proposed commands and configuration — none of this was executed

### Step 0 — verify the tool-call template before downloading 21 GB

This is the cheap gate. It downloads only the 5.78 GB 9B and asks whether llama.cpp build 10901
parses its tool calls into OpenAI `tool_calls`. Run it while no other local model server is up
(the machine profile's one-server rule), from a normal PowerShell prompt:

```powershell
# 1. Fetch just the one quantization into the local model root (about 5.8 GB).
$env:HF_HUB_ENABLE_HF_TRANSFER = "1"
huggingface-cli download ornith-ai/Ornith-1.5-9B-GGUF `
  Ornith-1.5-9B-Q4_K_M.gguf `
  --revision abdd624b12ebf020b767fff532ff44fe552b28c3 `
  --local-dir D:\ConductorLocal\temp\ornith-9b

# 2. Confirm the bytes match what this document pinned.
(Get-FileHash D:\ConductorLocal\temp\ornith-9b\Ornith-1.5-9B-Q4_K_M.gguf -Algorithm SHA256).Hash.ToLower()
# expect 70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6

# 3. Serve it exactly the way Conductor would (same flags as llamaServerArgs).
& "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\llama-server.exe" `
  --host 127.0.0.1 --port 51437 --api-key $env:CONDUCTOR_PROBE_KEY --no-webui `
  --model D:\ConductorLocal\temp\ornith-9b\Ornith-1.5-9B-Q4_K_M.gguf `
  --alias probe/ornith-9b --ctx-size 32768 --n-gpu-layers 999 --parallel 1 --jinja
```

Then, in a second shell, the one question that matters:

```powershell
$body = @{
  model = "probe/ornith-9b"
  messages = @(@{ role = "user"; content = "What is the weather in Paris? Use the tool." })
  tools = @(@{ type = "function"; function = @{
      name = "get_weather"; description = "Get the current weather for a city"
      parameters = @{ type = "object"; properties = @{ city = @{ type = "string" } }; required = @("city") } } })
  tool_choice = "auto"; temperature = 0.6; max_tokens = 512; stream = $false
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri http://127.0.0.1:51437/v1/chat/completions -Method Post `
  -Headers @{ Authorization = "Bearer $env:CONDUCTOR_PROBE_KEY" } `
  -ContentType "application/json" -Body $body |
  ForEach-Object { $_.choices[0].message } | ConvertTo-Json -Depth 5
```

**Pass:** the reply has a `tool_calls` array with `function.name = "get_weather"` and JSON
arguments. **Fail:** the reply has raw `<tool_call>` XML sitting in `content`. On a fail, stop —
Conductor's `StreamAccumulator` would never see a tool call, and the whole recommendation is void
until llama.cpp gains the template or the owner upgrades the build.

### Step 1 — the pin, if step 0 passes

Additive entries for `PINNED_MODELS` in `src/main/local-models/config.ts`. **This file is not
mine to edit**; this is the hunk to hand to whoever owns it. New ids rather than replacements,
so a failed swap is one config edit away from being undone:

```ts
export const ORNITH_9B = 'local/ornith1.5-9b'
export const ORNITH_35B = 'local/ornith1.5-35b-a3b'

// in PINNED_MODELS:
[ORNITH_9B]: [
  { id: ORNITH_9B, label: 'Ornith 1.5 9B (local)', repo: 'ornith-ai/Ornith-1.5-9B-GGUF',
    revision: 'abdd624b12ebf020b767fff532ff44fe552b28c3', file: 'Ornith-1.5-9B-Q4_K_M.gguf',
    quant: 'Q4_K_M', sizeBytes: 5780090816,
    sha256: '70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6' },
  { id: ORNITH_9B, label: 'Ornith 1.5 9B (local)', repo: 'ornith-ai/Ornith-1.5-9B-GGUF',
    revision: 'abdd624b12ebf020b767fff532ff44fe552b28c3', file: 'Ornith-1.5-9B-Q5_K_M.gguf',
    quant: 'Q5_K_M', sizeBytes: 6642544576,
    sha256: 'e4d9634a3b6546a5c00a8680568fe1125f6c98c704ee51ae52ba07650fb4247d' }
],
[ORNITH_35B]: [
  { id: ORNITH_35B, label: 'Ornith 1.5 35B-A3B (local)', repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF',
    revision: '12393612fd4f730ff5aadc23e9b8f9648aa49ceb', file: 'Ornith-1.5-35B-Q4_K_M.gguf',
    quant: 'Q4_K_M', sizeBytes: 21713463040,
    sha256: '42739874cc2ccfdb8523b23fbe52e29b2a7555c8176737ca9ca0b5d59859d41f' }
]

// DEFAULT_PORTS / DEFAULT_GPU_LAYERS, matching the models they replace:
//   [ORNITH_9B]: 51437, [ORNITH_35B]: 51438
//   [ORNITH_9B]: 999,   [ORNITH_35B]: 10
```

`validateConfig` accepts these as written: the ids match `^local/[a-z0-9][a-z0-9._-]{0,48}$`, the
repos match the `owner/name` pattern, the filenames match `^[A-Za-z0-9._-]+\.gguf$`, and
`contextTokens` stays at the 32,768 default (`src/main/local-models/config.ts:134-152`).

Sampling settings from the model card, if the owner wants them in `extraArgs`: precise coding
work wants `temperature 0.6, top_p 0.95, top_k 20, min_p 0.0`. Conductor currently sends
`temperature: 0.3` from `client.ts` and no top_p, which is a separate question for coworker A.

### Step 2 — what *not* to configure

Do not raise `contextTokens` past 32,768 to chase the 262 k native window. At 128 k the 9B's KV
cache is 4.29 GB, which with 5.78 GB of weights leaves under 2 GB of headroom on a 12 GB card
that also drives the desktop. The machine profile's "prefer smaller contexts and prompt-cache
reuse" rule is the right one.

Do not enable YaRN. The Ornith card is explicit that open-source runtimes apply the scaling
factor to every request regardless of length, "which can slightly hurt quality on
ordinary-length inputs".

## Sources

All read 2026-09-21 through the Hugging Face model API or the public model cards.

- <https://huggingface.co/ornith-ai/Ornith-1.5-9B> — card, benchmarks, harness conditions, licence (repo modified 2026-08-23)
- <https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF> — quantizations, sizes, sha256, `gguf.architecture` (modified 2026-08-24)
- <https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B> — card and benchmarks (modified 2026-08-23)
- <https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF> — quantizations, sizes, sha256 (modified 2026-08-24)
- <https://huggingface.co/Kwaipilot/KAT-Coder-V2.5-Dev> — card, licence, claims (modified 2026-07-28)
- <https://huggingface.co/bartowski/Kwaipilot_KAT-Coder-V2.5-Dev-GGUF> — community GGUF, architecture
- <https://huggingface.co/Qwen/Qwen3.6-35B-A3B> — 262 k context, Apache-2.0, SWE-bench Verified 73.4 (modified 2026-04-24)
- <https://huggingface.co/Qwen/Qwen3.5-9B> and <https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF> — baseline KV geometry and `qwen35` architecture
- <https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF> — 4-shard Q4_K_M totalling 48.40 GB (modified 2026-02-04)
- <https://huggingface.co/Qwen/Qwen3.8-27B> — 27.78 B dense, Apache-2.0 (modified 2026-08-14)
- <https://huggingface.co/Qwen/Qwen3.8-Flash-Next> — 180 B, `license: other` (modified 2026-08-27)
- <https://huggingface.co/Qwen/Qwen-AgentWorld-35B-A3B> — world model, not a coding agent (modified 2026-06-25)
- <https://huggingface.co/openai/gpt-oss-20b> — Apache-2.0, last modified 2025-08-26
