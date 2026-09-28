# Web extraction: measured baseline and bounded next step

## Result

Keep the current public-HTTPS transport and add a source-preserving extraction result before considering a crawler or external service. A six-case deterministic diagnostic retained 6 of 8 expected facts. It lost the second article on a multi-article page and the publication date inside an article header. These are extraction defects in constructed fixtures, not measured live-web failure rates or model scores.

Command: `node --experimental-transform-types scripts/local-models/web-extraction-baseline.mjs`.
Evidence: `artifacts/verification/2026-09-28-web-extraction/baseline.json` (2026-09-28 08:41Z). The script retains fixture hashes and actual extracted text. It uses existing dependencies and starts no browser or model.

| Case | Expected facts retained | Observation |
| --- | --- | --- |
| Ordinary article | 1/1 | Navigation removed |
| Two-column table | 2/2 | Simple row/value associations retained; complex tables untested |
| Multiple article elements | 1/2 | First qualifying article selected; second lost |
| Publication date inside article header | 1/2 | Header removal loses the date |
| Target near end of 25,455-character page | 1/1 | Query-focused passage finds it |
| JavaScript shell | No facts expected | Empty result; script text correctly excluded |

## Existing implementation and reference

`src/main/local-models/web.ts` pins validated public DNS addresses, revalidates redirects, bounds decompressed responses to 4 MiB and fetches to 20 seconds. `pageText` strips page chrome, selects the first qualifying main/article element, and flattens tags. `readPublicWeb` returns at most 12,000 characters without focus, or query-selected passages. It exposes the final URL but does not retain a full-text handle, structured publication date or extraction provenance. Search has a separate cache; extracted page text does not.

Hermes separates search and extraction providers. Its documented extraction path keeps full text for paging, marks truncation, caches successful extracts, and offers browser tools when rendering is needed. Those are useful interface patterns, not evidence that a particular backend will solve Conductor's answer-quality failures. Sources checked 2026-09-28: [search and extraction](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search), [provider interface](https://hermes-agent.nousresearch.com/docs/developer-guide/web-search-provider-plugin).

## Proposed implementation contract

1. Keep search returning candidate URLs. Introduce an internal extraction result containing requested URL, final URL, fetched-at time, title, explicit publication/modified dates when present, extractor identifier, content hash, full cleaned text, truncation state and warnings. Never label fetch time as publication time. Preserve links, headings and table boundaries in the cleaned representation.
2. Return the existing bounded excerpt plus an opaque, session-scoped document handle and exact paging instruction. A cache hit must report its fetch time; a refresh option bypasses cache. Bound entries and total bytes, expire them, and prevent a handle from reading another session's data. Cache only successful complete extracts; mark a response cut at the transport limit as incomplete. An excerpt and its later pages must refer to the same content hash.
3. Diagnose low extraction coverage separately from no answer in the source. Missing dates, multiple articles, thin text and JavaScript shells become explicit warnings. Keep source content as untrusted data. Do not relax HTTPS, DNS, redirect, credential or response limits for fallback.
4. Compare the current extractor against an existing parser using the same saved public pages before building a custom crawler. Start with installed capabilities only. Evaluate six page shapes: article/date, documentation, multi-article listing, complex table, long-page fact, JavaScript shell. Score fact and date retention, source-link accuracy, boilerplate, truncation/paging consistency, failure clarity and elapsed time. Capture primary-source truth at fetch time. A third-party dependency, service or key requires a concrete choice before installation/use.
5. Add at most one measured fallback for supported poor-extraction cases. An existing browser may supply rendered content only within equivalent access boundaries; otherwise return a clear unsupported-page result. Do not silently send URLs to an external extraction vendor. Treat current-event answer selection, source freshness and unsupported claims as separate model-evaluation metrics.

## Acceptance and limits

The two lost facts above must survive the proposed extraction path without admitting script/navigation text. The existing table and focused-tail controls must still pass. Paging must recover omitted middle text with stable provenance; cross-session, expired and invalid handles must fail closed. Network boundary regressions must remain covered by the existing web tests.

No product extractor was changed, provider selected, software installed or live-model comparison performed by this diagnostic. This is a reproducible baseline and a proposed implementation scope, ready for independent review.

## Candidate check and independent review, 2026-09-28 10:01Z

The now-implemented scraper candidate retains **8/8 facts** on the same six synthetic fixtures. `node --experimental-transform-types scripts/local-models/web-extraction-baseline.mjs --assert` exits 0; it asserts missing facts, unwanted text and an exactly empty script shell. Table separators are normalized for fact comparison. Candidate evidence is `artifacts/verification/2026-09-28-web-extraction/candidate.json`; the original baseline remains intact.

Controller `agent_mul0uy09_0oxc7kc`, independent of the scraper implementer, reviewed the extraction/cache path and reproduced two issues in `.conductor-scratch/scraper-review-negatives.mjs`: a 300 KB JSON-LD array throws at an unbounded argument spread; a 490-character public support page with a contact-form CAPTCHA is falsely classified as a challenge. The actual challenge control is correctly refused. One bounded corrective round was requested. Source review and live acceptance remain open; this synthetic result is not a model-quality score.

Correction checkpoint, 10:06Z: **source checkpoint APPROVED** for those findings and conversation-scope wiring. Inspected the explicit queue budget and `tools.ts` passing the conversation's `taskId`; inspected the real `runTool` integration test (same-conversation cached continuation, other-conversation fresh public read). Re-ran the independent negatives: large array `open/724`, contact page `open/490`, actual challenge `challenge/20`. Supplied focused log `.conductor-scratch/local-scraper/vitest-4.log` confirms 95/95 tests in seven files. The implementer reports TypeScript exit 0. Live local-model acceptance, frozen ship snapshot and commit remain outstanding. The unrelated auto-selected source is a separately identified agent-path issue, not fixed by this scraper.
