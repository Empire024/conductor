---
id: verify
version: 1
title: Verify a delivered item against what the owner actually asked for, adversarially
trigger: [after:batch-delivery, manual]
inputs: [taskIds, commits]
steps:
  - id: plan
    role: verifier-architect
    model: claude:claude-fable-5-1   # brain: invents the scenarios; Astra when Codex has allowance
    alternate: codex:gpt-6-astra
    effort: high
    output: verification plan (≤40 scenarios) with expected outcomes, derived from the owner's item text and images, not from the implementer's tests
  - id: execute
    role: verifier
    model: claude:sonnet             # runs the real app, real models, real data; cheap hands
    effort: medium
    output: per-scenario PASS/FAIL with evidence (screenshot path, log path, measured numbers)
  - id: judge
    role: verifier-architect
    model: claude:claude-fable-5-1
    effort: high
    output: verdict per item — VERIFIED, or REOPEN with the failing scenario and evidence
locked: [steps.plan, steps.judge]
---

# Verify

The Verifier checks **what the owner asked for**, not what the implementer tested. "The unit tests pass" and
"it worked on a small sample" do not count as evidence here.

1. **Plan (brain).** Read the owner's original item text and any images or screenshots it links
   (`.conductor/prompt-images/…`), then the commits. Write scenarios that would break a shallow fix. Think outside
   the box:
   - **Scale:** 1 MB and 20 MB files, 10k-event conversations, 500 tasks, 50 tabs, a 30-minute run, a long overnight job.
   - **Open-ended and hostile input:** "what is the meaning of life?" to a coding agent, an empty prompt, 5 messages
     queued in one second, unicode and emoji, a Windows path with spaces, a CRLF file, a binary file, a file that does not exist.
   - **Real integration:** the real installed app, the real local model through its real sandbox, the real phone web app,
     a real restart or update in the middle of a turn, a second window, a detached tab.
   - **Resource edges:** GPU already busy, no local server running, provider at its usage limit, network off, disk slow.
   - **Visual:** the dashboard or panel compared against the owner's description or image, element by element.
   - **Regression neighbours:** the features next to the fix (e.g. queue merge next to steering, paging next to find).
2. **Execute (hands).** Run every scenario for real: parked smokes (`scripts/smoke-lock.mjs`, one at a time),
   `CONDUCTOR_TEST_USER_DATA` profiles, the local model on real prompts and real files, and the phone view through the
   browser tools. Record evidence: screenshot or log paths, numbers, exact outputs. Never mark a scenario PASS
   without evidence.
3. **Judge (brain).** For each item: VERIFIED when every scenario that matters passed, otherwise REOPEN. REOPEN
   puts the item back to `[ ]` with a short "Verifier 2026-MM-DD: <scenario> failed — <evidence path>" line under
   it, and routes it to the next batch. Write docs/verification/<date>-<batch>.md.

Budget: plan and judge are short brain turns; execution is Sonnet plus the local model. It follows the same caps as
`batch-delivery`.

## Run log
