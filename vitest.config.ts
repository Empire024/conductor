import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Native SQLite/fsync fixtures contend on Windows hosted-runner disks.
    // Bound worker fan-out and allow disk latency; no retries or live budgets change.
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: process.env.CI ? 15_000 : 5_000
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@renderer': new URL('./src/renderer/src', import.meta.url).pathname
    }
  }
})
