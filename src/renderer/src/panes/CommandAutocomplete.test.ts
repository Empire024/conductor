import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateBrowserMention } from './CommandAutocomplete'

describe('browser mention activation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the browser sidebar instead of sending anything as literal text', () => {
    const events: CustomEvent[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => { events.push(event); return true } })
    activateBrowserMention()
    expect(events.map(event => event.type)).toEqual(['conductor:sidebar-mode'])
    expect(events[0]!.detail).toBe('browser')
  })
})
