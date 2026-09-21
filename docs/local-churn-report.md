# Local churn acceptance report

Measurement date: 2026-09-22. Machine limits and model residency rules come from `docs/machine-profile.md`.

## Method

`scripts/measure-local-churn.mjs` samples system CPU, used RAM, GPU utilization, VRAM use, and the recorded llama process once per second for a bounded period. It writes JSON under `artifacts/local-churn/`. It reads runtime records and operating system counters only; it does not read API keys, prompts, model configuration, or file contents.

Prompt and generation throughput come from llama.cpp timing fields emitted with the local provider usage event. Only counts and milliseconds are reported. A workload is accepted only when its requested tool edit is present and its focused verification passes; repeated calls, failures, and repair attempts are recorded alongside throughput.

## Failed Qwen workload observed before the repair

- Result: rejected. The local coworker stopped after 16 tool rounds without an edit or final answer.
- Elapsed time: about 25 seconds.
- Behavior: the same five `read_file` inputs and outputs recurred. Their sanitized input and output digests were identical on each recurrence.
- Timing range from provider usage events: generation 81.8–83.1 tokens/s. Fresh prompt segments were usually 820 tokens at 2,784–2,837 tokens/s; the repeated cached shape evaluated four prompt tokens at 104–123 tokens/s. These rates show that inference was fast while the task made no progress.
- Cause: the focused regression definitively confirms that the pre-fix trim algorithm dropped the latest oversized multi-tool batch and its results. For this original live failure, that cause is inferred rather than directly replayed: the original outbound message body was not captured, but its oversized batch shape, repeating sanitized input/output digests, and reset prompt-token shapes match the confirmed failure mode.

## Acceptance measurements

The small edit fixture was accepted in 1.743 seconds: `read_file` and `edit_file` both succeeded, the requested marker changed, and the final answer was `EDIT_ACCEPTED`. Uncached prompt evaluation was 2,860.7 tokens/s; generation across the three requests was 83.8, 84.5, and 78.8 tokens/s.

During that fixture, two one-second samples recorded 11.0–27.5% total CPU, 30,190–30,587 MiB used RAM, 7–87% GPU utilization, and 8,158–8,162 MiB VRAM use. The full bounded 240-second sampling window recorded 172 samples: CPU 2.0–34.4% (13.6% mean), used RAM 29,278–31,043 MiB (30,182 MiB mean), GPU 0–94% (7.5% mean), and VRAM 8,000–8,189 MiB (8,137 MiB mean).

The follow-up useful task edited this report and was accepted in 2.935 seconds with one read and one edit. Its three requests generated at 89.8, 89.5, and 88.2 tokens/s. Samples spanning that task recorded 18.5–34.4% CPU, 30,565–30,625 MiB used RAM, 7–94% GPU utilization, and 8,090–8,162 MiB VRAM use.

Rework is included: the original 16-round task failed acceptance; the first regression fixture exposed an optimistic wire-size estimate and passed after a 4,096-character safety margin; one real fixture wrapper was rejected before inference because `tsx` was not installed, then the same audited helper ran once through the installed `vite-node`. No inference retry was spent on the rejected wrapper.

## Ornith 1.5 9B gate and promotion

The production `LocalAdapter` also passed a cold-start acceptance after promotion: connecting an idle tab allocated no server; submitting one bounded task started Ornith through the normal admission lock and memory guard, then `read_file` and `edit_file` produced the requested file contents. Startup plus the accepted task took 6.866 seconds, with one authenticated server remaining. The admission envelope now recognizes pinned Ornith and uses the reviewed hybrid-attention KV geometry for the pinned 9B and 35B models, retaining buffer/desktop reserves and refusal for unknown weights or extra flags. Evidence: `artifacts/local-churn/ornith-native-start.json`.

Cold-start probe rework consumed no additional model inference: the initial wrapper checked process exit too early, then checked file acceptance immediately after `submit()` acknowledged the request. It now waits for process exit and a terminal session event. The single completed native-adapter turn passed.

The pinned Ornith 1.5 9B Q4_K_M file passed the bounded gate and was promoted on 2026-09-22. Its single acceptance completed in 2.014 seconds: the model emitted parsed `read_fixture` and `edit_fixture` tool calls, changed the bounded marker to `status=ORNITH_ACCEPTED`, and returned the exact final marker `EDIT_ACCEPTED`. Generation measured 96.1–96.6 tokens/s across the three requests; the uncached first prompt evaluated at 2,084.7 tokens/s. During the acceptance itself, the llama process used 5,049.3–5,382.1 MiB working set, GPU utilization reached 43–96%, and VRAM use was 8,143–8,185 MiB. Sanitized evidence is in `artifacts/local-churn/ornith-gate-acceptance-2026-09-22.json`.

The completed 180-second transition sampler (`artifacts/local-churn/ornith-gate-resources.json`) recorded 133 samples spanning Qwen shutdown, Ornith load and gate, promotion, and final residency. System CPU was 1.8–90.4% (9.8% mean), used RAM 19,879.8–30,119.5 MiB (25,093.4 MiB mean), GPU utilization 0–96% (0.7% mean), and VRAM use 2,093–8,188 MiB (7,793.9 MiB mean). The last approximately 14 seconds overlapped the full test suite, so the CPU peak represents combined load, not a model-only saturation measurement. Its run-record inventory was captured before the swap, so the recorded Qwen PIDs become unavailable after shutdown; only the sampler's system/GPU measurements and the gate's direct Ornith measurements are attributed here.
