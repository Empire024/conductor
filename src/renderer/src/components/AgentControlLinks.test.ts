import { describe, expect, it } from 'vitest'
import { computeControlPopoverPosition, computeMarkers, type ControlRect } from './AgentControlLinks'
import type { AgentControlLink } from '../../../shared/agent-control'

const rectOf = (x: number, y: number, width = 80, height = 24): ControlRect => ({ x, y, width, height })
const link = (over: Partial<AgentControlLink> = {}): AgentControlLink => ({ projectId: 'p', sessionId: 's', controllerAgentSessionId: 'ctrl-agent', targetAgentSessionId: 'target-1', controllerTabId: 'tab-a', controlledTabId: 'tab-b', ...over })
const titleFor = (id: string): string => id

describe('computeMarkers (tab-header badges replacing the old cross-content cable)', () => {
  it('places a marker at each end, anchored inside that tab header rect so it never reaches into the content below it', () => {
    const rects: Record<string, ControlRect> = { 'tab-a': rectOf(0, 100), 'tab-b': rectOf(500, 300) }
    const markers = computeMarkers([link()], id => rects[id], titleFor)
    expect(markers).toHaveLength(2)
    const controller = markers.find(m => m.role === 'controller')!
    const controlled = markers.find(m => m.role === 'controlled')!
    expect(controller.tabId).toBe('tab-a')
    expect(controlled.tabId).toBe('tab-b')
    for (const [marker, rect] of [[controller, rects['tab-a']!], [controlled, rects['tab-b']!]] as const) {
      expect(marker.x).toBeGreaterThanOrEqual(rect.x)
      expect(marker.x).toBeLessThanOrEqual(rect.x + rect.width)
      expect(marker.y).toBeGreaterThanOrEqual(rect.y)
      expect(marker.y).toBeLessThanOrEqual(rect.y + rect.height)
    }
  })
  it('gives both ends of a link the same matched color and a title describing controller -> controlled direction', () => {
    const rects: Record<string, ControlRect> = { 'tab-a': rectOf(0, 0), 'tab-b': rectOf(200, 0) }
    const markers = computeMarkers([link()], id => rects[id], titleFor)
    const controller = markers.find(m => m.role === 'controller')!
    const controlled = markers.find(m => m.role === 'controlled')!
    expect(controller.color).toBe(controlled.color)
    expect(controller.title).toContain('tab-a is the main coordinating tab and controls 1 coworker: tab-b')
    expect(controlled.title).toContain('tab-b is a coworker controlled by tab-a')
  })
  it('still reports the controller-side marker when the controlled tab is detached into another window (no rect available there)', () => {
    const rects: Record<string, ControlRect> = { 'tab-a': rectOf(0, 0) }
    const markers = computeMarkers([link()], id => rects[id], titleFor)
    expect(markers).toEqual([expect.objectContaining({ role: 'controller', tabId: 'tab-a' })])
  })
  it('still reports the controlled-side marker when the controller tab is detached into another window', () => {
    const rects: Record<string, ControlRect> = { 'tab-b': rectOf(0, 0) }
    const markers = computeMarkers([link()], id => rects[id], titleFor)
    expect(markers).toEqual([expect.objectContaining({ role: 'controlled', tabId: 'tab-b' })])
  })
  it('produces no markers when neither linked tab is present in this window', () => {
    expect(computeMarkers([link()], () => undefined, titleFor)).toEqual([])
  })
  it('collapses duplicate relationship ends into one labelled tab role', () => {
    const rects: Record<string, ControlRect> = { 'tab-a': rectOf(0, 0), 'tab-b': rectOf(200, 0), 'tab-c': rectOf(400, 0) }
    const markers = computeMarkers([
      link({ targetAgentSessionId: 't1', controllerTabId: 'tab-a', controlledTabId: 'tab-c' }),
      link({ targetAgentSessionId: 't2', controllerTabId: 'tab-b', controlledTabId: 'tab-c' })
    ], id => rects[id], titleFor)
    const onTabC = markers.filter(m => m.tabId === 'tab-c')
    expect(onTabC).toHaveLength(1)
    expect(onTabC[0]).toMatchObject({ role: 'controlled', count: 1 })
  })

  it('keeps both directions visible when a coworker coordinates its own child', () => {
    const rects: Record<string, ControlRect> = { root: rectOf(0, 0), middle: rectOf(200, 0), leaf: rectOf(400, 0) }
    const markers = computeMarkers([
      link({ targetAgentSessionId: 'middle-agent', controllerTabId: 'root', controlledTabId: 'middle' }),
      link({ targetAgentSessionId: 'leaf-agent', controllerTabId: 'middle', controlledTabId: 'leaf' })
    ], id => rects[id], titleFor)
    const middle = markers.find(marker => marker.tabId === 'middle')
    expect(middle).toMatchObject({ role: 'both', count: 1 })
    expect(middle?.title).toContain('coworker controlled by root')
    expect(middle?.title).toContain('main coordinator for 1 coworker: leaf')
  })
})

describe('one persistent role marker per linked tab', () => {
  it('keeps a busy controller header readable with one labelled MAIN count', () => {
    const rects: Record<string, ControlRect> = { hub: rectOf(0, 0, 200) }
    for (let i = 0; i < 12; i++) rects['leaf-' + i] = rectOf(300 + i * 90, 0)
    const links = Array.from({ length: 12 }, (_, i) => link({ targetAgentSessionId: 'target-' + i, controllerTabId: 'hub', controlledTabId: 'leaf-' + i }))
    const markers = computeMarkers(links, id => rects[id], titleFor)
    const hub = markers.filter(marker => marker.tabId === 'hub')
    expect(hub).toHaveLength(1)
    expect(hub[0]!.count).toBe(12)
    expect(hub[0]!.title).toContain('controls 12 coworkers')
    expect(markers.filter(marker => marker.tabId.startsWith('leaf-'))).toHaveLength(12)
  })

  it('never repeats anonymous dots on a tab with several links', () => {
    const rects: Record<string, ControlRect> = { hub: rectOf(0, 0, 200), 'leaf-0': rectOf(300, 0), 'leaf-1': rectOf(400, 0), 'leaf-2': rectOf(500, 0) }
    const links = [0, 1, 2].map(i => link({ targetAgentSessionId: 'target-' + i, controllerTabId: 'hub', controlledTabId: 'leaf-' + i }))
    const markers = computeMarkers(links, id => rects[id], titleFor)
    const hub = markers.filter(marker => marker.tabId === 'hub')
    expect(hub).toHaveLength(1)
    expect(hub[0]).toMatchObject({ role: 'controller', count: 3 })
  })
})

describe('anchored relationship details', () => {
  it('stays beside a tab header in a wide pane instead of occupying the composer edge', () => {
    expect(computeControlPopoverPosition({ x: 900, y: 42 }, { width: 1400, height: 900 })).toEqual({ left: 720, top: 56, width: 360, maxHeight: 300 })
  })

  it('clamps inside a narrow pane without moving to the bottom edge', () => {
    const position = computeControlPopoverPosition({ x: 500, y: 42 }, { width: 520, height: 740 })
    expect(position).toEqual({ left: 152, top: 56, width: 360, maxHeight: 300 })
    expect(position.left + position.width).toBeLessThanOrEqual(512)
  })
})
