import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIVE_PROMPT_A, LIVE_PROMPT_B, validateLiveTurn, liveReplacementAuthorization, liveCostLimits } from './live-test-policy'
import { ConductorDatabase } from './database'

describe('host live acceptance policy (zero inference)', () => {
  it('requires a suite-exact explicit replacement authorization and leaves cost thresholds unchanged', () => {
    const env = { CONDUCTOR_LIVE_TESTS: '1', CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID: 'original-suite' }
    expect(liveReplacementAuthorization('original-suite', 'codex', {})).toBe(false)
    expect(liveReplacementAuthorization('original-suite', 'codex', env)).toBe(true)
    expect(() => liveReplacementAuthorization('new-suite', 'codex', env)).toThrow('exactly')
    expect(() => liveReplacementAuthorization('original-suite', 'claude', env)).toThrow('Codex')
    expect(() => liveReplacementAuthorization('original-suite', 'codex', { ...env, CONDUCTOR_LIVE_TESTS: '0' })).toThrow('enabled')
    expect(liveCostLimits('codex', env)).toEqual({ provider: .25, suite: .50 })
    expect(liveCostLimits('codex', { ...env, CONDUCTOR_LIVE_MAX_USD_CODEX: '99', CONDUCTOR_LIVE_MAX_USD_TOTAL: '99' })).toEqual({ provider: .25, suite: .50 })
  })
  it('defaults off and requires explicit model/auth/effort plus a matching isolated fixture marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-live-policy-'))
    try {
      const settings = { model: 'allowed-test-model', effort: 'low', permission: 'default' as const, plan: false }
      const env = { CONDUCTOR_LIVE_TESTS: '1', CONDUCTOR_LIVE_MODEL_CODEX: 'allowed-test-model', CONDUCTOR_LIVE_AUTH_CODEX: 'cli', CONDUCTOR_LIVE_SUITE_ID: 'suite-fixture', CONDUCTOR_LIVE_FIXTURE_ROOT: root }
      writeFileSync(join(root, '.conductor-live-fixture.json'), JSON.stringify({ suiteId: 'suite-fixture', provider: 'codex' }))
      expect(() => validateLiveTurn('codex', root, LIVE_PROMPT_A, settings, {})).toThrow('disabled')
      expect(validateLiveTurn('codex', root, LIVE_PROMPT_A, settings, env).prompt).toBe('A')
      expect(validateLiveTurn('codex', root, LIVE_PROMPT_B, settings, env).prompt).toBe('B')
      expect(() => validateLiveTurn('codex', root, LIVE_PROMPT_A, { ...settings, model: 'another-model' }, env)).toThrow('approved model')
      expect(() => validateLiveTurn('codex', root, LIVE_PROMPT_A, { ...settings, effort: 'high' }, env)).toThrow('low/minimal')
      expect(() => validateLiveTurn('codex', root, 'Help me debug the screenshot', settings, env)).toThrow('fixed live acceptance prompts')
      expect(() => validateLiveTurn('claude', root, LIVE_PROMPT_A, settings, env)).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('reserves A/B once in durable SQLite before dispatch and survives restart or a new session', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-live-allowance-')), path = join(root, 'conductor.db')
    let db: ConductorDatabase | undefined
    try {
      db = new ConductorDatabase(path)
      expect(() => db!.structured.reserveLive('suite', 'codex', 2, 4, 'B')).toThrow('A then B')
      db.structured.reserveLive('suite', 'codex', 2, 4, 'A')
      db.close(); db = new ConductorDatabase(path)
      expect(() => db!.structured.reserveLive('suite', 'codex', 2, 4, 'A')).toThrow('only once')
      db.structured.reserveLive('suite', 'codex', 2, 4, 'B')
      expect(() => db!.structured.reserveLive('suite', 'codex', 2, 4)).toThrow('allowance exhausted')
      db.structured.reserveLive('suite', 'claude', 2, 4, 'A')
      db.structured.addLiveCost('suite', 'claude', 0.25)
      expect(() => db!.structured.reserveLive('suite', 'claude', 2, 4, 'B')).toThrow('cost threshold')
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
