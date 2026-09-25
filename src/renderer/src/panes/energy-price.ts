import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_ENERGY_PRICE, parseEnergyPrice, type EnergyPrice } from '../../../shared/local-energy'

/** The owner's electricity price for local model energy estimates. Kept in this window's
 *  storage: it only turns measured Wh into money on screen, nothing in main depends on it. */
const KEY = 'conductor.localEnergyPrice'
const EVENT = 'conductor:local-energy-price'

export function readEnergyPrice(): EnergyPrice {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    return (raw && parseEnergyPrice(JSON.parse(raw))) || DEFAULT_ENERGY_PRICE
  } catch { return DEFAULT_ENERGY_PRICE }
}

export function writeEnergyPrice(price: EnergyPrice | null): void {
  try {
    if (price) globalThis.localStorage?.setItem(KEY, JSON.stringify(price))
    else globalThis.localStorage?.removeItem(KEY)
  } catch { /* storage unavailable: the default stays in effect */ }
  globalThis.dispatchEvent?.(new Event(EVENT))
}

export function useEnergyPrice(): [EnergyPrice, (price: EnergyPrice | null) => void] {
  const [price, setPrice] = useState(readEnergyPrice)
  useEffect(() => {
    const update = (): void => setPrice(readEnergyPrice())
    window.addEventListener(EVENT, update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener(EVENT, update); window.removeEventListener('storage', update) }
  }, [])
  return [price, useCallback((next: EnergyPrice | null) => writeEnergyPrice(next), [])]
}
