import { describe, expect, it } from 'vitest'
import { bannerAbsorbsError, runtimeBanner } from './runtime-banner'

const live = { phase: 'idle', historical: false, unstarted: false, archived: false, ready: true, resuming: false, canResume: true }
const stopped = { ...live, phase: 'disconnected' }

describe('stopped conversation banner', () => {
  it('stays hidden while the conversation is usable or only previewed', () => {
    for (const phase of ['idle', 'running', 'waiting_approval', 'completed']) expect(runtimeBanner({ ...live, phase })).toBeNull()
    expect(runtimeBanner({ ...stopped, historical: true })).toBeNull()
    // A runtime that never reached a native session exchanged nothing; there is no turn to resume.
    expect(runtimeBanner({ ...stopped, unstarted: true })).toBeNull()
  })
  it('separates what stopped from what it means, so neither line has to carry both', () => {
    expect(runtimeBanner(stopped)).toEqual({ title: 'Runtime disconnected', detail: 'The last operation may be incomplete. Resume to continue this same conversation.', resume: true, disabled: false })
    expect(runtimeBanner({ ...live, phase: 'interrupted' })?.title).toBe('Runtime interrupted')
    expect(runtimeBanner({ ...live, phase: 'interrupted' })?.resume).toBe(true)
  })
  it('still explains a stop the provider cannot reconnect, without offering a dead action', () => {
    const banner = runtimeBanner({ ...stopped, canResume: false })
    expect(banner?.resume).toBe(false)
    expect(banner?.detail).toContain('cannot be reconnected')
  })
  it('blocks a second resume while one is in flight, unloaded or archived', () => {
    expect(runtimeBanner({ ...stopped, resuming: true })?.disabled).toBe(true)
    expect(runtimeBanner({ ...stopped, ready: false })?.disabled).toBe(true)
    expect(runtimeBanner({ ...stopped, archived: true })?.disabled).toBe(true)
  })
})

describe('duplicate stopped-runtime reporting', () => {
  const uncertain = 'Execution became uncertain. Resume the native conversation explicitly before sending another turn.'
  it('drops the provider rejection the banner already states with a button', () => {
    expect(bannerAbsorbsError(runtimeBanner(stopped), uncertain)).toBe(true)
  })
  it('keeps every other failure visible, and keeps all of them when resume is not offered', () => {
    expect(bannerAbsorbsError(runtimeBanner(stopped), 'Provider executable unavailable')).toBe(false)
    expect(bannerAbsorbsError(runtimeBanner({ ...stopped, canResume: false }), uncertain)).toBe(false)
    expect(bannerAbsorbsError(null, uncertain)).toBe(false)
  })
})
