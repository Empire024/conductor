import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Typing into a long conversation cost 0.5-1.2 s per key at 4x throttle (scripts/perf-input.mjs
// --provider=claude): every timeline card kept its finished entry animation's opacity/transform
// effect (fill-mode both), so Chrome re-layerized hundreds of cards each frame, and every
// keystroke's layout reached into the timeline. These pin the two CSS halves of that fix; the
// benchmark's timelineMutations and longtasks measure the rest.
const paneCss = readFileSync(new URL('./StructuredAgentPane.css', import.meta.url), 'utf8')
const conversationCss = readFileSync(new URL('./AgentConversation.css', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('./StructuredAgentPane.tsx', import.meta.url), 'utf8')
const animationsOf = (css: string, selector: string): string[] =>
  [...css.matchAll(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}', 'g'))]
    .flatMap(match => /(?:^|;)\s*animation\s*:([^;]*)/.exec(match[1]!)?.[1] ?? [])

describe('timeline render cost', () => {
  it('lets a finished entry animation release every timeline card', () => {
    const animations = [...animationsOf(paneCss, '.sa-activity'), ...animationsOf(conversationCss, '.agent-turn')]
    expect(animations.length).toBeGreaterThanOrEqual(2)
    for (const animation of animations) expect(animation).not.toMatch(/\b(both|forwards)\b/)
  })

  it('makes the timeline scroll container a layout and paint boundary', () => {
    expect(paneCss).toMatch(/\.sa-timeline\s*\{[^}]*contain:\s*strict/)
  })

  // An SVG child is never a compositor layer, so an endless animation on one restyles and re-lays out
  // its SVG every frame: the tab rings' turning circles cost 3.6 s of layout a minute while three
  // coworkers worked (perf-input --background). Endless spinners turn the <svg> itself.
  it('never runs an endless animation on an SVG child element', () => {
    const appCss = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const offenders = [...appCss.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, selector, body]) => /\banimation\s*:[^;]*\binfinite\b/.test(body!) && selector!.split(',').some(part => /\b(circle|path|rect|line|polyline|polygon|ellipse|g)\s*$/.test(part.trim())))
      .map(([, selector]) => selector!.trim())
    expect(offenders).toEqual([])
  })

  // Every rendered card costs each frame's layout, paint and layerize, even when a keystroke touched
  // none of them: 250 cards added about 6 ms per key at 4x, the last 40 about 2 (perf-input
  // --provider=claude --events=10000 --floor). The live end renders a small window, and going back
  // there drops whatever history was paged in to read.
  it('renders a bounded window of cards at the live end, whatever was paged in before', () => {
    const live = Number(/const LIVE_WINDOW = (\d+)/.exec(paneSource)?.[1])
    expect(live).toBeGreaterThan(0)
    expect(live).toBeLessThanOrEqual(60)
    expect(paneSource).toContain('useState(LIVE_WINDOW)')
    expect(paneSource).toContain('setVisibleCount(count => Math.min(count, LIVE_WINDOW))')
  })
})
