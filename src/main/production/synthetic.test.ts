import { describe, expect, it } from 'vitest'
import { MARKER_PATTERN, createSyntheticFactory, luhnValid, newMarker } from './synthetic'

describe('synthetic values', () => {
  it('embeds a unique, letters-only marker in every value', () => {
    const factory = createSyntheticFactory()
    const values = (['email', 'name', 'password', 'message', 'address', 'marker'] as const).map(kind => factory.next(kind))
    for (const value of values) {
      expect(value.marker).toMatch(/^zq[bcdfghjklmnpqrstvwxz]{12}$/)
      expect(value.value).toContain(value.marker)
    }
    expect(new Set(values.map(value => value.marker)).size).toBe(values.length)
    expect(factory.markers()).toEqual(values.map(value => value.marker))
    expect(values[0]!.value).toMatch(/^audit\.zq[a-z]{12}@example\.com$/)
    expect(`leak ${values[1]!.marker.toUpperCase()} here`.match(MARKER_PATTERN)).toHaveLength(1)
  })

  it('makes Luhn-valid card numbers and plausible phone numbers whose digits are the marker', () => {
    const factory = createSyntheticFactory()
    for (let index = 0; index < 50; index++) {
      const card = factory.next('card')
      expect(card.value).toMatch(/^411111\d{10}$/)
      expect(luhnValid(card.value)).toBe(true)
      expect(card.marker).toBe(card.value)
    }
    expect(factory.next('phone').value).toMatch(/^\+421900\d{6}$/)
    expect(luhnValid('4242424242424242')).toBe(true)
    expect(luhnValid('4242424242424241')).toBe(false)
  })

  it('is deterministic under an injected random source', () => {
    const random = (size: number) => new Uint8Array(size).fill(7)
    expect(newMarker(random)).toBe(newMarker(random))
  })
})
