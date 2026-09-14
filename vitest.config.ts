import { defineConfig } from 'vitest/config'

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
    maxWorkers: process.env.CI ? 2 : undefined,
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
