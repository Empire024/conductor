import { describe, expect, it } from 'vitest'
import { advertisedModel, ArgumentError, closestKey, modelError, pickModel, providerError, resolveModel, validateArgs } from './control-args'

const claude = [
  { id: 'opus[1m]', label: 'Claude Opus 5.5 (1M context)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'sonnet', label: 'Claude Sonnet 5' },
  { id: 'haiku', label: 'Claude Haiku 4.5' }
]
const codex = [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }, { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }]
const catalog = [{ provider: 'claude', available: true, models: claude }, { provider: 'codex', available: true, models: codex }, { provider: 'grok', available: false, models: [] }]

describe('resolveModel', () => {
  it('maps an Opus request onto what the live Claude runtime advertises, keeping the 1M form when offered', () => {
    // Claude Code 2.1.287: `opus` stands for claude-opus-5-5 and there is no `opus[1m]`.
    const live = [
      { id: 'default', label: 'Default (recommended)', resolvedModel: 'claude-fable-5-1' },
      { id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      { id: 'claude-opus-5', label: 'Opus 5' }
    ]
    expect(advertisedModel(live, 'opus[1m]')?.id).toBe('opus')
    expect(advertisedModel(live, 'opus')?.id).toBe('opus')
    expect(advertisedModel(live, 'claude-opus-5-5')?.id).toBe('opus')
    expect(advertisedModel(live, 'claude-opus-5-5[1m]')?.id).toBe('opus')
    expect(advertisedModel(live, 'claude-opus-5')?.id).toBe('claude-opus-5')
    expect(advertisedModel(live, 'gpt-6-astra')).toBeUndefined()
    // Claude Code 2.1.282 still offered the 1M alias: it is kept.
    const older = [...live, { id: 'opus[1m]', label: 'Opus (1M context)', resolvedModel: 'claude-opus-5-5[1m]' }]
    expect(advertisedModel(older, 'opus[1m]')?.id).toBe('opus[1m]')
    expect(advertisedModel(older, 'claude-opus-5-5')?.id).toBe('opus[1m]')
    expect(pickModel([{ provider: 'claude', available: true, models: live }], 'claude', 'claude-opus-5-5')).toMatchObject({ model: { id: 'opus' }, resolvedFrom: 'claude-opus-5-5' })
  })

  it('takes the exact id, then case, then the 1M form, then a full label, then one unique match', () => {
    expect(resolveModel(claude, 'sonnet')).toEqual({ model: claude[2] })
    expect(resolveModel(claude, 'Sonnet')).toEqual({ model: claude[2], resolvedFrom: 'Sonnet' })
    expect(resolveModel(claude, 'opus')).toEqual({ model: claude[0], resolvedFrom: 'opus' })
    expect(resolveModel(claude, 'Claude Haiku 4.5')?.model.id).toBe('haiku')
    expect(resolveModel(claude, 'fable')?.model.id).toBe('claude-fable-5-1')
    expect(resolveModel(codex, 'astra')?.model.id).toBe('gpt-6-astra')
  })
  it('never guesses between several candidates or on a fragment too short to mean anything', () => {
    expect(resolveModel(codex, 'gpt-5.6')).toBeNull()
    expect(resolveModel(claude, 'o')).toBeNull()
    expect(resolveModel(claude, '')).toBeNull()
    expect(resolveModel(claude, 'gpt-6-astra')).toBeNull()
  })
})

describe('model and provider refusals', () => {
  it('lists every offered id, points another provider\'s model at that provider, and names the available providers', () => {
    expect(modelError(catalog, 'claude', 'nonsense')).toBe('Model "nonsense" is not offered for claude here. Choose one of: opus[1m] (Claude Opus 5.5 (1M context)), claude-fable-5-1 (Claude Fable 5.1), sonnet (Claude Sonnet 5), haiku (Claude Haiku 4.5).')
    expect(modelError(catalog, 'claude', 'gpt-6-astra')).toBe('"gpt-6-astra" is a codex model; pass provider:"codex" (you asked for claude).')
    expect(providerError(catalog, 'grok')).toBe('Provider "grok" is not available here; available: claude, codex (models.list).')
    expect(() => pickModel(catalog, 'grok', undefined)).toThrow(ArgumentError)
    expect(pickModel(catalog, 'claude', undefined).model.id).toBe('opus[1m]')
    expect(pickModel(catalog, 'claude', 'opus')).toMatchObject({ model: { id: 'opus[1m]' }, resolvedFrom: 'opus' })
    expect(() => pickModel(catalog, 'claude', 42)).toThrow(/model must be a model id from models.list; claude offers: opus\[1m\]/)
  })
})

describe('validateArgs', () => {
  it('renames aliases, ignores the transport scope key, and refuses the rest by name with a suggestion', () => {
    expect(validateArgs('m', { taskId: 't', sessionId: 's' }, ['id'], { aliases: { taskId: 'id' } })).toEqual({ id: 't', sessionId: 's' })
    expect(validateArgs('m', { id: 't', taskId: 't' }, ['id'], { aliases: { taskId: 'id' } })).toEqual({ id: 't' })
    expect(() => validateArgs('m', { id: 'a', taskId: 'b' }, ['id'], { aliases: { taskId: 'id' } })).toThrow('m: taskId and id name the same argument with different values; pass only id')
    expect(() => validateArgs('git.ship.status', { runID: 'x', extra: 1 }, ['runId', 'waitSeconds'])).toThrow('git.ship.status accepts only runId, waitSeconds; runID, extra are not an argument (did you mean runId?).')
    expect(() => validateArgs('app.state', { x: 1 }, [])).toThrow('app.state accepts only no arguments; x is not an argument.')
    expect(() => validateArgs('m', { result: 1 }, ['id'], { hint: 'Report it instead.' })).toThrow('m accepts only id; result is not an argument. Report it instead.')
  })
  it('suggests only near misses', () => {
    expect(closestKey('messag', ['message', 'paths'])).toBe('message')
    expect(closestKey('AGENTSESSIONID', ['agentSessionId'])).toBe('agentSessionId')
    expect(closestKey('result', ['id', 'title', 'status'])).toBeUndefined()
  })
})
