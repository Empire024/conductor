import { resolve } from 'node:path'
import { build } from 'esbuild'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

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
