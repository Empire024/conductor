import { randomBytes } from 'node:crypto'
import type { SyntheticValue } from '../../shared/production'

/**
 * Placeholder values for every form a check fills (docs/production-agent.md section 4.6). Real
 * customer data is never typed into a page; each value embeds a marker unique to the run, so a leak
 * into a replay payload, an analytics beacon, a URL or a log can be searched for, and the evidence
 * sink scrubs every marker before anything leaves the run.
 *
 * Markers are lowercase consonants only (`zq` plus twelve letters, about 4e15 values): they survive
 * URL encoding and name/address validation, contain no digits a phone or card field would strip,
 * and cannot spell a word a page might contain by chance. Search for them case-insensitively.
 */

const MARKER_ALPHABET = 'bcdfghjklmnpqrstvwxz'
export const MARKER_PATTERN = /zq[bcdfghjklmnpqrstvwxz]{12}/gi

export interface SyntheticFactory {
  next(kind: SyntheticValue['kind']): SyntheticValue
  /** Every marker handed out so far; the evidence sink reads this live. */
  markers(): string[]
}

export function newMarker(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(12)
  let marker = 'zq'
  for (const byte of bytes) marker += MARKER_ALPHABET[byte % MARKER_ALPHABET.length]
  return marker
}

/** A Luhn-valid 16-digit Visa-shaped number that no issuer has handed out as a live card; its digits are the marker. */
function syntheticCard(random: (size: number) => Uint8Array): string {
  const digits = [4, 1, 1, 1, 1, 1, ...[...random(9)].map(byte => byte % 10)]
  let sum = 0
  for (let index = 0; index < 15; index++) {
    // Positions counted from the right of the full 16-digit number: the check digit is position 1.
    let digit = digits[index]!
    if ((15 - index) % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9 }
    sum += digit
  }
  return [...digits, (10 - (sum % 10)) % 10].join('')
}

export function createSyntheticFactory(random: (size: number) => Uint8Array = randomBytes): SyntheticFactory {
  const issued: string[] = []
  const remember = (marker: string): string => { issued.push(marker); return marker }
  return {
    next(kind) {
      if (kind === 'card') {
        const value = remember(syntheticCard(random))
        return { kind, value, marker: value }
      }
      if (kind === 'phone') {
        const value = remember(`+421900${[...random(6)].map(byte => byte % 10).join('')}`)
        return { kind, value, marker: value }
      }
      const marker = remember(newMarker(random))
      const value = {
        email: `audit.${marker}@example.com`,
        name: `Audit ${marker}`,
        password: `Pw!${marker}9aA`,
        message: `Conductor audit test message ${marker}. Please ignore.`,
        address: `${marker} Test Street 1`,
        marker,
      }[kind]
      return { kind, value, marker }
    },
    markers: () => [...issued],
  }
}

/** Luhn check, exported for tests and for checks that recognise card-like fields. */
export function luhnValid(number: string): boolean {
  if (!/^\d{12,19}$/.test(number)) return false
  let sum = 0
  for (let index = 0; index < number.length; index++) {
    let digit = Number(number[number.length - 1 - index])
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9 }
    sum += digit
  }
  return sum % 10 === 0
}
