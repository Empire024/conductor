import type { AgentEventData, Json, TimelineItem } from './structured-agent'

/**
 * Energy a local model turn used, the local counterpart of a cloud turn's tokens and cost. The GPU
 * figure is measured: nvidia-smi's board power draw, sampled only while a local turn runs and
 * integrated over the turn (shared equally between turns that run at the same time). The rest of
 * the computer (CPU, memory, board, fans) is not measured; it is a fixed estimate, and every place
 * that shows it says so. Without nvidia-smi (a Mac, another GPU vendor) the reading says "not
 * measured" and carries no number at all.
 */
export type LocalEnergyReading =
  | {
    measured: true
    source: 'nvidia-smi'
    durationMs: number
    /** Measured: GPU board power integrated over the turn. */
    gpuWh: number
    /** Estimated: systemWatts over the same time. */
    systemWh: number
    totalWh: number
    averageGpuWatts: number
    peakGpuWatts: number
    systemWatts: number
    samples: number
    /** True when another local turn ran at the same time and the draw was split between them. */
    shared: boolean
  }
  | { measured: false; durationMs: number; reason: string }

export const LOCAL_ENERGY_KEY = 'localEnergy'
/** The rest of the PC while a local model generates: CPU package, memory, board, fans, PSU loss.
 *  Not measured; a round figure for a desktop under a GPU-bound load. */
export const SYSTEM_SHARE_WATTS = 40

export interface EnergyPrice { perKwh: number; currency: string }
/** Stated in the UI next to every money figure; the owner can change it there. */
export const DEFAULT_ENERGY_PRICE: EnergyPrice = { perKwh: 0.2, currency: '$' }

export const localEnergyPayload = (reading: LocalEnergyReading): Json => ({ [LOCAL_ENERGY_KEY]: reading as unknown as Json })

export function localEnergyNotice(reading: LocalEnergyReading): AgentEventData {
  const message = reading.measured
    ? `Local model energy: ${formatWh(reading.totalWh)} (GPU ${formatWh(reading.gpuWh)} measured by nvidia-smi, rest of the system ${formatWh(reading.systemWh)} estimated).`
    : `Local model energy not measured: ${reading.reason}`
  return { type: 'notice', message, payload: localEnergyPayload(reading) }
}

/** The reading a notice item carries, if it is one. Shape-checked because the payload is Json. */
export function localEnergyOf(data: AgentEventData): LocalEnergyReading | undefined {
  if (data.type !== 'notice' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return undefined
  const value = data.payload[LOCAL_ENERGY_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.durationMs !== 'number') return undefined
  if (value.measured === false) return typeof value.reason === 'string' ? value as unknown as LocalEnergyReading : undefined
  if (value.measured !== true) return undefined
  for (const key of ['gpuWh', 'systemWh', 'totalWh', 'averageGpuWatts', 'peakGpuWatts', 'systemWatts', 'samples'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key] as number)) return undefined
  }
  return value as unknown as LocalEnergyReading
}

export interface LocalEnergyTotals { turns: number; measuredTurns: number; unmeasuredTurns: number; gpuWh: number; systemWh: number; totalWh: number; durationMs: number; lastReason?: string }

export function summarizeLocalEnergy(items: readonly TimelineItem[]): LocalEnergyTotals | null {
  const totals: LocalEnergyTotals = { turns: 0, measuredTurns: 0, unmeasuredTurns: 0, gpuWh: 0, systemWh: 0, totalWh: 0, durationMs: 0 }
  for (const item of items) {
    const reading = localEnergyOf(item.data)
    if (!reading) continue
    totals.turns++
    totals.durationMs += reading.durationMs
    if (!reading.measured) { totals.unmeasuredTurns++; totals.lastReason = reading.reason; continue }
    totals.measuredTurns++
    totals.gpuWh += reading.gpuWh
    totals.systemWh += reading.systemWh
    totals.totalWh += reading.totalWh
  }
  return totals.turns ? totals : null
}

export const energyCost = (wh: number, price: EnergyPrice): number => wh / 1000 * price.perKwh

export function formatWh(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`
  if (wh >= 10) return `${wh.toFixed(1)} Wh`
  if (wh >= 0.1) return `${wh.toFixed(2)} Wh`
  return `${(wh * 1000).toFixed(0)} mWh`
}

export function formatMoney(amount: number, price: EnergyPrice): string {
  const digits = amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4
  return `${price.currency}${amount.toFixed(digits)}`
}

export const formatPrice = (price: EnergyPrice): string => `${price.currency}${price.perKwh}/kWh`

/** An owner-entered price, or null when it is not a usable one. */
export function parseEnergyPrice(value: unknown): EnergyPrice | null {
  if (!value || typeof value !== 'object') return null
  const { perKwh, currency } = value as Record<string, unknown>
  if (typeof perKwh !== 'number' || !Number.isFinite(perKwh) || perKwh < 0 || perKwh > 100) return null
  if (typeof currency !== 'string' || !currency.trim() || currency.length > 6) return null
  return { perKwh, currency: currency.trim() }
}
