import { realpathSync, readFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { SessionSettings, StructuredProvider } from '../shared/structured-agent'

export const LIVE_PROMPT_A = 'In panel.mjs, remove only the two unused declarations wasOpen and wasPinned. Change nothing else. Run node --test panel.test.mjs once. Do not browse, inspect unrelated files, install packages, or delegate. Report the test result and changed file in no more than 35 words.'
export const LIVE_PROMPT_B = 'Without using tools, name the two identifiers you removed and say whether the test passed. One sentence.'
const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** An owner-authorized replacement is scoped to one existing suite, never a general cap override. */
export function liveReplacementAuthorization(suiteId: string, provider: StructuredProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  const authorizedSuite = env.CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID
  if (!authorizedSuite) return false
  if (env.CONDUCTOR_LIVE_TESTS !== '1' || authorizedSuite !== suiteId || provider !== 'codex') throw new Error('Replacement A authorization must name this enabled Codex suite exactly')
  return true
}

/** Configured thresholds can tighten, never expand, the default suite allowance. */
export function liveCostLimits(provider: StructuredProvider, env: NodeJS.ProcessEnv = process.env): { provider: number; suite: number } {
  const limit = (value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Live cost thresholds must be positive finite numbers')
    return Math.min(parsed, fallback)
  }
  return { provider: limit(env[`CONDUCTOR_LIVE_MAX_USD_${provider.toUpperCase()}`], .25), suite: limit(env.CONDUCTOR_LIVE_MAX_USD_TOTAL, .50) }
}

/** Host-side preflight. No provider is invoked while checking configuration or fixtures. */
export function validateLiveTurn(provider: StructuredProvider, cwd: string, text: string, settings: SessionSettings, env: NodeJS.ProcessEnv = process.env): { suiteId: string; prompt: 'A' | 'B'; auth: 'cli' | 'api' } {
  if (env.CONDUCTOR_LIVE_TESTS !== '1') throw new Error('Live provider tests are disabled')
  const label = provider.toUpperCase(), model = env[`CONDUCTOR_LIVE_MODEL_${label}`], auth = env[`CONDUCTOR_LIVE_AUTH_${label}`], suiteId = env.CONDUCTOR_LIVE_SUITE_ID
  if (!suiteId || !/^[a-zA-Z0-9_-]{1,120}$/.test(suiteId) || !model || model !== settings.model || !['cli', 'api'].includes(auth ?? '')) throw new Error('Live tests require an explicit suite ID, approved model, and authentication mode')
  if (!['minimal', 'low', 'none'].includes(settings.effort ?? '')) throw new Error('Live tests require explicitly selected low/minimal supported effort')
  if (settings.plan) throw new Error('The live edit acceptance suite does not use planning mode')
  if (provider === 'codex' && (settings.sandbox && settings.sandbox !== 'workspace-write' || settings.approvalPolicy && settings.approvalPolicy !== 'untrusted')) throw new Error('Codex live acceptance requires a fixture workspace sandbox and untrusted-command approvals')
  const prompt = normalized(text) === LIVE_PROMPT_A ? 'A' : normalized(text) === LIVE_PROMPT_B ? 'B' : null
  if (!prompt) throw new Error('Only the two fixed live acceptance prompts are allowed; helper and retry prompts are prohibited')
  const configuredRoot = env.CONDUCTOR_LIVE_FIXTURE_ROOT
  if (!configuredRoot) throw new Error('A disposable fixture root must be explicitly configured')
  const root = realpathSync(configuredRoot), actual = realpathSync(cwd)
  if (actual !== root && (relative(root, actual).startsWith('..') || isAbsolute(relative(root, actual)))) throw new Error('Live prompt is outside the configured fixture root')
  const marker = JSON.parse(readFileSync(join(actual, '.conductor-live-fixture.json'), 'utf8')) as { suiteId?: string; provider?: string }
  if (marker.suiteId !== suiteId || marker.provider !== provider) throw new Error('Fixture marker does not match this provider and suite')
  return { suiteId, prompt, auth: auth as 'cli' | 'api' }
}
