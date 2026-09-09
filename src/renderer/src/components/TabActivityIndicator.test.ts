import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentActivityPhase } from '../../../shared/models'
import { readActivityPhase } from '../../../shared/models'
import { ACTIVITY_LABEL, TabActivityIndicator } from './TabActivityIndicator'

const render = (phase: AgentActivityPhase): string =>
  renderToStaticMarkup(createElement(TabActivityIndicator, { phase, title: 'Codex', spinEpoch: 0 }))

describe('tab activity indicator', () => {
  it('names the state it is showing, in the tooltip and to a screen reader', () => {
    const markup = render('disconnected')
    expect(markup).toContain(ACTIVITY_LABEL.disconnected)
    expect(markup).toContain('Codex: Disconnected')
  })

  it.each(['failed', 'disconnected', 'stopped'] as const)('gives %s its own glyph rather than a repainted ring', (phase) => {
    const markup = render(phase)
    expect(markup).toContain('tab-state-icon')
    // The shared spinner ring is what used to be filled red for every unhappy state.
    expect(markup).not.toContain('viewBox="0 0 18 18"')
  })

  it('draws the three ended states differently from each other', () => {
    const shapes = (['failed', 'disconnected', 'stopped'] as const).map(render)
    expect(new Set(shapes).size).toBe(3)
  })

  it('keeps the shared ring for the phases of a run still in progress', () => {
    for (const phase of ['working', 'complete', 'limited'] as const) expect(render(phase)).toContain('viewBox="0 0 18 18"')
  })

  it('describes every phase', () => {
    const phases: AgentActivityPhase[] = ['idle', 'working', 'waiting_input', 'limited', 'complete', 'stopped', 'disconnected', 'failed']
    for (const phase of phases) expect(ACTIVITY_LABEL[phase]).toBeTruthy()
  })

  it('reads a phase persisted before the unhappy states were split', () => {
    expect(readActivityPhase('error')).toBe('failed')
    expect(readActivityPhase('working')).toBe('working')
  })
})
