import { useState } from 'react'
import { DEFAULT_ENERGY_PRICE, energyCost, formatMoney, formatPrice, formatWh, parseEnergyPrice, type EnergyPrice, type LocalEnergyReading, type LocalEnergyTotals } from '../../../shared/local-energy'
import { useEnergyPrice } from './energy-price'
import './LocalEnergyCard.css'

const seconds = (ms: number): string => ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round(ms % 60_000 / 1000)} s` : `${(ms / 1000).toFixed(1)} s`
const priceNote = (price: EnergyPrice): string => `at ${formatPrice(price)}${price.perKwh === DEFAULT_ENERGY_PRICE.perKwh && price.currency === DEFAULT_ENERGY_PRICE.currency ? ' (default price; change it under Usage & limits)' : ''}`

/**
 * One local turn's energy, the local counterpart of a cloud turn's tokens and cost. The GPU part
 * is measured, the rest of the PC is a stated estimate, and without nvidia-smi it says "not
 * measured" rather than showing a number. Free of hooks so it renders in a plain unit test.
 */
export function LocalEnergyCard({ reading, price }: { reading: LocalEnergyReading; price: EnergyPrice }): React.JSX.Element {
  if (!reading.measured) {
    return <p className="sa-notice sa-local-energy" data-energy="unmeasured" title={reading.reason}>Energy not measured: {reading.reason}.</p>
  }
  const cost = energyCost(reading.totalWh, price)
  return <p className="sa-notice sa-local-energy" data-energy="measured" data-energy-wh={reading.totalWh.toFixed(4)}
    title={`GPU: ${formatWh(reading.gpuWh)} measured by nvidia-smi (${reading.samples} samples, average ${Math.round(reading.averageGpuWatts)} W, peak ${Math.round(reading.peakGpuWatts)} W${reading.shared ? ', shared with another local turn running at the same time' : ''}). Rest of the system: ${formatWh(reading.systemWh)}, an estimate of ${reading.systemWatts} W, not measured. Cost ${priceNote(price)}.`}>
    <strong>≈ {formatWh(reading.totalWh)}</strong> · ≈ {formatMoney(cost, price)} this turn · GPU {Math.round(reading.averageGpuWatts)} W avg over {seconds(reading.durationMs)} (measured) + ~{reading.systemWatts} W rest of system (estimate)
  </p>
}

export function LocalEnergyNotice({ reading }: { reading: LocalEnergyReading }): React.JSX.Element {
  const [price] = useEnergyPrice()
  return <LocalEnergyCard reading={reading} price={price} />
}

/** The conversation's local energy for Usage & limits: totals, money and the price setting. */
/** Usage & limits: the conversation's energy with the owner's price, when it has local turns. */
export function LocalEnergyUsage({ totals }: { totals: LocalEnergyTotals | null }): React.JSX.Element | null {
  const [price, setPrice] = useEnergyPrice()
  return totals ? <LocalEnergyTotalsView totals={totals} price={price} onPrice={setPrice} /> : null
}

export function LocalEnergyTotalsView({ totals, price, onPrice }: { totals: LocalEnergyTotals; price: EnergyPrice; onPrice?(price: EnergyPrice | null): void }): React.JSX.Element {
  const measured = totals.measuredTurns > 0
  return <section className="sa-local-energy-totals" aria-label="Local model energy">
    <h4>Energy (local model)</h4>
    {measured
      ? <dl>
        <dt>This conversation</dt><dd>≈ {formatWh(totals.totalWh)} · ≈ {formatMoney(energyCost(totals.totalWh, price), price)} over {totals.measuredTurns} measured turn{totals.measuredTurns === 1 ? '' : 's'}</dd>
        <dt>GPU (measured)</dt><dd>{formatWh(totals.gpuWh)}, nvidia-smi board power while the turns ran</dd>
        <dt>Rest of system (estimate)</dt><dd>{formatWh(totals.systemWh)}, a fixed CPU, memory and board allowance; not measured</dd>
        {totals.unmeasuredTurns > 0 && <><dt>Not measured</dt><dd>{totals.unmeasuredTurns} turn{totals.unmeasuredTurns === 1 ? '' : 's'}{totals.lastReason ? `: ${totals.lastReason}` : ''}</dd></>}
      </dl>
      : <p className="sa-detail-hint">Not measured{totals.lastReason ? `: ${totals.lastReason}` : ''}.</p>}
    {onPrice && <EnergyPriceEditor price={price} onPrice={onPrice} />}
  </section>
}

function EnergyPriceEditor({ price, onPrice }: { price: EnergyPrice; onPrice(price: EnergyPrice | null): void }): React.JSX.Element {
  const [perKwh, setPerKwh] = useState(String(price.perKwh))
  const [currency, setCurrency] = useState(price.currency)
  const next = parseEnergyPrice({ perKwh: Number(perKwh), currency })
  const save = (): void => { if (next) onPrice(next) }
  // Not a <form>: the Usage dialog renders inside the composer's form, and a native submit of a
  // nested form reloaded the whole window instead of saving (VR7 E2). Enter saves here and goes no
  // further, so it cannot submit the composer either.
  const enter = (event: React.KeyboardEvent<HTMLInputElement>): void => { if (event.key !== 'Enter') return; event.preventDefault(); event.stopPropagation(); save() }
  return <div className="sa-energy-price" role="group" aria-label="Electricity price">
    <label>Electricity price <input aria-label="Currency" value={currency} maxLength={6} size={3} onChange={event => setCurrency(event.target.value)} onKeyDown={enter} /><input aria-label="Price per kWh" type="number" min={0} step={0.01} value={perKwh} onChange={event => setPerKwh(event.target.value)} onKeyDown={enter} /> per kWh</label>
    <button type="button" disabled={!next} onClick={save}>Save</button>
    <button type="button" onClick={() => { setPerKwh(String(DEFAULT_ENERGY_PRICE.perKwh)); setCurrency(DEFAULT_ENERGY_PRICE.currency); onPrice(null) }}>Default ({formatPrice(DEFAULT_ENERGY_PRICE)})</button>
  </div>
}
