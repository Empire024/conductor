import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The active tab's fill rules (.pane-tab.active, .tab-group .pane-tab.active and the light-theme
// variant) have the same or higher specificity than the generic .pane-tab:hover and come later in
// the sheet, so without its own :hover rule after them the active tab gave no hover feedback at
// all. smoke-navigation.mjs checks the computed colour; this pins the cascade order cheaply.
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const lastIndexOf = (selector: RegExp): number => {
  let last = -1
  for (const match of css.matchAll(selector)) last = match.index ?? last
  return last
}

describe('active tab hover', () => {
  it('declares an active-tab hover fill after every active-tab fill it has to override', () => {
    const hover = lastIndexOf(/\.tab-group \.pane-tab\.active:hover[^{]*\{[^}]*background/g)
    const lightHover = lastIndexOf(/:root\[data-theme="light"\] \.pane-tab\.active:hover\s*\{[^}]*background/g)
    expect(hover).toBeGreaterThan(-1)
    expect(lightHover).toBeGreaterThan(-1)
    expect(hover).toBeGreaterThan(lastIndexOf(/\.tab-group \.pane-tab\.active\s*\{/g))
    expect(hover).toBeGreaterThan(lastIndexOf(/(^|\n)\.pane-tab\.active\s*\{/g))
    expect(lightHover).toBeGreaterThan(lastIndexOf(/:root\[data-theme="light"\] \.pane-tab\.active\s*\{/g))
  })
})
