import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalUpdateBuilder } from './local-update-build'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); vi.unstubAllEnvs() })

const checkout = (name: string, manifest: Record<string, unknown>, complete = true): string => {
  const root = mkdtempSync(join(tmpdir(), name))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest), 'utf8')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'build-local-update.mjs'), '// fixture\n', 'utf8')
  if (complete) { mkdirSync(join(root, 'node_modules', 'electron-builder'), { recursive: true }); writeFileSync(join(root, 'node_modules', 'electron-builder', 'cli.js'), '// fixture\n', 'utf8') }
  return root
}

describe('local update builds', () => {
  it('refuses any workspace that is not an installable Conductor checkout', () => {
    const builder = new LocalUpdateBuilder()
    const empty = mkdtempSync(join(tmpdir(), 'local-update-empty-'))
    roots.push(empty)
    expect(builder.unsupported(empty)).toMatch(process.platform === 'win32' ? /build-local-update\.mjs/ : /Windows/)
    if (process.platform !== 'win32') return // The remaining guards are only reachable where builds run.
    expect(builder.unsupported(checkout('local-update-foreign-', { name: 'some-other-app' }))).toMatch(/not the Conductor desktop app/)
    expect(builder.unsupported(checkout('local-update-bare-', { name: 'conductor-desktop' }, false))).toMatch(/electron-builder is not installed/)
    expect(builder.unsupported(checkout('local-update-ready-', { name: 'conductor-desktop' }))).toBeNull()
    // A refused workspace never reaches the point of spawning anything.
    expect(() => builder.start(empty)).toThrow()
    expect(builder.status().state).toBe('idle')
  })
  it("publishes a test instance’s build into the test profile’s feed, never the installed app’s", async () => {
    if (process.platform !== 'win32') return
    const root = checkout('local-update-feed-', { name: 'conductor-desktop' })
    writeFileSync(join(root, 'scripts', 'build-local-update.mjs'), "const at = process.argv.indexOf('--feed-dir'); console.log('Local update ready: 0.1.1-local.1'); console.log('Feed: ' + (at > 0 ? process.argv[at + 1] : 'owner feed'))\n", 'utf8')
    const feed = join(root, 'profile', 'local-updates')
    const builder = new LocalUpdateBuilder({ feedDirectory: () => feed })
    builder.start(root)
    await vi.waitFor(() => expect(builder.status().state).toBe('succeeded'), { timeout: 20_000 })
    expect(builder.status().feedDirectory).toBe(feed)
  })
})
