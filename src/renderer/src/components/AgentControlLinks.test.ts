import { describe, expect, it } from 'vitest'
import { computeMarkers, type ControlRect } from './AgentControlLinks'
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
    expect(controller.title).toBe('tab-a controls tab-b')
    expect(controlled.title).toBe(controller.title)
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
  it('offsets markers landing on the same tab so multiple links stay visually distinguishable instead of stacking exactly', () => {
    const rects: Record<string, ControlRect> = { 'tab-a': rectOf(0, 0), 'tab-b': rectOf(200, 0), 'tab-c': rectOf(400, 0) }
    const markers = computeMarkers([
      link({ targetAgentSessionId: 't1', controllerTabId: 'tab-a', controlledTabId: 'tab-c' }),
      link({ targetAgentSessionId: 't2', controllerTabId: 'tab-b', controlledTabId: 'tab-c' })
    ], id => rects[id], titleFor)
    const onTabC = markers.filter(m => m.tabId === 'tab-c')
    expect(onTabC).toHaveLength(2)
    expect(onTabC[0]!.x).not.toBe(onTabC[1]!.x)
  })
})

describe('marker capping when one tab orchestrates many others', () => {
  it('keeps a busy controller header readable by folding the tail into a single +N badge', () => {
    const rects: Record<string, ControlRect> = { hub: rectOf(0, 0, 200) }
    for (let i = 0; i < 12; i++) rects['leaf-' + i] = rectOf(300 + i * 90, 0)
    const links = Array.from({ length: 12 }, (_, i) => link({ targetAgentSessionId: 'target-' + i, controllerTabId: 'hub', controlledTabId: 'leaf-' + i }))
    const markers = computeMarkers(links, id => rects[id], titleFor)
    const hub = markers.filter(marker => marker.tabId === 'hub')
    expect(hub).toHaveLength(3)
    expect(hub.filter(marker => marker.extra)).toHaveLength(1)
    expect(hub.at(-1)!.extra).toBe(10)
    expect(hub.at(-1)!.title).toBe('10 more linked tabs')
    // Each controlled tab has exactly one link, so none of them gets a count badge.
    expect(markers.filter(marker => marker.tabId.startsWith('leaf-'))).toHaveLength(12)
    expect(markers.filter(marker => marker.tabId.startsWith('leaf-') && marker.extra)).toHaveLength(0)
  })

  it('leaves a tab at the cap fully badged rather than spending a slot on "+1"', () => {
    const rects: Record<string, ControlRect> = { hub: rectOf(0, 0, 200), 'leaf-0': rectOf(300, 0), 'leaf-1': rectOf(400, 0), 'leaf-2': rectOf(500, 0) }
    const links = [0, 1, 2].map(i => link({ targetAgentSessionId: 'target-' + i, controllerTabId: 'hub', controlledTabId: 'leaf-' + i }))
    const markers = computeMarkers(links, id => rects[id], titleFor)
    const hub = markers.filter(marker => marker.tabId === 'hub')
    expect(hub).toHaveLength(3)
    expect(hub.some(marker => marker.extra)).toBe(false)
  })
})
