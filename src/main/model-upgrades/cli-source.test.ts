import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LATEST_MODELS_BUILTIN } from '../schedule-builtins/latest-models'
import { CliVersionStore } from '../cli-versions'
import { findPackagedExecutable, installScratchCli, latestVersion, probeCatalog, pruneScratch } from './cli-source'

const FAKE_NPM = resolve('scripts/fixtures/fake-npm.mjs')
const SCRIPT = LATEST_MODELS_BUILTIN.scripts.find(script => script.name === 'cli-catalogs')!.content

describe('cli-source', () => {
  let directory: string, server: Server, registry: string, catalogs: string
  const requests: string[] = []
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'model-upgrade-cli-'))
    catalogs = join(directory, 'catalogs.json')
    writeFileSync(catalogs, JSON.stringify({
      codex: { '0.160.0': [{ id: 'gpt-7-astra', displayName: 'GPT-7-Astra', isDefault: true }, { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', upgrade: 'gpt-7-astra' }] },
      claude: { '2.2.0': [{ id: 'default', displayName: 'Default' }, { id: 'claude-opus-5-6', displayName: 'Claude Opus 5.6', isDefault: false }] }
    }))
    server = createServer((request, response) => {
      requests.push(request.url ?? '')
      if (request.url === '/@openai%2fcodex/latest') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ name: '@openai/codex', version: '0.160.0' })); return }
      response.writeHead(404); response.end('{}')
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }) })

  it('reads the latest dist-tag from the registry and names a missing package', async () => {
    expect(await latestVersion('@openai/codex', registry)).toBe('0.160.0')
    expect(requests).toContain('/@openai%2fcodex/latest')
    await expect(latestVersion('@anthropic-ai/claude-code', registry)).rejects.toThrow(/HTTP 404/)
  })

  it('installs into a scratch prefix, verifies the version, reuses it, and leaves nothing behind on failure', async () => {
    const root = join(directory, 'scratch')
    const log = join(directory, 'npm.log')
    const environment = { ...process.env, CONDUCTOR_MODEL_UPGRADE_NPM: FAKE_NPM, CONDUCTOR_FAKE_NPM_LOG: log, CONDUCTOR_FAKE_CLI_CATALOGS: catalogs }
    const installed = await installScratchCli(root, 'codex', '0.160.0', { registry, environment })
    expect(installed.prefix).toBe(join(root, 'codex', '0.160.0'))
    expect(existsSync(installed.executable)).toBe(true)
    const args = JSON.parse(readFileSync(log, 'utf8').trim()) as string[]
    expect(args).toEqual(expect.arrayContaining(['install', '--prefix', `--registry=${registry}`, '@openai/codex@0.160.0']))
    expect(args).not.toContain('-g')
    await installScratchCli(root, 'codex', '0.160.0', { registry, environment })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)

    await expect(installScratchCli(root, 'claude', '2.2.0', { registry, environment: { ...environment, CONDUCTOR_FAKE_NPM_FAIL: '1' } })).rejects.toThrow(/npm install @anthropic-ai\/claude-code@2.2.0 failed.*E404/)
    expect(existsSync(join(root, 'claude'))).toBe(true)
    expect(existsSync(join(root, 'claude', '2.2.0'))).toBe(false)
    pruneScratch(root, { codex: [] })
    expect(existsSync(installed.prefix)).toBe(false)
  })

  it('adopts a scratch CLI as a Conductor-owned pin and releases it', async () => {
    const environment = { ...process.env, CONDUCTOR_MODEL_UPGRADE_NPM: FAKE_NPM, CONDUCTOR_FAKE_CLI_CATALOGS: catalogs }
    const scratch = await installScratchCli(join(directory, 'adopt-scratch'), 'codex', '0.160.0', { registry, environment })
    const store = new CliVersionStore({ directory: join(directory, 'cli-cache'), home: join(directory, 'nohome'), resolveInstalled: () => null })
    const saved = await store.adopt('codex', '0.160.0', scratch.executable)
    expect(store.pinnedExecutable('codex')).toBe(saved)
    expect(store.adoptedPin('codex')).toBe('0.160.0')
    // The pinned copy survives the scratch prefix being pruned.
    pruneScratch(join(directory, 'adopt-scratch'), {})
    expect(existsSync(saved)).toBe(true)
    store.clearPins('codex')
    expect(store.pinnedExecutable('codex')).toBeNull()
  }, 30_000)

  it('never takes an npm .bin shim for the executable', () => {
    const prefix = join(directory, 'shim')
    mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex'), '')
    expect(findPackagedExecutable(prefix, 'codex')).toBeNull()
  })

  it('probes a CLI catalog with the latest-models script and a scratch config home holding only the sign-in file', async () => {
    const root = join(directory, 'probe-scratch')
    const environment = { ...process.env, CONDUCTOR_MODEL_UPGRADE_NPM: FAKE_NPM, CONDUCTOR_FAKE_CLI_CATALOGS: catalogs }
    const codex = await installScratchCli(root, 'codex', '0.160.0', { registry, environment })
    const home = join(directory, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{"fake":true}')
    const probe = await probeCatalog({ provider: 'codex', executable: codex.executable, script: SCRIPT, workDirectory: join(directory, 'work'), environment: { ...environment, CODEX_HOME: '' }, home })
    expect(probe.version).toBe('0.160.0')
    expect(probe.models).toEqual([
      expect.objectContaining({ id: 'gpt-6-astra', upgrade: 'gpt-7-astra', isDefault: false }),
      expect.objectContaining({ id: 'gpt-7-astra', displayName: 'GPT-7-Astra', isDefault: true })
    ])
    const claude = await installScratchCli(root, 'claude', '2.2.0', { registry, environment })
    const claudeProbe = await probeCatalog({ provider: 'claude', executable: claude.executable, script: SCRIPT, workDirectory: join(directory, 'work'), environment, home })
    expect(claudeProbe.models.map(model => model.id)).toEqual(['claude-opus-5-6', 'default'])
    expect(existsSync(join(directory, 'work'))).toBe(true)
  }, 60_000)
})
