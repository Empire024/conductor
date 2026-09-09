import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StructuredSendButton, sendButtonIntent, type SendButtonState } from './StructuredSendButton'

const idle = { active: false, interrupting: false, draft: false, needsResume: false, steering: false, historical: false, canSubmit: true, submitting: false }
function render(state: SendButtonState, options: { busy?: boolean; disabled?: boolean } = {}): { html: string; onActivate: ReturnType<typeof vi.fn> } {
  const onActivate = vi.fn()
  const html = renderToStaticMarkup(createElement(StructuredSendButton, { state, label: 'Stop', title: 'Stop · Esc', busy: options.busy ?? false, disabled: options.disabled ?? false, onActivate }))
  return { html, onActivate }
}

describe('composer send/stop/resume control', () => {
  it('keeps one button with every glyph mounted so states morph instead of swapping elements', () => {
    for (const state of ['send', 'stop', 'resume'] as const) {
      const { html } = render(state)
      expect(html.match(/<button/g)).toHaveLength(1)
      expect(html).toContain('data-state="' + state + '"')
      for (const glyph of ['sa-glyph-send', 'sa-glyph-stop', 'sa-glyph-resume']) expect(html).toContain(glyph)
      expect(html.match(/<svg/g)).toHaveLength(3)
    }
  })
  it('only submits the composer in the send state, so stopping a turn never posts the draft', () => {
    expect(render('send').html).toContain('type="submit"')
    expect(render('stop').html).toContain('type="button"')
    expect(render('resume').html).toContain('type="button"')
  })
  it('shows the running indicator only while a turn is in flight', () => {
    expect(render('stop', { busy: true }).html).toContain('data-busy="true"')
    expect(render('stop', { busy: true }).html).toContain('sa-send-orbit')
    expect(render('send').html).toContain('data-busy="false"')
  })
  it('keeps the accessible name, tooltip and disabled state on the single button', () => {
    const html = render('stop', { disabled: true }).html
    expect(html).toContain('aria-label="Stop"')
    expect(html).toContain('title="Stop · Esc"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('class="sa-send sa-stop"')
    expect(render('send').html).toContain('class="sa-send"')
    expect(render('send').html).not.toContain('disabled')
  })
  it('hides decorative glyphs from assistive technology', () => {
    expect(render('resume').html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('send button intent', () => {
  it('stops a running turn only while the composer is empty, and never while previewing history', () => {
    expect(sendButtonIntent({ ...idle, active: true })).toEqual({ state: 'stop', label: 'Stop', title: 'Stop · Esc', disabled: false })
    expect(sendButtonIntent({ ...idle, active: true, interrupting: true }).disabled).toBe(true)
    expect(sendButtonIntent({ ...idle, active: true, historical: true }).disabled).toBe(true)
    expect(sendButtonIntent({ ...idle, active: true, draft: true }).state).toBe('send')
  })
  it('offers resume ahead of send when the conversation is interrupted', () => {
    expect(sendButtonIntent({ ...idle, needsResume: true })).toEqual({ state: 'resume', label: 'Resume conversation', title: 'Resume the same conversation', disabled: false })
    expect(sendButtonIntent({ ...idle, needsResume: true, active: true }).state).toBe('stop')
  })
  it('names the send action for steering, queueing and plain sending', () => {
    expect(sendButtonIntent({ ...idle, draft: true }).label).toBe('Send message')
    expect(sendButtonIntent({ ...idle, draft: true, active: true }).label).toBe('Queue message')
    expect(sendButtonIntent({ ...idle, draft: true, active: true }).title).toBe('Queue message after this turn · Enter')
    expect(sendButtonIntent({ ...idle, draft: true, active: true, steering: true }).label).toBe('Steer')
    expect(sendButtonIntent({ ...idle, draft: true, active: true, steering: true }).title).toBe('Send to running turn · Enter')
  })
  it('disables sending without a draft, without a submittable session or mid-submit', () => {
    expect(sendButtonIntent({ ...idle }).disabled).toBe(true)
    expect(sendButtonIntent({ ...idle, draft: true }).disabled).toBe(false)
    expect(sendButtonIntent({ ...idle, draft: true, canSubmit: false }).disabled).toBe(true)
    expect(sendButtonIntent({ ...idle, draft: true, submitting: true }).disabled).toBe(true)
  })
})
