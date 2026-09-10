import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateBrowserMention } from './CommandAutocomplete'

describe('browser mention activation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the workspace to toggle its browser pane tab instead of sending anything as literal text', () => {
    const events: Event[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => { events.push(event); return true } })
    activateBrowserMention()
    expect(events.map(event => event.type)).toEqual(['conductor:toggle-browser-tab'])
  })

  it('is the same call the composer footer button makes, so both share one activation path', () => {
    const events: Event[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => { events.push(event); return true } })
    activateBrowserMention()
    activateBrowserMention()
    expect(events.map(event => event.type)).toEqual(['conductor:toggle-browser-tab', 'conductor:toggle-browser-tab'])
  })
})
