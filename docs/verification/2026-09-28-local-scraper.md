# Local research scraper: Instagram failure and source-preserving extraction, 2026-09-28

Implementer `agent_mul0ptgr_w331pvo` (Claude Opus); controller `agent_mukzx5d8_3g3mild`, succeeded by `agent_mul0uy09_0oxc7kc`. Task `task_mul0pu6e_9934kcn`. Claude quota at start: 5-hour 0%, weekly 0% (this session's own report, 09:01:45Z).

**Status: implemented with focused tests. The controller's independent review asked for one correction, which is now applied; its re-check is pending. Live acceptance has NOT been run.** No build, Electron launch, local model, git.ship, publish or update ran. The scope is the scraper only. Nothing from the idea's marketing or business plan was carried out.

## Actual failure evidence

Idea `idea_mugx6gkj_dpiqsfm`, job `job_muia5ofo_6n4atg5`, stage conversation `agent_muia5ogs_02iqkwy` on `local/ornith1.5-9b` (2026-09-26). The tool calls were read from `structured_events` in a read-only database session (`.conductor-scratch/local-scraper/read-stage.mjs`, output `stage-events.json`):

| Seq | Call | Result |
| --- | --- | --- |
| 8–11, 15–16 | `web_search` ×3 (Seznam; " September 2026" appended to each query) | Lego and eBay mask listings, plus an unrelated Netflix "LEGO One Piece" article |
| 13–14 | `web_read https://www.instagram.com/wearlegohead/` | **failed** in 1,039 ms: "www.instagram.com sent no readable text for a plain request (the page is probably drawn by script)" |
| 20–23 | Conductor notice: "The model answered from search results without opening a page; Conductor opened the best 2 results" | It opened the Netflix article, and the brief cited it as its only source |
| 24–29 | auto-opened eBay pages | `Research HTTP 403` ×2 |

The brief then asked the owner for screenshots and described the page as "script-rendered and inaccessible".

## Diagnosis of the public URL

I sent one read-only GET with the product's own headers (`Conductor-Local-Research/1`, no cookies, no credentials) using `.conductor-scratch/local-scraper/probe-instagram.mjs`, around 09:10Z on 2026-09-28. The response was **HTTP 200**, `text/html`, 740,855 bytes, with no redirect and no sign-in markers. The body is sha256 `604f2d7e…484f` and is saved as `instagram-body.html` in the same folder.

- `<head>` states the profile: og:title `LegoHeads™ (@wearlegohead) • Instagram photos and videos`. The description reads `32K Followers, 0 Following, 21 Posts … "The ski mask everyone asks about. … Choose your face. Hit the slopes. … Get yours here. legohead.co"`.
- The response embeds the signed-out post list in `application/json` blocks (`PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery`). It holds 12 posts, each with a code, Instagram's dated accessibility caption and the caption text.
- The old `pageText` deleted `<head>` and all scripts, which leaves **0 characters**. That is why the page failed. An offline replay of the saved body through the verbatim old logic reproduces it (`replay-instagram.mjs`).

So the page did not refuse access. The extractor threw away the facts it had been sent. The unrelated citation is a separate defect in `agent.ts`, covered under follow-up below.

## What changed

`src/main/local-models/web-extract.ts` (new, pure) and `src/main/local-models/web.ts`:

1. **Source record.** `extractPage` returns requested URL, final URL, fetch time, extractor id (`conductor-html/2`), access class, metadata and text source. It also returns the full cleaned text, a sha256 of the content, a transport-cut flag and warnings.
2. **Metadata.** The record keeps the title, the fullest description (og, name or JSON-LD) and the canonical link. Published and modified dates come only from the page itself: `article:*` meta, JSON-LD, `<time pubdate|itemprop>`, or the first `<time>` in an article's own header. Fetch time is never used as a publication date, and a value that is not a date is dropped. `web_read` prints `Title:`, `Published: … (as the page states it)`, `Updated:`, `Author:` and `Description (the page's own summary):` lines.
3. **Text.** Every `<article>` is kept in order, and an article's own `<header>` (title and date) is kept too. Headings are marked `#`, and table cells are separated by ` | ` with one row per line. `<title>`, scripts, navigation and forms are still excluded.
4. **Pages drawn by script.** The fallbacks run in this order:
   - JSON-LD `articleBody`.
   - A bounded Instagram reader of the post list the response already carries: 64 blocks of at most 1 MiB, 20,000 nodes and 50 posts, with a link per post. It makes no API call, never signs in and downloads no media.
   - The page metadata alone, labelled "anything not stated here is unknown from this page, not absent".
