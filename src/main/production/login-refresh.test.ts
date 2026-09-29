import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvidenceKind, TestAccountRef } from '../../shared/production'
import { createLoginStatePreparer, LoginRefreshFailed, staleReason } from './login-refresh'

const NOW = new Date('2026-09-29T20:00:00.000Z')
const ORIGINS = ['https://www.hashandflowers.sk']
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'login-refresh-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const gateState = (expires: number): string => JSON.stringify({ cookies: [{ name: 'pwd_gate', value: 'gate-cookie-value-123', domain: 'www.hashandflowers.sk', path: '/', expires }], origins: [] })
const account = (path: string, refresh: Partial<NonNullable<NonNullable<TestAccountRef['storageState']>['refresh']>> | null = {}): TestAccountRef => ({
  id: 'gate', label: 'Site gate', role: 'guest', usernameRef: null, passwordRef: null,
  storageState: { path, capturedAt: null, capturedBy: null, refresh: refresh === null ? null : { command: 'npx playwright test --project=gate-setup', cwd: dir, maxAgeHours: 24, maskEnv: ['HAF_SMOKE_SITE_PASSWORD'], ...refresh } },
})

function sink() {
  const written: Array<{ kind: EvidenceKind; description: string; text: string }> = []
  const secrets: string[] = []
  return {
    written, secrets,
    writeText: async (kind: EvidenceKind, description: string, text: string) => { written.push({ kind, description, text }); return { id: `e${written.length}`, kind, path: 'x', sha256: '', description, capturedAt: NOW.toISOString(), redacted: true } },
    writeJson: async () => { throw new Error('unused') },
    writeBinary: async () => { throw new Error('unused') },
    addSecrets: (values: Iterable<string>) => { secrets.push(...values) },
  }
}

describe('staleReason', () => {
  it('names a missing file, an old file and an expired cookie of an allowed origin; ignores other origins', () => {
    const path = join(dir, 'state.json')
    expect(staleReason(account(path).storageState!, ORIGINS, NOW)).toMatch(/does not exist/)
    writeFileSync(path, gateState(NOW.getTime() / 1000 + 86_400))
    expect(staleReason(account(path).storageState!, ORIGINS, NOW)).toBeNull()
    utimesSync(path, new Date(NOW.getTime() - 25 * 3_600_000), new Date(NOW.getTime() - 25 * 3_600_000))
    expect(staleReason(account(path).storageState!, ORIGINS, NOW)).toMatch(/older than 24 h/)
    writeFileSync(path, gateState(NOW.getTime() / 1000 - 1))
    expect(staleReason(account(path).storageState!, ORIGINS, NOW)).toMatch(/cookie .* has expired/)
    expect(staleReason(account(path).storageState!, ['https://other.example'], NOW)).toBeNull()
  })
})

describe('createLoginStatePreparer', () => {
  it('runs the owner\'s command once when the state is stale, masks the named environment values and keeps the output as evidence', async () => {
    const path = join(dir, 'state.json')
    const evidence = sink()
    const notes: string[] = []
    const runCommand = vi.fn(async () => { writeFileSync(path, gateState(NOW.getTime() / 1000 + 20 * 86_400)); return { exitCode: 0, output: 'posting gate password s3cret-gate-pass\n1 passed' } })
    const prepare = createLoginStatePreparer({ runCommand, evidence, allowedOrigins: ORIGINS, signal: new AbortController().signal, now: () => NOW, env: { HAF_SMOKE_SITE_PASSWORD: 's3cret-gate-pass' }, note: line => notes.push(line) })
    await prepare(account(path))
    await prepare(account(path))
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledWith('npx playwright test --project=gate-setup', expect.objectContaining({ cwd: dir, timeoutMs: 120_000 }))
    expect(evidence.secrets).toEqual(['s3cret-gate-pass'])
    expect(evidence.written).toHaveLength(1)
    expect(evidence.written[0]!.text).toContain('posting gate password [masked]')
    expect(evidence.written[0]!.text).not.toContain('s3cret-gate-pass')
    expect(notes.join('\n')).toMatch(/Refreshing the login state of Site gate: the storage-state file does not exist/)
    expect(notes.join('\n')).not.toContain('s3cret-gate-pass')
  })

  it('fails with the reason when the command fails, times out or leaves the state unusable, and does not retry within the run', async () => {
    const path = join(dir, 'state.json')
    const failing = vi.fn(async () => ({ exitCode: 1, output: 'Error: gate password missing' }))
    const prepare = createLoginStatePreparer({ runCommand: failing, evidence: sink(), allowedOrigins: ORIGINS, signal: new AbortController().signal, now: () => NOW, env: {} })
    await expect(prepare(account(path))).rejects.toThrow(LoginRefreshFailed)
    await expect(prepare(account(path))).rejects.toThrow(/the refresh command exited 1 \(evidence e1\)/)
    expect(failing).toHaveBeenCalledTimes(1)

    const timedOut = createLoginStatePreparer({ runCommand: async () => ({ exitCode: null, output: '', timedOut: true }), evidence: sink(), allowedOrigins: ORIGINS, signal: new AbortController().signal, now: () => NOW })
    await expect(timedOut(account(path, { timeoutMs: 5_000 }))).rejects.toThrow(/timed out after 5 s/)

    const noop = createLoginStatePreparer({ runCommand: async () => ({ exitCode: 0, output: 'ok' }), evidence: sink(), allowedOrigins: ORIGINS, signal: new AbortController().signal, now: () => NOW })
    await expect(noop(account(path))).rejects.toThrow(/still unusable after the refresh command succeeded: the storage-state file does not exist/)

    const unwired = createLoginStatePreparer({ runCommand: null, evidence: sink(), allowedOrigins: ORIGINS, signal: new AbortController().signal, now: () => NOW })
    await expect(unwired(account(path))).rejects.toThrow(/no command runner/)
  })

  it('leaves a fresh state and an account without a refresh alone', async () => {
    const path = join(dir, 'state.json')
    writeFileSync(path, gateState(NOW.getTime() / 1000 + 86_400))
    const runCommand = vi.fn(async () => ({ exitCode: 0, output: '' }))
    const prepare = createLoginStatePreparer({ runCommand, evidence: sink(), allowedOrigins: ORIGINS, signal: new AbortController().signal, now: () => NOW })
    await prepare(account(path))
    await prepare(account(join(dir, 'missing.json'), null))
    expect(runCommand).not.toHaveBeenCalled()
  })
})
