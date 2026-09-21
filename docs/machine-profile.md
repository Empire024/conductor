# Machine profile: MAIN

What this computer can carry, so that agents, local models and swarms stay inside it. Recorded 2026-09-21; update it when hardware changes.

## Hardware

| Part | Capacity |
| --- | --- |
| CPU | AMD Ryzen 9 7900, 12 cores / 24 threads |
| RAM | 63 GB (about 32 GB free with a 9B local model loaded and the usual desktop running) |
| GPU | NVIDIA GeForce RTX 5070, 12 GB VRAM (an AMD iGPU is present and unused) |
| Disks | C: 930 GB system drive, keep model files off it; D: 1.9 TB with the local model root `D:\ConductorLocal`; E: 1.9 TB |

## What that means for local models

- One llama.cpp server at a time is the rule. The Qwen 3.5 9B Q4_K_M server holds about 8 GB of the 12 GB VRAM; a second server would spill to system RAM and slow both.
- Models that fit comfortably: dense models up to about 9-14B at Q4, and mixture-of-experts models with about 3B active parameters (Qwen 3.6 35B-A3B at Q4 is 19 GB on disk, so it runs mostly from RAM with the KV cache and some layers on the GPU). Anything dense above about 24B at Q4 does not fit the GPU and is slow.
- Context still costs memory, less than the rule of thumb says: the configured Qwen 3.5 9B keeps a KV cache on 8 of its 32 layers (hybrid attention), about 0.27 GB per 8k tokens and 1.07 GB at the configured 32k; the 35B-A3B about 0.17 GB per 8k (derived from the models' config.json, see docs/local-model-shortlist.md). Prefer prompt-cache reuse over larger windows all the same: a longer prompt is re-evaluated whenever its prefix changes.
- Downloads are multi-gigabyte; propose the command, do not start one on the owner's behalf.

## What that means for swarms

- Native CLI coworkers (Claude Code, Codex) are cheap for this machine: a few hundred megabytes each. Four at once is fine; the limit is the provider budget, not the hardware.
- A local model coworker and a native coworker can run together. Two local model coworkers cannot unless they share the one running server (same model), which they do automatically.
- Builds (`npm.cmd run build`) and the Electron smoke scripts are CPU-heavy for about a minute; running several at once makes each slower and can push a smoke past its timeout. Run smokes one at a time.

## Budget signals

Provider usage windows are recorded in the app (usage events carry `rateLimits`); `scripts/measure-context-churn.mjs` and `scripts/probe-context-cost.mjs` measure what a turn costs. Check them before a large batch rather than assuming the previous session's numbers still hold.