5. **Access refusals.**
   - **Sign-in page:** a redirect to a sign-in path, or a short page with a password field, is refused as "access refused, not evidence the content is absent; do not stand another page about something else in for it".
   - **Bot check:** Cloudflare, reCAPTCHA or hCaptcha markers on a short page are refused the same way. Nothing tries to solve them.
   - **HTTP refusal:** 401, 403, 407, 429, 451 and 999 now say the host refused a plain credential-free request. The `Research HTTP <code>` prefix is unchanged, so search throttling detection still matches.
   - **Empty page:** a page with neither text nor metadata still fails, and now says this says nothing about whether the fact exists.
6. **Paging.** Text is split into pages of up to 12,000 characters, breaking at a line in the last fifth where possible. A longer page ends with the exact next call: `web_read url="<final URL>#conductor-page=2&sha=<12 hex>"`. The fragment never reaches the server, and `agent.ts`'s duplicate-read guard treats each page as a distinct link. A read focused on the question offers `#conductor-page=1…`, so the passages it left out can still be read in order. Continuation copies are kept per scope for at most 15 minutes, 32 entries and 8 Mi characters, and a cut response is never kept. A miss, another scope or an expired copy reads the public page again, and that read must hash the same. A changed page, a malformed link or a page number out of range fails with the exact recovery call.
7. The transport is unchanged: HTTPS on port 443 only, no credentials, DNS validated and pinned on every redirect hop, at most three redirects, 4 MiB of decompressed body and 20 seconds.

On the saved Instagram response the new path yields `site-data` with 12 posts (3,122 characters, content sha256 `a7525eb3…ed8f`) plus the title and bio lines (`instagram-extract.json`).

## Scope wiring (approved expansion)

`src/main/local-models/tools.ts` now passes `{ scope: context.taskId ?? '' }` to `readPublicWeb`. In production `context.taskId` is the conversation's id: `structured-sessions.ts:341` sets `localTaskId: id`, and `providers/local.ts:341` and `agent.ts:1541` pass it on, with a per-session UUID fallback at `agent.ts:751`. `agent.ts` is unchanged.

The integration test in `src/main/local-models/tools.test.ts` runs the real `runTool('web_read')` → `readPublicWeb` path with DNS and HTTPS faked. It checks that one conversation's continuation is served from its own copy with no second request, and that another conversation's continuation reads the public page again.

## Independent review correction (controller review, 2026-09-28)

The controller's review found two defects, reproduced by `.conductor-scratch/scraper-review-negatives.mjs`:

1. **Stack overflow on a large JSON-LD array.** A valid 150,000-item JSON-LD array threw "Maximum call stack size exceeded" at `queue.push(...item)`, and the 200-node bound only counted nodes as they were read. Now a node budget is counted when a node is queued, and it is shared across blocks: 400 nodes for JSON-LD, and 20,000 for the Instagram reader, which previously had no bound on queuing. Untrusted arrays are never spread into a call.
2. **Captcha widget read as a bot check.** A 490-character support page with reCAPTCHA in its contact form was classified as a challenge. A challenge now needs positive interstitial evidence: the interstitial's own wording ("Just a moment...", "Verify you are human", …), or block-page markup (`cf-chl-`, `captcha-delivery.com`, `px-captcha`) on a page with under 200 characters of its own text. A reCAPTCHA or hCaptcha widget alone does not count, and neither does Cloudflare's `challenge-platform` script, which it also injects into ordinary pages.

After the fix, the reproducer gives `open` (724 chars), `open` (490 chars) and `challenge` (20 chars). The new tests cover:

- the 150,000-item arrays, both in JSON-LD and ahead of Instagram posts;
- a date placed past the node bound, which is not reached;
- the 50-post cap;
- the support page, the Cloudflare-script page and bare captcha widgets, all `open`;
- Cloudflare, DataDome and wording-only challenges, all `challenge`.

The saved real Instagram response still extracts to the same 12 posts (content sha256 `a7525eb33a29…`, unchanged).

**Residual risk (not changed):** a page under 1,500 characters with a password field is still classified as a sign-in wall. A short page with a login box in its sidebar would be refused.

