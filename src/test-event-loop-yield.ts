import { afterEach } from 'vitest'

// Vitest setup file (vitest.config.ts). A worker reports each test to the main process over IPC
// and fails the whole file if a report goes unanswered for 60 s ("Timeout calling onTaskUpdate").
// Tests that run synchronous SQLite work over resolved promises chain through microtasks, so a long
// file never lets its event loop read the answer: agent-control.test.ts went 10.8 s without a loop
// turn alone and past 60 s under a full local suite's disk contention, where the expired timer
// fires before the waiting answer is read (docs/delivery-test-policy.md, "Local full suite").
// One real macrotask after each test bounds that stretch to a single test. Captured at load,
// before any test fakes timers, so a test that leaves fake timers on cannot stall this hook.
const realSetImmediate = setImmediate

afterEach(() => new Promise<void>(resolve => { realSetImmediate(resolve) }))
