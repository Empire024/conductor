import type { Json } from '../../shared/structured-agent'

/** A provider adapter's own protocol state, carried from one app process to the next while the
 *  runtime host keeps its provider process running (docs/runtime-host.md). The adapter lists what
 *  must not travel: its options and dependencies, its transport, and anything holding a promise,
 *  a timer or a callback. Anything else that cannot be written down is refused, never dropped, so
 *  an adapter that grows such a field stops being detachable instead of reattaching half-restored. */

const ALWAYS_SKIP = new Set(['options', 'dependencies', 'transport'])

type Encoded = Json

function encode(value: unknown, path: string): Encoded {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value as Json
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $t: 'num', v: String(value) }
  if (value === undefined) return { $t: 'undef' }
  if (Array.isArray(value)) return value.map((entry, index) => encode(entry, `${path}[${index}]`))
  if (value instanceof Map) return { $t: 'map', v: [...value.entries()].map(([key, entry], index) => [encode(key, `${path}<key ${index}>`), encode(entry, `${path}<${index}>`)]) }
  if (value instanceof Set) return { $t: 'set', v: [...value].map((entry, index) => encode(entry, `${path}{${index}}`)) }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return { $t: 'obj', v: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry, `${path}.${key}`)])) }
  }
  throw new Error(`Adapter state ${path} cannot be carried across a restart`)
}

function decode(value: Encoded): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const tagged = value as { $t?: string; v?: Json }
  switch (tagged.$t) {
    case 'undef': return undefined
    case 'num': return Number(tagged.v)
    case 'map': return new Map((tagged.v as Json[][]).map(([key, entry]) => [decode(key!), decode(entry!)]))
    case 'set': return new Set((tagged.v as Json[]).map(decode))
    case 'obj': return Object.fromEntries(Object.entries(tagged.v as Record<string, Json>).map(([key, entry]) => [key, decode(entry)]))
    default: throw new Error('Malformed adapter state')
  }
}

export function captureAdapterState(adapter: object, skip: readonly string[]): Json {
  const excluded = new Set([...ALWAYS_SKIP, ...skip])
  return { $t: 'obj', v: Object.fromEntries(Object.entries(adapter).filter(([key]) => !excluded.has(key)).map(([key, value]) => [key, encode(value, key)])) }
}

/** Only fields the adapter already has are written, so a state from another build can never add
 *  one; a field this build has but the state lacks keeps its constructed value. */
export function restoreAdapterState(adapter: object, state: Json): void {
  const fields = decode(state)
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Malformed adapter state')
  const target = adapter as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) {
    if (ALWAYS_SKIP.has(key) || !Object.prototype.hasOwnProperty.call(target, key) || typeof target[key] === 'function') continue
    target[key] = value
  }
}

/** Waits, bounded, until the adapter has no host call in flight. */
export async function settled(idle: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!idle()) {
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return true
}
