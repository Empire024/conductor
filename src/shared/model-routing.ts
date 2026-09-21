import type { AgentProviderId } from './models'

/** Capability comes before quota. This intentionally classifies names conservatively. */
export function capabilityRank(provider: AgentProviderId, modelId: string): 0 | 1 | 2 | 3 {
  const id = modelId.toLowerCase()
  if (provider === 'local' || id.startsWith('local/')) return 0
  if (/gpt-6|astra|opus/.test(id)) return 3
  if (/terra|sonnet|gpt-5\.5/.test(id)) return 2
  if (/luna|sol|haiku|mini|cheap/.test(id)) return 1
  return 2
}

export function coordinatorEffort(efforts: readonly string[] | undefined, fallback?: string): string | undefined {
  if (!efforts?.length) return undefined
  if (efforts.includes('high')) return 'high'
  if (fallback && efforts.includes(fallback)) return fallback
  return efforts.includes('xhigh') ? 'xhigh' : efforts[0]
}
