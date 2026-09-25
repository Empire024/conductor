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
- **Tool calls needed the grammar enforced, until Conductor gave it its own template.** Measured
  2026-09-23 on llama.cpp b10901: the fine-tune writes `{"name": ..., "arguments": ...}` where the
  stock Llama 3.1 template renders `"parameters"`, and llama.cpp derives its tool-call parser from
  that rendering, so under `tool_choice: auto` the server gave up after the trigger and handed
  the client a call whose arguments are the single character `{` (the log says
  `common_chat_peg_parse: unparsed peg-native output`). Under `tool_choice: required` the same
  model produces complete, valid calls every time. Since 2026-09-25 Conductor starts Dolphin with
  its own template (below), which renders calls as `"arguments"`, and the server parses them; the
  loop still re-asks once with the grammar enforced whenever a non-truncated call arrives
  unreadable, and ends the turn if stubs keep coming (see `src/main/local-models/agent.ts`).
  Speed observed: about 96 tokens/s generation, 1,200 tokens/s prompt evaluation, with the q8_0
  KV cache.
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

## Useful like any other model (2026-09-25)

The owner's verdict after a few days of use was "was useless... i want it to be able to answer
questions, scour internet etc just like any other model". Measured on a fixed owner-style set
(`scripts/local-models/questions.json`: three plain knowledge questions, two current facts, two
"find X online and summarize with sources", one follow-up that depends on the previous answer,
one harmless question a censoring model refuses), graded by
`scripts/local-models/question-set.mjs`. Plain and uncensored questions must be answered with no
tool call; current ones need a search and a cited link; research needs a search, a page read and a
cited link; every answer must contain the expected facts. The grader checks words, not judgement,
so the answers below were also read.

### What was wrong: 0 of 9

Before the changes every question failed (`artifacts/local-questions/local-dolphin-x1-8b-1790364930472.json`):
plain questions became `run_command` calls printing the answer from Python, "latest Python" was
answered "3.11.2 (October 2022)", and research turned into `web_read` of invented Google URLs.
The causes, in order of weight:

1. **The stock template demanded a tool call.** Llama 3.1's template puts the tool list in the
   *first user message* under "Given the following functions, please respond with a JSON for a
   function call ... that best answers the given prompt", and adds "Environment: ipython", which
   puts Llama 3.1 in code-interpreter mode. Dolphin did exactly that.
2. **It was told it was July 2024.** The template's `date_string` defaults to "26 Jul 2024" and
   Conductor never set it, so "latest" meant 2024 and nothing suggested searching.
3. **No search tool.** `web_search` existed only behind the per-conversation deep-research grant,
   so the model built search-engine URLs for `web_read`.
4. **The search engine refused us.** DuckDuckGo lite, the only engine, answers a burst of queries
   from this machine with its HTTP 202 bot page for many minutes (measured: 202 for 30+ minutes
   after about a dozen searches; two queries passed after a minute of rest, then 202 again).
