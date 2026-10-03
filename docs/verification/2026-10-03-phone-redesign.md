# Phone control suite acceptance

Controller: agent_murrdn5k_umf5k4m. Design: [phone-redesign.md](../phone-redesign.md).

## Changes and causes

- Dictation previously assumed that exposing a Web Speech constructor meant a working service. Constructor/start failures, secure context, permission, microphone, network and service errors now have distinct explanations. Gesture start stays synchronous; delayed results cannot refill a sent or abandoned draft. Keyboard dictation remains available. Safari uses the Siri speech service; iOS standalone contexts may expose a constructor without a working service. Real microphone/service support still needs a physical phone check.
- Five persistent destinations, a Home history boundary, native Back and push/pop motion replace scattered navigation. Fragment-link popstate ordering is covered by a real browser smoke and a regression test.
- Project colours, explicit phases and recent activity ordering clarify which tab ran. New task uses the last successful choice or Claude Opus. The old quota ranking treated missing quota as fully available and avoided Opus, unintentionally favouring Grok.
- Desktop dark/light tokens, system/explicit themes, safe areas, 44px targets, 16px inputs and reduced motion apply across existing and new screens.
- Safe cold-start skeletons, bounded static cache fallback and immediate foreground refresh replace bare reconnecting. Sensitive cached state is restored only after a current auth/lock check confirms no configured lock; lock, unpair and 401 clear it.
- Optimistic messages distinguish Sending/Sent/Queued/Steered/Delivered. Ambiguous transport failures preserve drafts and require read-only Check status before another send. Stop no longer shares the send busy flag, calls local/remote interrupt with expedite=false, and reports held prompts.
- Usage reads the desktop's in-memory usage-limit reports and allowance history, with reset/freshness/unknown states. Usage and Activity refresh every 15 visible seconds.
- Activity materializes confirmed receipts into a small time-indexed table. Seven-day queries return at most 100 items. Legacy backfill advances through at most 32 indexed recent sessions and 256 resident projected items per session per request, with a single indexed journal lookup per receipt for its durable completion time. No global JSON/event scan. Sources include completed tools, resolved interactions, task transitions, delivered commits, production completion and actual installed-version startup. `activity.record` and `scripts/record-activity.mjs` provide an explicit post-success recording point; recording failure never retries the outward action.

## Real print-shop trace

The sender was the **Conductor** project, tab `agent_muotym22_xtjtam9`. The completed Bash item for `node haf-send.mjs mail-thanks-printspot.json --send` records SMTP acceptance at **2026-10-02T22:47:02.234Z**, sequence 14807, Message-ID `<1790981219647.51152865f0f5@hashandflowers.com>`. The projected item's initial timestamp was earlier; the collector uses the durable updated sequence instead. The real database was read only through bounded queries, never copied or modified. Proof: `.conductor-scratch/phone-redesign-activity-proof.json`. The existing scratch sender now invokes the tracked receipt helper after SENT; no email was sent during this work.

## Verification

- Focused phone/server/activity suite: 147 passed initially; subsequent local Stop and fragment-history regressions passed (45 tests across phone-access and phone-navigation). Runtime suite: 21 cases. Typecheck and production build passed.
- `record-activity.test.mjs`: 3 passed; registered in `test:scripts`.
- Sequential parked smokes passed: phone-shell, phone-images, phone-markdown-dictation, phone-lock, phone-access. Access smoke verifies actual provider interruption with a held queue, Usage contract and recorded answered-question linkage. Images smoke exercises WebKit and Chromium, including task/chat upload and Share Target.
- Screenshots and reports: `.conductor-scratch/phone-redesign/{shell,images,markdown-dictation,lock,access}/`. Actual served dark/light Home, New task, Usage, Activity and conversation captures are under `markdown-dictation/*-320.png`; no page overflow. Usage/Activity payloads and speech recognizer in that visual smoke are explicit fixtures. Real email trace is separate above.
- CSS fixture evidence: `.conductor-scratch/phone-a/layout-checks.json`, `final-checks.json`, dark/light captures; 12 small-screen scenes, six theme combinations, keyboard viewport and reduced-motion checks.
- Final delivery uses a scoped local `git.ship`, then exact-commit `app.update` with shell/images/markdown-dictation and mandatory background-window guard. The final controller report carries commit, full-suite result and verified version. No publish or install by this controller.

On physical iPhone Safari/Home Screen and Android Chrome PWA, try microphone permissions and Siri/service availability, edge Back/Home, sleep/wake reconnect, airplane mode recovery, send/steer/Stop during a slow turn, photo/share attachments, explicit theme, Usage resets and the Print Spot Activity link.
