import { describe, expect, it } from 'vitest'
import { isPointOutsideBounds, isWindowPlacementVisible, parseSavedWindowLayout } from './window-geometry'

describe('native window cursor geometry', () => {
  const bounds = { x: 100, y: 200, width: 800, height: 600 }

  it('recognizes points inside the sender BrowserWindow', () => {
    expect(isPointOutsideBounds({ x: 100, y: 200 }, bounds)).toBe(false)
    expect(isPointOutsideBounds({ x: 899, y: 799 }, bounds)).toBe(false)
  })

  it('recognizes points outside every edge', () => {
    expect(isPointOutsideBounds({ x: 99, y: 400 }, bounds)).toBe(true)
    expect(isPointOutsideBounds({ x: 900, y: 400 }, bounds)).toBe(true)
    expect(isPointOutsideBounds({ x: 400, y: 199 }, bounds)).toBe(true)
    expect(isPointOutsideBounds({ x: 400, y: 800 }, bounds)).toBe(true)
  })
})

describe('window restore geometry', () => {
  it('restores valid main and detached placements', () => {
    expect(parseSavedWindowLayout(JSON.stringify({
      version: 1,
      main: { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true },
      detached: { abc: { bounds: { x: 1300, y: 20, width: 700, height: 600 }, maximized: false } }
    }))).toEqual({
      version: 1,
      main: { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true },
      detached: { abc: { bounds: { x: 1300, y: 20, width: 700, height: 600 }, maximized: false } }
    })
  })

  it('ignores corrupt placements and rejects an invalid envelope', () => {
    expect(parseSavedWindowLayout('{')).toBeNull()
    expect(parseSavedWindowLayout(JSON.stringify({ version: 2, detached: {} }))).toBeNull()
    expect(parseSavedWindowLayout(JSON.stringify({
      version: 1,
      detached: { tiny: { bounds: { x: 0, y: 0, width: 10, height: 10 }, maximized: false } }
    }))).toEqual({ version: 1, detached: {} })
  })

  it('only uses a placement that remains reachable on a current display', () => {
    const display = [{ x: 0, y: 0, width: 1920, height: 1040 }]
    expect(isWindowPlacementVisible({ bounds: { x: 1800, y: 900, width: 800, height: 600 }, maximized: false }, display)).toBe(true)
    expect(isWindowPlacementVisible({ bounds: { x: 2500, y: 1200, width: 800, height: 600 }, maximized: false }, display)).toBe(false)
  })
})
