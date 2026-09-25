import { resolve } from 'node:path'
import { constants, getPriority, setPriority } from 'node:os'
import { build } from 'esbuild'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// A build is background work next to the owner's own Conductor (typing-lag-under-test-load,
// docs/perf/typing-under-load.md): it starts below normal priority, and so does everything it
// forks, so the owner's typing never waits on it. CONDUCTOR_BACKGROUND_PRIORITY=0 keeps normal.
if (process.env.CONDUCTOR_BACKGROUND_PRIORITY !== '0') {
  try { if (getPriority() < constants.priority.PRIORITY_BELOW_NORMAL) setPriority(constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* keep normal priority */ }
}

/** The runtime host runs outside the app, from a copy under userData (docs/runtime-host.md), so
 *  it is bundled on its own into one self-contained CommonJS file with only node: imports. */
const runtimeHostBundle = (): Plugin => ({
  name: 'conductor-runtime-host',
  apply: 'build',
  async closeBundle() {
    await build({
      entryPoints: [resolve(__dirname, 'src/main/runtime-host/host-main.ts')],
      outfile: resolve(__dirname, 'out/main/runtime-host.js'),
      bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning'
    })
    // The recovery watchdog (docs/recovery-mode.md) runs the same way, from the same runtime copy.
    await build({
      entryPoints: [resolve(__dirname, 'src/main/recovery/watchdog-main.ts')],
      outfile: resolve(__dirname, 'out/main/recovery-watchdog.js'),
      bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning'
    })
  }
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), runtimeHostBundle()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