5. **Pages came back as script.** A 256 KiB cut kept only the `<head>` of modern pages (Tom's
   Hardware's review is 2.1 MB, the article starts 1.36 MB in), gzip bodies arrived as bytes, and
   attribute JSON on Hugging Face leaked in as text.

### What changed

- **Conductor's own template for Dolphin** (`DOLPHIN_TEMPLATE`, `src/main/local-models/templates.ts`,
  started with `--chat-template-file` from `llama.ts`; an owner's `extraArgs` still may not name
  one): tools in the system message, offered ("call one only when you need it; otherwise answer
  directly"), no "Environment: ipython", and calls rendered as `"arguments"`, which is what the
  fine-tune writes. llama.cpp derives its tool-call parser from the template, so the stub calls
  are gone too (from dozens of `unparsed peg-native output` lines per run to none from tool calls).
- **Every local request carries `chat_template_kwargs`**: today's `date_string` and
  `tools_in_user_message: false` (ignored by templates that do not use them), and the system
  prompt states today's date and when to search: general knowledge answered directly with no
  tool; anything that may have changed, or that the owner asks to find online, searched and cited;
  primary sources preferred over shops and forks.
- **A message that asks for current or online facts** (`wantsWeb`, words such as latest, current,
  news, price, reviews, online, look up, find) carries a one-line hint and its first round offers
  only the web tools with `tool_choice: required`. llama.cpp b10901 does not hold Dolphin to
  `required` every time (2 of 8 probes still wrote prose until the output limit), so that round's
  text is kept out of the answer, and if no web call came back Conductor runs `web_search` itself
  with the owner's words (`searchQuery`). A turn that searched but read nothing gets one nudge to
  open a result; a page already read is not fetched again in the same message; an answer that
  names no link gets the pages it read appended as "Sources:".
- **Search engines**: DuckDuckGo lite first (with dated snippets), Seznam (a Czech engine with
  global results that answers plain requests from Node) when DuckDuckGo throttles, Wikipedia's
  search API last. A throttling engine is left alone for two minutes, searches are spaced 1.5 s
  apart, the same query is answered from a ten-minute cache (a failed one for two minutes), and
  hits that share too few of the query's words are dropped so a page of unrelated shop links
  counts as no result. Measured and rejected: Brave (429 to Node's TLS while it serves curl;
  Conductor does not disguise its client), Bing (empty page), Mojeek and Startpage (JavaScript
  challenge), Yahoo, AOL, Ask, Dogpile, Qwant, Ecosia (refused), Mwmbl (too few relevant results).
- **Pages**: up to 4 MiB read and cut rather than refused, gzip/brotli/deflate decoded with the
  limit on decoded bytes, the `<article>`/`<main>` text preferred, scripts, styles, navigation and
  quoted attributes stripped, 12,000 characters returned (two or three pages fit the 32k window).

### Decision: web tools for every local conversation, with a budget

`web_search` is now offered to every full-scope local conversation, without the owner toggling
anything; bounded coding tasks and file-processing runs still get no web tools. The safety bound:

- **No new channel.** `web_read` has been offered to every conversation from the start, and a URL
  carries data out exactly as a query does; `web_search` goes through the same pinned,
  credential-free, cookie-less GET broker (public HTTPS on port 443 only, DNS checked and pinned
  across redirects, no request bodies, the shell still without network). Only the query text and
  the URL leave the machine, and the prompt says never to put workspace content in either.
- **Eight web calls per owner message** (`WEB_CALLS_PER_MESSAGE`, enforced at dispatch): room for a
  search or two and the pages that answer it. The deep-research grant (`localResearch`) lifts the
  per-message budget, asks for a wider search and raises the round budget from 16 to 48.
- Everything read back is marked untrusted page data, as before.

### Results

Parked Conductor runs (`node scripts/smoke-lock.mjs -- node scripts/smoke-local-questions.mjs --provider local --model local/dolphin-x1-8b`;
fresh profile, no grant turned on, questions 20 s apart as a person would ask them, each conversation
its own tab). Answers, grades and every tab's full transcript are in the run folder under
`artifacts/local-questions/`.

| | Dolphin before | Dolphin now | Ornith 1.5 9B | Claude Sonnet (frontier) |
| --- | --- | --- | --- | --- |
| Run | direct probe, `local-dolphin-x1-8b-1790364930472.json` | `parked-2026-09-25T21-34-29-616Z-local-local_dolphin-x1-8b` | `parked-2026-09-25T21-38-56-699Z-local-local_ornith1.5-9b` | `parked-2026-09-25T21-13-10-549Z-claude-sonnet` |
| Grader | 0 / 9 | 9 / 9 | 9 / 9 | 7 / 9 (both misses are the grader's shape: Q5 used `gh api` instead of a web search, Q6 answered from search content without opening a page; both answers are right) |
| Q1-Q3 plain | Python via run_command | direct, correct, ~4 s | direct, correct, 4-8 s | direct, correct, 5-10 s |
| Q4 latest Python | "3.11.2 (2022)" | 3.14.7, 5 Aug 2026, python.org, 33 s | 3.14.7, 3.15 due 1 Oct, python.org, 7 s | 3.14.7, 3.15 rc noted, three sources, 21 s |
| Q8 follow-up | 3.11 features | 3.14: deferred annotations, t-strings, subinterpreters (docs.python.org) | t-strings, explained (docs.python.org) | free-threading and PEP 649 |
| Q5 newest llama.cpp | invented GitHub URLs | b11191, 25 Sep 2026 (releases page) | b11191 | v0.5.0 (latest non-prerelease, 23 Sep) and b11146 nightly |
| Q6 RTX 5070 reviews | stagnation, no answer | one review read (Tom's Hardware): mixed, pricing and 12 GB concerns | five outlets read, per-source summary | review roundup with per-claim links |
| Q7 Dolphin X1 8B | "a product" | dphn, Llama 3.1 8B Instruct, uncensored by fine-tune (model card) | dphn, fine-tune of Llama 3.1 8B Instruct (model card) | dphn, Llama 3.1 8B Instruct, Hartford, card link |
| Q9 lock picking | run_command loop | answered | answered | answered, with the locksmith / bolt-cutter alternatives |

Every Dolphin answer in the final run is a single answer with its source; plain answers take about
4 s including the tab's first request, web answers 6-33 s (the long ones waited for a throttled
engine or read a 2 MB page).

### The remaining gap, honestly

- **Depth of research.** Dolphin reads one page (two at most) and summarizes it; Ornith reads
  six for the same review question and Sonnet cites a source per claim. "Scour the internet" is
  still Ornith's or a frontier model's job; Dolphin gives a correct, sourced short answer.
- **Choice of source.** Dolphin takes the first plausible result. With Seznam serving (DuckDuckGo
  throttled) it has picked a release page for the wrong Python version and, before the "primary
  sources" line, a fork's README for llama.cpp. The grader cannot see this; the answers were read.
- **Answer quality.** Plain answers are correct but generic and sometimes loose (225 g for a cup
  of butter where 227 g is usual); Ornith and Sonnet are tighter and better organized.
- **It needs Conductor's scaffolding.** Before the forced first web round was made to hold, Dolphin
  answered Q6 and Q7 of an app run with an invented "review roundup" and a made-up product; with it, Conductor searches for it
  whenever it writes prose instead. A question the cue words miss (`wantsWeb`) gets no such help,
  and Dolphin then answers from 2023 memory; the date in the prompt is the only guard.
- **Search reliability is the weakest link for every local model.** DuckDuckGo throttles this
  machine after a burst; Seznam's ranking favours Czech shops for product queries and knows little
  about niche topics. A keyed search API (Brave Search API, free tier) would fix both and needs a
  key only the owner can create; it is not wired in.
- **Speed.** A Dolphin web answer is 6-33 s against Sonnet's 13-38 s: comparable, and entirely
  local apart from the query and page fetches.
