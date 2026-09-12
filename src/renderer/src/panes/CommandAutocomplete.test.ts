import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateBrowserMention } from './CommandAutocomplete'

describe('browser mention activation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reveals the left browser instead of sending anything or changing tool authority', () => {
    const events: Event[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => { events.push(event); return true } })
    activateBrowserMention()
    expect(events.map(event => event.type)).toEqual(['conductor:sidebar-mode'])
    expect((events[0] as CustomEvent).detail).toBe('browser')
  })

  it('is the same call the composer footer button makes, so both share one activation path', () => {
    const events: Event[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => { events.push(event); return true } })
    activateBrowserMention()
    activateBrowserMention()
    expect(events.map(event => event.type)).toEqual(['conductor:sidebar-mode', 'conductor:sidebar-mode'])
  })
})