## Tests (focused, injected; no network)

`npx vitest run` on tools, web-extract, web, harness, web-answers, fx44-dates and agent-management: **7 files, 95 tests passed** (`vitest-4.log`). `npx tsc --noEmit`: exit 0, no errors (`tsc-4.log`).

**Regression and controls:**

- **Instagram:** the reduced signed-out profile yields the posts, the fuller description and the title. Script text is not admitted, no cookie header is sent, and the reader ignores other hosts.
- **Sign-in and refusals:** a redirect to `/accounts/login/` fails as a sign-in wall. A bot check and a 403 fail as access refused, and a 404 message is unchanged.
- **The two baseline losses:** the second article and the date in an article's header are now retained. The navigation-free article, table rows, empty script shell and focused page controls are kept.
- **Paging:** pages cover the text exactly, a focused read's omitted passage can be recovered from page 1, and the continuation is served from the first read's copy with a single request. Another scope reads the page again and must hash the same. An expired or changed page is refused, as are malformed and out-of-range links.
- **Unchanged transport tests:** pinned DNS, private-address redirects, decompression, oversized pages and cancellation.

The controller reports that the updated baseline (`scripts/local-models/web-extraction-baseline.mjs --assert`, not owned here) now passes 8/8 facts plus an exact empty-shell check.

## Not done, and dependencies for the controller

- **Per-conversation scope:** done, see Scope wiring above.
- **Unrelated page stood in (substitute-source defect; `agent.ts` not edited, fix needs separate approval).** The boundary is the automatic read at `agent.ts:1245–1255`. When a turn has searched but opened no page (`readDue()`) and the model answers or keeps searching, Conductor calls `pickPages(ledger.searchHits, instruction, skip, n)`. It then replaces the model's reply with `web_read` calls for those hits.
  - `pickPages` (`agent.ts:539–578`) ranks search hits by how many question words they share, their rank and their date. It has no link to the URL the owner actually named, and no minimum relevance. The idea prompt is several hundred words long, so "LEGO" plus "September 2026" was enough to put the Netflix article on top.
  - A failed read of the owner's own URL is only put into `skip`. Nothing stops a search hit being opened in its place.

  **Smallest proposed fix:** in the condition at `agent.ts:1245`, do not open search hits in place of a failed page. When the instruction names https URLs and every one of them is in `ledger.readFailed`, let the model's answer stand (or its failure note), and emit a notice that the named page could not be read.

  Test: an instruction naming `https://www.instagram.com/wearlegohead/` whose `web_read` fails, plus search hits about Netflix LEGO. Expect no `conductor-read-*` calls, and a final answer that neither cites nor adds the hit.

  A minimum-relevance rule in `pickPages` alone would not have caught this case, because of the long prompt.
- **Substitute-source guard: implemented (allocated by `agent_mul36oi2_t90a5gk`).** In `agent.ts`, `namedPagesUnread` matches the URLs a message names against pages that failed to read, by host without `www` plus path without its trailing slash; scheme, query and fragment are ignored. The query has to be ignored because the trace read the link without `?stkn=`. When every named URL failed and none was read, the automatic read opens no search hit, the model's own text stands, and one notice says the page could not be read. `web-answers.test.ts` covers the trace shape and two controls: no named URL, and a named URL that did read. Both controls still get the automatic read. Result: 8 files, 120 tests passed (`.conductor-scratch/local-assist/2026-09-28T10-20-35-885Z-b3e73e.log`), and `tsc` exits 0 (`…10-20-45-902Z-138d40.log`).
- **The appended " September 2026"** on non-current queries also belongs to the agent path, not the scraper.
- **Rendered-browser fallback: not built.** Chromium resolves DNS itself, so a rendered read cannot keep the pinned-address boundary without new integration work. The static response already carried the Instagram content that was needed. If the fallback is wanted, it needs a design that routes browser traffic through equivalent checks.
- **Live acceptance: run after review, 2026-09-28 15:53Z**; see the section below. Before that, a web_read of the real URL through a local model was waiting on the controller's slot and an independent review of this diff. Page layout on Instagram's side can change, and the metadata-only fallback and the explicit refusals are what remain if it does.

## Live model check after review, 2026-09-28 15:53Z

Requested by wizard `agent_mulf9gp4_awcbpcc` after the review approval. Quota at the start: Claude 5-hour 19%, weekly 8%.

