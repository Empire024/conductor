# Agent control and live project edits

Conductor exposes a first-party internal JSON protocol over an ephemeral loopback HTTP port. This implements feature 17 without changing the provider MCP policy. The server belongs to the app; there are no per-tab MCP processes or third-party configuration changes.

Each native prompt receives a short briefing with the endpoint, a random per-conversation bearer credential, and `tools.list` discovery. Requests are `POST /control`, `Content-Type: application/json`, `Authorization: Bearer <credential>`, with a body of `{ "method": "tabs.list", "args": {} }`. Replies contain either `result` or `error`. Never print credentials in reports or blindly retry a mutation after a timeout. The briefing directs agents to use visible Conductor tabs when delegating to another provider.

The authority is the registered native conversation, its project, and its active workspace. An agent cannot substitute another project or workspace, operate on a hidden session, or control itself or any ancestor. Persistent parent relationships use the existing settings store, so busy collaboration logs cannot erase cycle protection. Collaboration handoff messages provide the audit trail. A human can release a relationship from the visible connection strip. Destructive tab closure and forgetting an agent memory require a native owner confirmation dialog; a request argument cannot grant approval. Human-authored memories cannot be forgotten or merged into by agent writes.

The endpoint binds only to `127.0.0.1`, checks its exact Host header, rejects browser Origin requests, accepts only authenticated JSON POSTs, limits bodies to 3 MiB, and serializes each caller's requests. Closing a workspace/tab revokes its authority; moving saved history to a different workspace rotates its credential. History moves preserve the native session ID and permission settings and cannot cross projects or steal a conversation still open elsewhere. App control is disabled entirely in the explicitly isolated live acceptance suite. Codex's existing third-party MCP isolation and Claude's configuration policy remain unchanged.

## Tool surface

`tools.list()` returns signatures on demand, avoiding a large repeated tool catalog in every prompt.

| Family | Methods and principal arguments |
| --- | --- |
| State and models | `app.state()`, `models.list()`: resolved project/workspace, scoped open tabs, persistent relationships, available native providers and per-model effort choices. Runtime-discovered catalogs take precedence over configured fallbacks; the source is explicit. |
| Tabs | `tabs.list()`, `tabs.open({kind?, provider?, model?, effort?, title?})`, `tabs.focus({tabId})`, `tabs.rename({tabId,title})`, `tabs.split({tabId,direction})`, `tabs.detach({tabId})`, `tabs.close({tabId})`. Open kinds include native agents, terminals, browser, file tree, tasks, memory, routines and logs; files use `files.open`. |
| Native agents | `agents.list()`, `agents.snapshot({agentSessionId})`, `agents.history({agentSessionId,afterSequence?})`, `agents.submit({agentSessionId,prompt})`, `agents.steer({agentSessionId,prompt})`, `agents.interrupt({agentSessionId})`, `agents.resume({agentSessionId})`, `agents.fork({agentSessionId,title?})`, `agents.release({agentSessionId})`. Native sessions own dispatch, approvals, streaming, steering and history. |
| Files | `files.list({query?})`, `files.read({path})`, `files.open({path})`, `files.write({path,content,expectedContent})`. Search reuses the indexed project search. Paths must remain inside the canonical project root, including junction targets. Text reads/writes are bounded to 1 MiB; writes use an exact previous-content comparison, with `null` for exclusive creation, and honor coworker edit leases. |
| Checklist | `tasks.list()`, `tasks.update({revision,id,status?,title?})`: updates feature-list.md through its existing optimistic revision API, keeps stable task markers and preserves other agents' active claims. |
| Memory | `memory.recall({query?})`, `memory.remember({gist,kind?,cues?})`, `memory.forget({id})`. New memories are always agent-authored; human memories remain separately owned. |
| Orchestration | `orchestration.snapshot()`, `orchestration.tasks.create({title,description?,priority?,status?,assignedAgentId?})`, `orchestration.tasks.update({id,...})`, `orchestration.routines.save({id?,name,description?,steps})`. Existing project-level stores validate all agent/task references. |
| Workspace | `workspace.rename({title})`. |
| Router | `router.start({prompt,provider?,model?})`, `router.dispatch({tasks:[{title,prompt,provider?,model?,effort?}]})`. A dispatch contains one to four independent assignments. |

Stable links use `conductor://<project>/tab/<encoded-tab-id>`, `/file/<encoded-path>`, or `/workspace/<encoded-workspace-id>`. Clicking a conversation link resolves its exact registered resource and focuses the correct main or detached window. It does not search filenames or use an external browser.

Read-only permission, a read-only execution sandbox, or planning mode blocks file/checklist writes and dispatch into writable conversations. Newly opened coworkers inherit the restriction: Codex uses its read-only sandbox; Claude uses its supported planning mode. Delegated turns retain the target conversation's existing settings and appear as normal user messages and native output in the visible tab.

## Router and real-time edits

The router is an `OrchestrationAgent` with role `conductor-router` and a persisted `RoutineDefinition` named `Conductor router`. Starting it creates a routine run and an in-progress task, opens a real native agent tab, and submits the user's work plus concise coordination instructions. The router reads the model catalog, chooses provider/model/effort for bounded tasks, and calls `router.dispatch`. Each coworker has a visible tab, native session, persistent orchestration agent/task, and a controller link. The assigned agents update completion through the same task API; dispatch failures mark their tasks blocked.

Feature 18 adds project directory watches plus immediate notifications from protocol writes. Directory watches survive atomic file replacements. Clean open editors adopt current disk bytes and retain their view position. Dirty editors preserve the owner's buffer and its original comparison baseline, show a conflict, and offer the existing save-copy/reload paths. The checklist refreshes from the same file-change notifications. Its periodic refresh remains a fallback.

## Validation

`src/main/agent-control.test.ts` covers project/workspace authorization, hidden/closed sessions, own/ancestor control denial, persisted links after more than 200 collaboration messages, owner confirmations, canonical path/junction escapes, competing file leases, stale writes, human memory ownership, task claims, plan/sandbox restrictions, history workspace relocation, credential rotation, request authentication/origins/size, isolated-live-test refusal, and a router run using the real stores and `StructuredSessions` with a synthetic provider boundary.

`scripts/smoke-agent-control.mjs` runs the real Electron main process, preload, renderer, loopback endpoint and router. By default its synthetic Claude source controls a visible Codex router and coworker. It checks native user/output events, persisted orchestration state, detached-window links and exact URI focus, live protocol/external atomic saves, dirty editor conflicts, and owner link release. Provider subprocesses are fixed offline fixtures; the test performs no model inference. Test-only captured briefing credentials are deleted on exit. Run after `npm.cmd run build`; the result is written to `artifacts/agent-control/report.json`.
