# t3code rank11: Threads keyboard selection (cloud, evidence + integration notes)

Cloud-produced slice, **not locally accepted**. GPT reviews and integrates; root owns full acceptance and install.

## Identity

| | |
|---|---|
| Branch | `claude/t3code-rank11-thread-keyboard-6v8ky7` |
| Remote base (rank9 export, verified equal to `origin/claude/t3code-rank9-thread-invalidations-0rrl14` and to this branch's origin tip before work) | `6daac8072609d35b7df589d92a2e1d07273af860` |
| CONTRACT commit | `0e8f54b0d60eca824763f464c8438243390e7db2` |
| IMPLEMENTATION commit | `84939005bdb83f3891b82c6a496a95dfc7111997` |
| EXPORT commit | the commit that adds this note and the patch (its SHA cannot be inside itself; `git log -1 -- docs/perf-evidence/t3code-rank11-thread-keyboard.md`) |

The local controller HEAD (`eaf9cc0…`, 177 commits ahead of `origin/main`) was not touched or consulted; nothing downstream was overwritten.

## CONTRACT baseline (separate commit, supplied sources only)

The rank9 base differs from the supplied current sources in two places, both baselined in `0e8f54b` and nothing else:

1. `ThreadList.tsx`: `useLayoutEffect` import, and `setQuery` / `setCollapsed` effects as `useLayoutEffect` (rest already byte-equal to the supplied file).
2. `sidebar-thread-view.ts`: **absent from the base** (rank9's ThreadList already imported it, so the rank9 base alone was missing a dependency). Added exactly as supplied.

Whole-project `tsc --noEmit` at the CONTRACT commit: clean (exit 0).

## Export

`docs/perf-evidence/t3code-rank11-thread-keyboard-integration.patch` = `git diff CONTRACT IMPLEMENTATION` restricted to:

- `src/renderer/src/components/ThreadList.tsx` (+10: import, optional `visible?: boolean`, one `useThreadKeyboard(...)` call)
- `src/renderer/src/components/thread-keyboard.ts` (new)
- `src/renderer/src/components/thread-keyboard.test.ts` (new, 110 tests)
- `src/renderer/src/components/thread-keyboard-integration.test.ts` (new, 22 tests)

Verified: applies with `git apply --check` onto a clean worktree of the CONTRACT commit and reproduces all four files byte-for-byte. No existing test, dependency, App, main, preload, shared or Sidebar file is touched.

## WIRING for the controller (Sidebar.tsx not edited here)

At the current `Sidebar.tsx` line 385, inside the `WorkspaceSidebarPanel` `workspace` prop, change

```tsx
{props.threads && <ThreadList projects={props.projects} {...props.threads} />}
```

to

```tsx
{props.threads && <ThreadList projects={props.projects} {...props.threads} visible={!props.collapsed && sidebarMode === 'workspace'} />}
```

`visible` is optional and **defaults to off**: until this line is applied the new code is inert, so applying the patch alone cannot change behaviour. Nothing else in `App`/`Sidebar` needs to change; `props.threads.onOpenThread` and `activeAgentSessionId` are already what the hook reads.

## Behaviour (as implemented)

- Alt+1..9: matches the produced `event.key` digit with Alt only (Ctrl/Meta/Shift rejected); picks the 1-based rendered row.
- Alt+Shift+`[` / `]`: matches physical `event.code` `BracketLeft` / `BracketRight` (the produced key is `{` / `}`); Ctrl/Meta rejected; cycles with wrap; absent/null/filtered active id → first (forward) / last (backward).
- Rows = `threadKeyboardRows({current, older, olderOpen, collapsed})`: `sidebarThreadView` current, then Older only while expanded, `[]` while Threads is collapsed. Computed from the same values `ThreadList` renders, so the current query (the view is the query result), rows below the scroll fold and omitted/hidden rows follow the DOM. Nothing expands Older or reads history.
- No targets: `visible` not true, Threads collapsed, no rows, thread context menu open (`menu !== null`), or a modal in the document (`dialog[open], [aria-modal="true"], .settings-scrim, .palette-backdrop, .thread-menu`).
- Rejected events: `defaultPrevented`, `repeat`, `isComposing`, `keyCode 229`, `getModifierState('AltGraph')`, and Ctrl+Alt (Windows AltGr). Rejected targets (target, ancestors, and `composedPath()` when present): input, textarea, select, `contenteditable` (`""`/`true`/`plaintext-only`/`isContentEditable`), `role=textbox`, Monaco (`.monaco-editor`), xterm (`.xterm`), `dialog`, `role=dialog|alertdialog`, `aria-modal=true`, `.thread-menu`.
- Same-active and out-of-range selections are silent no-ops. `preventDefault` + `stopPropagation` happen only for a valid changed target, then `props.onOpenThread(thread)` runs once. No native tab/layout mutation.
- One window **bubble** `keydown` listener per `ThreadList` mount (`useThreadKeyboard`: layout-effect registration, layout-effect state refresh each render, dispose on unmount). The listener reads the latest rows / active id / `visible` / callback on every key (no closure over stale state).
- Rapid presses: after a valid selection the chosen id is remembered as an optimistic "active" for up to 500 ms **only while** the active prop still equals what it was at dispatch and the row is still listed; a changed prop, an expired window or a vanished row drops it. So Alt+Shift+] ×3 before the app re-renders walks b, c, d instead of repeating b, and a repeated Alt+2 does not reopen the same thread. Limitation: if `onOpenThread` fails to change the active thread, an immediate second press within 500 ms treats the first target as active (self-heals after 500 ms).

## Tests

Command: `npx vitest run src/renderer/src/components/thread-keyboard.test.ts src/renderer/src/components/thread-keyboard-integration.test.ts` (node environment, no Electron/DOM).

- `thread-keyboard.test.ts`: exact modifiers, AltGr (state and Ctrl+Alt), shifted brackets by code, non-digit key on a Digit code, IME/229/repeat/prevented, editable targets, descendants and composedPath for every editor kind, dialog/menu/modal ownership, hidden/no-rows, out-of-range, same-active, wrap and absent-active both ways, callback once, consumption only after a valid changed target, listener count/cleanup, refreshed/reordered rows, replaced callback, active changes, rapid presses; `threadKeyboardRows` over the real `sidebarThreadView`.
- `thread-keyboard-integration.test.ts`: runs the **real `ThreadList` component function** (real `sidebarThreadView`, real `createThreadListRefresh`, real `useThreadKeyboard` / `registerThreadKeyboard` / `browserThreadKeyboardEnvironment`) on a minimal hooks runtime with stubbed `window` / `document` / `localStorage` (the repo has no jsdom or react client). It clicks the real Older toggle / search box / Threads toggle / row context menu through the rendered element tree's own handlers and asserts the keyboard opens exactly the rows the element tree renders, one listener, cleanup on unmount, query, collapse, `visible`, refreshed order, active changes and menu ownership.

### RED basis (baseline behaviour, not a missing import)

Before implementing, the two test files ran against a documented baseline-behaviour stub of `thread-keyboard.ts` (registers no listener, recognises no intent, offers no rows; **never committed**) and the unmodified contract `ThreadList.tsx`. Result: **63 failed | 69 passed (132)** (unit 45/110, integration 18/22 failing). Every failure is an `AssertionError` (e.g. `expected [] to deeply equal ['w1']`, `expected +0 to be 1` for the listener count); there were no import, reference or type errors. The 69 passing tests are the "must stay unconsumed" negatives, which a no-op trivially satisfies. A prior run's output is kept only in the cloud scratchpad.

### GREEN

- The two new files: **132 passed (132)**.
- Related existing files unmodified by this slice: `ThreadList.test.ts`, `thread-list-refresh.rank9.test.ts`, `Sidebar.test.ts`, `WorkspaceSidebarPanel.test.ts` → 6 files, **165 passed (165)** together with the new ones.
- `npx tsc --noEmit` on the IMPLEMENTATION commit: clean (exit 0, no output).
- `npx electron-vite build` (build only; no Electron launch): `✓ built in 44.89s`, exit 0.
- Mutation check (each applied to `thread-keyboard.ts` in turn, then reverted): Older always included, Shift allowed on digits, `stopPropagation` removed, bracket matched by key instead of code, optimistic target removed, consuming before the changed check, ignoring `menuOpen`, dropping the AltGraph check. Each makes 2–22 tests fail.

## Limitations / not done

- Not the full `npm test` suite, `test:scripts`, packaging or any smoke; remote claims are not local acceptance.
- The integration test drives `ThreadList` on a hand-rolled hooks runtime, not a real React reconciler/DOM, so it does not cover React batching of `onOpenThread`'s parent re-render or real focus behaviour. The 500 ms optimistic-active window is a heuristic for that gap.
- Sidebar wiring (`visible`) is not applied here; without it the feature is off.
- `.thread-menu` / `dialog[open]` / `[aria-modal]` selectors reuse existing app conventions; non-modal `role=dialog` popovers only block keys when focus is inside them.
- Unrelated stale-base failures: none observed (typecheck, build and the six related test files passed on this base after the CONTRACT baseline).
