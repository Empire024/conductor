# Dolphin X1 8B: the uncensored local model

Selected 2026-09-23 for the owner's request for "a new uncensored model that had been retrained",
added as `local/dolphin-x1-8b`. It sits beside Ornith rather than replacing it: Ornith 1.5 9B stays
the default local model.

## Why this one

The request was for a model whose refusals were removed by *training*, with credible provenance,
that fits MAIN (12 GB VRAM, one llama.cpp server at a time). Most "uncensored" checkpoints on
Hugging Face do not meet the first condition:

| Kind | Examples found 2026-09-23 | Verdict |
| --- | --- | --- |
| Abliteration / Heretic (weight surgery that projects the refusal direction out; no training) | HauhauCS Qwen3.5-9B Aggressive, dealignai Ornith-1.5-9B "CRACK", junafinity Ornith-1.5-9B-uncensored, Huihui abliterated, Qwen3.8-9B heretic | Rejected: not retrained. The Ornith ones would also duplicate the installed model. |
| Community merges that fine-tune *after* abliteration | DavidAU Qwen3.5-9B "Defiant Fable" Heretic | Rejected: multi-model merge, unverifiable benchmark claims. |
| Tensor transplants | LuffyTheFox "Genesis Hermes" 35B-A3B | Rejected: FFN blocks transplanted from another fine-tune onto an abliterated base; not a training run. |
| Trained, but too large for the GPU | dphn Dolphin-Mistral-24B Venice Edition | Rejected: dense 24B, and its first-party GGUF repository holds no files. |
| Trained, neutrally aligned rather than uncensored | NousResearch Hermes-4-14B | The more capable alternative (see below), but not an uncensored model. |
| Trained, uncensored, tiny | dphn Dolphin X1 Trinity Nano (RL de-alignment) | Rejected: 6B MoE with about 0.8B non-embedding parameters active, experimental preview base. |
| **Trained, uncensored, fits** | **dphn Dolphin X1 8B** | **Selected.** |

Dolphin X1 8B is Llama 3.1 8B Instruct fine-tuned by dphn (the Dolphin lab, formerly Cognitive
Computations). Its card says the fine-tune removes the base model's refusals while aiming to keep
its abilities, and that it was trained on 8xB200 GPUs provided by Deepinfra. The lab publishes its
own GGUFs with the LFS sha256 of every file, the same trust model as the other pinned models.

## Pinned facts

| Field | Value | Source |
| --- | --- | --- |
| Repository | `dphn/Dolphin-X1-8B-GGUF` | <https://huggingface.co/dphn/Dolphin-X1-8B-GGUF> |
| Revision | `e9a40049775e918557e2ee8f8165a059bd10b85a` (modified 2025-10-14) | HF model API |
| File | `Dolphin-X1-8B-Q4_K_M.gguf` | HF tree, `blobs=true` |
| Size | 4,920,738,784 bytes | `lfs.size` |
| sha256 | `90b091874cdfe3fa924302067b71f93a277dc6b99f839cf5569c5bc364d27d9d` | `lfs.sha256` |
| Architecture | `llama`, 8.03 B parameters, 131,072-token trained context | GGUF metadata |
| Licence | Llama 3.1 Community License | card |
| Chat template | Llama 3.1 with `tools` / `ipython`, embedded in the GGUF | GGUF metadata; llama.cpp's `--jinja` parses its tool calls |
| Safetensors card | <https://huggingface.co/dphn/Dolphin-X1-8B> | base `meta-llama/Llama-3.1-8B-Instruct` |

The download goes through `downloadModel` (src/main/local-models/provenance.ts): the pinned
revision, the exact byte count and the upstream sha256 are all checked before the file leaves
`<root>\temp`, and the result is recorded in `<root>\config\provenance.json` as `upstream-pinned`.

## Fit on MAIN

Llama 3.1 has no hybrid attention: every one of its 32 layers keeps K and V for 8 KV heads at head
size 128, which is 128 KiB per token at fp16, four times what the Qwen 3.5 / Ornith 9Bs cache.

| | Ornith 1.5 9B Q4_K_M | Dolphin X1 8B Q4_K_M |
| --- | --- | --- |
| Weights | 5.38 GiB | 4.58 GiB |
| KV at 32k, fp16 | 1.00 GiB | 4.00 GiB |
| Admission VRAM envelope (weights + KV + 1.75 GiB) | 8.13 GiB | 10.33 GiB |

That is why the pin is Q4_K_M rather than Q5_K_M (5.73 GB): Q5 would need an 11.09 GiB envelope,
more than the card has free with the desktop running. Even the fp16 Q4_K_M envelope proved too big:
the first start was refused with 9.8 GiB free (the desktop holds about 2.2 GB). Dolphin therefore
defaults to a q8_0 KV cache (`DEFAULT_KV_CACHE_TYPES` in `src/main/local-models/config.ts`, also
applied to an existing config that names no `kvCacheType`): 2.12 GiB of KV and an 8.45 GiB
envelope at 32k. Set `kvCacheType: "f16"` explicitly to opt out. Port 51438, all layers on the GPU.

## Limits

- **An older base.** Llama 3.1 8B dates from 2024; Ornith 1.5 9B is built on Qwen 3.5 (2026). No
  comparable measurement of the two exists here, so this is a note on age, not a ranking. Ornith
  stays the default local model.
- **Tool reliability in Conductor is unmeasured.** The weights are verified and registered, but no
  Dolphin server has been started on MAIN yet: the one-server check was skipped on 2026-09-23 after
  Claude Code's Auto mode refused to stop the resident Ornith server. Tool calling through the
  agent loop, VRAM use and speed are all still to be observed.
- **Steered by the system prompt.** Dolphin's card is explicit that the system prompt sets its
  alignment; Conductor's own local-agent prompt applies unchanged.
- **One server at a time.** Starting it stops an idle Ornith (or is refused while Ornith is busy),
  exactly as switching between the existing models does.
- If the owner prefers capability over being uncensored, the next candidate is
  `NousResearch/Hermes-4-14B` (Qwen3 14B, ~60 B tokens of post-training, "neutrally aligned");
  `bartowski/NousResearch_Hermes-4-14B-GGUF` Q4_K_M is 9,001,753,536 bytes, sha256
  `7ad9be1e446e3da0c149fdf55284c90be666d3e13c6e2581587853f4f9538073`. Its 40 layers × 8 KV heads ×
  128 cache 160 KiB per token, so it would need both a q8_0 KV cache and a 16k window to come in
  under the card (about 11.5 GiB envelope).
