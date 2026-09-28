/**
 * Argument checks shared by the app-control methods (agent-control.ts, schedule-control.ts).
 *
 * A refusal an agent has to guess its way out of costs a round trip per guess: on 2026-09-28
 * `schedules.pause` took seven tries in one tab and `opus` was refused where `opus[1m]` worked.
 * So every refusal here names the method, the arguments it does take, and the closest one to what
 * was sent; and a name that means one thing unambiguously (`taskId` for `id`, `opus` for
 * `opus[1m]`) is simply accepted.
 */

type Args = Record<string, unknown>

/** A refusal caused by the caller's arguments. AgentControl.call prefixes the method name. */
export class ArgumentError extends Error {
  prefixed = false
}

/** Keys the control server adds to every body; never an argument of the method itself. */
const TRANSPORT_KEYS = ['sessionId']

const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}

/** The accepted key a stray one most likely meant: same letters in another case, or a typo. */
export function closestKey(key: string, allowed: readonly string[]): string | undefined {
  const lower = key.toLowerCase()
  const exact = allowed.find(candidate => candidate.toLowerCase() === lower)
  if (exact) return exact
  const ranked = allowed.map(candidate => ({ candidate, cost: distance(lower, candidate.toLowerCase()) })).sort((a, b) => a.cost - b.cost)
  const best = ranked[0]
  return best && best.cost <= Math.min(2, Math.floor(best.candidate.length / 3)) ? best.candidate : undefined
}

/**
 * The arguments of a method with a fixed argument list, with aliases renamed to the key the
 * method reads. Anything else is refused by name:
 * `<method> accepts only <list>; <extra> is not an argument (did you mean <key>?).`
 * `hint` is appended to that refusal (what to do instead of the rejected key).
 */
export function validateArgs(method: string, args: Args, allowed: readonly string[], options: { aliases?: Record<string, string>; hint?: string; ignore?: readonly string[] } = {}): Args {
  const result: Args = { ...args }
  for (const [alias, key] of Object.entries(options.aliases ?? {})) {
    if (!(alias in result)) continue
    if (key in result && result[key] !== result[alias]) throw new ArgumentError(`${method}: ${alias} and ${key} name the same argument with different values; pass only ${key}`)
    result[key] = result[alias]
    delete result[alias]
  }
  const ignored = [...TRANSPORT_KEYS, ...(options.ignore ?? [])]
  const extra = Object.keys(result).filter(key => !allowed.includes(key) && !ignored.includes(key))
  if (extra.length) {
    const guesses = extra.map(key => closestKey(key, allowed)).filter((key): key is string => Boolean(key))
    const guess = guesses.length ? ` (did you mean ${[...new Set(guesses)].join(', ')}?)` : ''
    throw new ArgumentError(`${method} accepts only ${allowed.join(', ') || 'no arguments'}; ${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not an argument${guess}.${options.hint ? ' ' + options.hint : ''}`)
  }
  return result
}

/** A model as models.list offers it. */
export interface OfferedModel { id: string; label: string }
export interface OfferedProvider<M extends OfferedModel = OfferedModel> { provider: string; available: boolean; models: M[] }

/**
 * The offered model a caller meant. Exact id first, then the same id in another case, then the
 * 1M-context form of it (`opus` → `opus[1m]`), then a label written out in full, then the one
 * model whose id (else label) contains the name (`fable` → `claude-fable-5-1`, `astra` →
 * `gpt-6-astra`). Several candidates at the last step are not a match: guessing between two
 * models is a choice the caller makes, not Conductor. `resolvedFrom` is set when the id differs
 * from what was asked, so the result can say what was opened.
 */
export function resolveModel<M extends OfferedModel>(models: readonly M[], requested: string): { model: M; resolvedFrom?: string } | null {
  const exact = models.find(model => model.id === requested)
  if (exact) return { model: exact }
  const lower = requested.trim().toLowerCase()
  if (!lower) return null
  const found = models.find(model => model.id.toLowerCase() === lower)
    ?? models.find(model => model.id.toLowerCase() === `${lower}[1m]`)
    ?? models.find(model => model.label.toLowerCase() === lower)
    ?? (lower.length >= 3 ? unique(models.filter(model => model.id.toLowerCase().includes(lower))) ?? unique(models.filter(model => model.label.toLowerCase().includes(lower))) : undefined)
  return found ? { model: found, resolvedFrom: requested } : null
}
const unique = <T>(list: T[]): T | undefined => list.length === 1 ? list[0] : undefined

const listing = (models: readonly OfferedModel[]): string => models.map(model => model.label && model.label !== model.id ? `${model.id} (${model.label})` : model.id).join(', ')

/** The refusal for a provider that is not offered, naming the ones that are. */
export function providerError(catalog: readonly OfferedProvider[], provider: string): string {
  const available = catalog.filter(entry => entry.available).map(entry => entry.provider)
  return `Provider "${provider}" is not available here; available: ${available.join(', ') || 'none'} (models.list).`
}

/** The refusal for a model the provider does not offer: another provider's model says which
 *  provider to pass; anything else lists every id this provider offers. */
export function modelError(catalog: readonly OfferedProvider[], provider: string, requested: string, models?: readonly OfferedModel[]): string {
  const elsewhere = catalog.find(entry => entry.available && entry.provider !== provider && resolveModel(entry.models, requested))
  if (elsewhere) return `"${requested}" is a ${elsewhere.provider} model; pass provider:"${elsewhere.provider}" (you asked for ${provider}).`
  const offered = models ?? catalog.find(entry => entry.provider === provider)?.models ?? []
  return `Model "${requested}" is not offered for ${provider} here. Choose one of: ${listing(offered) || 'none'}.`
}

/** Provider and model for a new agent tab, resolved or refused with the texts above. */
export function pickModel<P extends OfferedProvider<OfferedModel & { isDefault?: boolean }>>(catalog: readonly P[], provider: string, requested: unknown): { entry: P; model: P['models'][number]; resolvedFrom?: string } {
  const entry = catalog.find(candidate => candidate.provider === provider && candidate.available)
  if (!entry) throw new ArgumentError(providerError(catalog, provider))
  if (requested === undefined) {
    const model = entry.models.find(candidate => candidate.isDefault) ?? entry.models[0]
    if (!model) throw new ArgumentError(`${provider} offers no model here right now (models.list)`)
    return { entry, model }
  }
  if (typeof requested !== 'string' || !requested.trim()) throw new ArgumentError(`model must be a model id from models.list; ${provider} offers: ${listing(entry.models)}`)
  const resolved = resolveModel(entry.models, requested)
  if (!resolved) throw new ArgumentError(modelError(catalog, provider, requested))
  return { entry, ...resolved }
}
