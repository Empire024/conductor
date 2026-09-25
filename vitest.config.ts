import { constants, getPriority, setPriority } from 'node:os'
import { defineConfig } from 'vitest/config'

// A test run is background work next to the owner's own Conductor (typing-lag-under-test-load,
// docs/perf/typing-under-load.md): it starts below normal priority, and so does everything it
// forks, so the owner's typing never waits on it. CONDUCTOR_BACKGROUND_PRIORITY=0 keeps normal.
if (process.env.CONDUCTOR_BACKGROUND_PRIORITY !== '0') {
  try { if (getPriority() < constants.priority.PRIORITY_BELOW_NORMAL) setPriority(constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* keep normal priority */ }
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Native SQLite/fsync fixtures contend badly on a Windows hosted runner's disk, which is far
    // slower than any developer machine. Fanning workers out less was not enough on its own: a
    // release run stalled four unrelated tests past 15s, one of them a purely in-memory journal
    // check that takes milliseconds here, which is starvation rather than four faults. A timeout
    // is not an assertion, so giving it real headroom hides nothing — a broken test still fails on
    // what it asserts, and only a genuinely slow one gets the extra room. Hooks get the same,
    // because it is the fixtures doing the fsyncing.
    // Locally, half the logical cores (one per physical core here): a worker per core left the
    // owner's typing sharing every core's second thread with a test fork (typing-lag-under-test-load).
    maxWorkers: process.env.CI ? 2 : '50%',
    testTimeout: process.env.CI ? 60_000 : 5_000,
    hookTimeout: process.env.CI ? 60_000 : 10_000
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@renderer': new URL('./src/renderer/src', import.meta.url).pathname
    }
  }
})
