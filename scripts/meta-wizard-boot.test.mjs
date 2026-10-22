import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bootVerdict, readBootVerdict } from './meta-wizard/boot.mjs'

// The meta-wizard's copy of the boot verdict (docs/startup-diagnostics.md) gives exactly the answers
// src/main/recovery/boot-verdict.ts gives: both run the same cases.
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'meta-wizard', 'boot-verdict-cases.json'), 'utf8'))

for (const entry of fixture.cases) {
  test(`boot verdict: ${entry.name}`, () => {
    const record = entry.input.record ? fixture.records[entry.input.record] : null
    const now = entry.nowIso ? Date.parse(entry.nowIso) : entry.input.now
    const verdict = bootVerdict({ ...entry.input, record, now })
    assert.deepEqual({ state: verdict.state, stage: verdict.stage, cause: verdict.cause, signature: verdict.signature, line: verdict.line }, entry.expect)
  })
}

test('readBootVerdict finds the launch asked about, and never throws', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mw-boot-'))
  try {
    assert.equal((await readBootVerdict(userData, { pid: 5 })).state, 'unknown')
    const directory = join(userData, 'diagnostics')
    mkdirSync(directory)
    writeFileSync(join(directory, 'boot.json'), JSON.stringify(fixture.records.oomStore))
    const verdict = await readBootVerdict(userData, { pid: 68968, alive: false, log: 'JavaScript heap out of memory' })
    assert.equal(verdict.signature, 'died:structured-store:oom')
    assert.equal(verdict.version, '0.1.58-local.1792659912858')
    writeFileSync(join(directory, 'boot-history.jsonl'), JSON.stringify({ pid: 7, version: 'v', startedAt: '2026-10-22T08:00:00.000Z', outcome: 'died', stage: 'settings', ms: 900, peakHeapMb: 80, cause: 'exit' }) + '\n')
    assert.equal((await readBootVerdict(userData, { pid: 7 })).signature, 'died:settings:exit')
    writeFileSync(join(directory, 'boot.json'), '{ half a file')
    assert.equal((await readBootVerdict(userData, { pid: null })).state, 'unknown')
  } finally { rmSync(userData, { recursive: true, force: true }) }
})