**Setup:**
- **Model server:** `local.servers` showed one server, `local/dolphin-x1-8b` (pid 39632, port 51438, started by Conductor, no turn in flight). I used it as it was. No server was started, stopped or swapped, nothing was downloaded, and there was no Electron launch or build.
- **Script:** `.conductor-scratch/local-scraper/live-check.mts`.
- **Extractors:** "old" is HEAD's `web.ts`, exported to `web-old.ts`; "new" is the working tree. Each reads the same real public page through the product's credential-free broker.
- **Model call:** each result goes to the model once, with the same question, as a `web_read output` block: temperature 0, at most 200 tokens. The API key is read in memory through `readApiKey()` and never printed.
- **Ground truth** comes from each page's own response: Instagram's og:description, python.org's decompressed page ("Download Python 3.14.7", which is also the first release row), the article's `article:published_time` and body text, and the Wikipedia infobox.

**Grading was done twice:**
- **Literal pass:** a fixed substring per fact.
- **Equivalent-forms pass:** `regrade.mjs`, on the saved answers, with no new model or network call. It accepts "32K" or "32,000", "mask" together with "ski", and "April 7, 2026" for `2026-04-07`. These forms were declared after the literal pass rejected correct paraphrases, so both passes are reported.

Evidence files: `live-check.log`, `live-check.json` and `live-check-graded.json` in `.conductor-scratch/local-scraper/`.

| Page | Old: read / answer (prompt tokens) | New: read / answer (prompt tokens) |
| --- | --- | --- |
| instagram.com/wearlegohead/ | **read failed** ("sent no readable text"); "does not provide" ✗ (113) | read OK; "approximately 32,000 followers … a face mask, likely for skiing" ✓ (1,281) |
| python.org/downloads/ | read OK; "Python 3.15, a pre-release" ✗ (5,195) | read OK; same wrong answer ✗ (5,292) |
| whats-on-netflix LEGO One Piece article | "September 29, 2026"; publication "not explicitly stated" ✗ (796) | "September 29, 2026"; "published on April 7, 2026" ✓ (1,226) |
| en.wikipedia.org/wiki/Python_(programming_language) | "Guido van Rossum … 1991" ✓ (3,181) | same ✓ (3,860) |

**Totals:**
- **Old extractor:** 1/4 correct with equivalent forms (1/4 literal), 1 read failure, 9,285 prompt tokens, 3.7 s of model time.
- **New extractor:** 3/4 correct with equivalent forms (1/4 literal), 0 read failures, 11,659 prompt tokens (+25.6%), 4.3 s of model time.

The extra tokens come from content the old path lost: Instagram's metadata and post list (the old path sent only an error), and the news article's Title and Published lines. On Wikipedia, the heading markers and ` | ` table separators add 679 prompt tokens for about the same number of characters.

**The Python miss is a model error, not an extraction loss.** An offline check on the saved page shows both extractions put "3.14.7" on the first page (at about 850 characters), after a release-table row that says "3.15 prerelease" (at about 330 characters). Dolphin picked the pre-release in both runs.

**Also run for this check (run_and_summarize):**
- vitest on `tools.test.ts`, `web.test.ts`, `web-answers.test.ts` and `web-extract.test.ts`: 4 files, **55/55 passed** (`.conductor-scratch/local-assist/2026-09-28T15-54-15-815Z-bdb588.log`).
- `npm run typecheck` (`tsc --noEmit`; the repo has no `tsconfig.node.json`): **exit 0** (`…15-54-18-235Z-e5a18e.log`).
- `scripts/local-models/web-extraction-baseline.mjs --assert`: **8/8 facts**, exact empty shell, exit 0 (`…15-54-30-197Z-7f3c86.log`). It wrote only `artifacts/verification/2026-09-28-web-extraction/candidate.json`, and `baseline.json` was left untouched.

**Verdict: PASS** for the scraper's purpose. The page from the original failure is now read and answered correctly. The article's publication date now reaches the model, where the old path lost it. There are no new read failures or extraction regressions on the controls.

**Limits:**
- Four pages, one model, one run each. This is not a model-quality ranking.
- Real public pages were fetched about 13 times in total: truth fetches, two reads per page, and one python.org re-fetch to establish the truth after my truth fetch saw gzip bytes.
