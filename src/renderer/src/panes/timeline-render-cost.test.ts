import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Typing into a long conversation cost 0.5-1.2 s per key at 4x throttle (scripts/perf-input.mjs
// --provider=claude): every timeline card kept its finished entry animation's opacity/transform
// effect (fill-mode both), so Chrome re-layerized hundreds of cards each frame, and every
// keystroke's layout reached into the timeline. These pin the two CSS halves of that fix; the
// benchmark's timelineMutations and longtasks measure the rest.
const paneCss = readFileSync(new URL('./StructuredAgentPane.css', import.meta.url), 'utf8')
const conversationCss = readFileSync(new URL('./AgentConversation.css', import.meta.url), 'utf8')
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
})
