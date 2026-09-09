/** Chrome-style tab groups and the active-tab contrast, checked on a strip as crowded as the
 *  one in the bug report: twelve agent tabs, where the old active state was invisible.
 *
 *  Runs the real PaneWorkspace in headless chromium against a vite fixture - no Electron
 *  window, so nothing can appear over whoever is working. See "Automation must not take the
 *  desktop" in AGENTS.md. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PaneWorkspace} from '/src/renderer/src/layout/PaneWorkspace';
import {TabActivityIndicator} from '/src/renderer/src/components/TabActivityIndicator';
import '/src/renderer/src/styles.css';
window.conductor = {
  agentControl: { links: async () => [], onLinksChanged: () => () => {} },
  window: { isCursorOutside: async () => false },
  structured: { bindWorkspace: async () => {} },
  sessions: { save: async () => {} }
};
const TITLES = ['Fix tab drag regression','Review layout operations','Workspace files sidebar','Effort picker polish','Project backlog pane','Session controls','Remote control server','VS Code bridge','Separator drag','Launcher grid','Codex protocol','Usage limit banner'];
const tabs = TITLES.map((title, index) => ({ id: 'pane-' + index, kind: 'launcher', title, resourceId: 'agent-' + index }));
const project = { id: 'p', name: 'conductor', path: 'C:/Claude/conductor', createdAt: '', updatedAt: '' };
const PHASES = ['working','waiting_input','limited','complete','stopped','disconnected','failed'];
function App(){
  const [layout, setLayout] = useState({ version: 1, root: { type: 'group', id: 'g1', tabs, activeTabId: 'pane-3' } });
  const [focused, setFocused] = useState('g1');
  const session = { id: 's', projectId: 'p', name: 'Workspace 1', layout, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' };
  return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
    <div style={{flex:1,minHeight:0}}>
      <PaneWorkspace layout={layout} project={project} session={session} focusedGroupId={focused} maximizedGroupId={null}
        onLayout={setLayout} onPersistLayout={async()=>{}} onFocus={setFocused} onMaximize={()=>{}} onClosed={()=>{}}
        onDetach={()=>{}} canReopen={false} onReopen={()=>{}} />
    </div>
    <div id="phases" style={{display:'flex',gap:18,padding:'10px 14px',alignItems:'center'}}>
      {PHASES.map(phase => <span key={phase} data-phase={phase} style={{display:'flex',gap:5,alignItems:'center',fontSize:10,color:'var(--text-2)'}}>
        <TabActivityIndicator phase={phase} title="Codex" spinEpoch={0} />{phase}
      </span>)}
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);`

const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: 'tab-groups-fixture',
  resolveId(id) { if (id === '/__tab-groups.tsx') return id },
  load(id) { if (id === '/__tab-groups.tsx') return fixture },
  configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__tab-groups') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__tab-groups.tsx"></script></body></html>'))
  }) }
}], server: { host: '127.0.0.1', port: 0 } })
await server.listen()

const browser = await chromium.launch({ headless: true })
const output = resolve('artifacts/tab-groups')
await mkdir(output, { recursive: true })

/** Perceived lightness of an sRGB triple, for judging whether the active tab really stands out
 *  rather than trusting that a class was applied. */
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 620 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0] + '__tab-groups')
  await page.waitForSelector('.pane-tab')
  await expect(page.locator('.pane-tab')).toHaveCount(12)

  // 1. The active tab has to be obvious against its neighbours, in both themes.
  const contrastIn = async (theme) => {
    await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
    await page.waitForTimeout(120)
    // An unselected tab paints nothing of its own, so what the eye compares the active tab
    // against is the strip showing through it.
    const read = async (selector) => page.locator(selector).first().evaluate(el => {
      // An unselected tab paints nothing of its own, so what the eye compares the active tab
      // against is the strip showing through it.
      const backdrop = (node) => {
        for (let current = node; current; current = current.parentElement) {
          const background = getComputedStyle(current).backgroundColor
          if (!background.endsWith(', 0)')) return background
        }
        return 'rgb(0, 0, 0)'
      }
      // Chromium serializes these as rgb(), color(srgb ...) or oklab(...) depending on how the
      // value was authored; letting canvas resolve them avoids parsing three notations by hand.
      const toRgb = (value) => {
        const context = document.createElement('canvas').getContext('2d')
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      const style = getComputedStyle(el)
      return { background: toRgb(backdrop(el)), color: style.color, weight: style.fontWeight, width: el.getBoundingClientRect().width }
    })
    const active = await read('.pane-tab.active')
    const inactive = await read('.pane-tab:not(.active)')
    const rail = await page.locator('.pane-tab.active').first().evaluate(el => getComputedStyle(el, '::before').backgroundColor)
    await page.screenshot({ path: resolve(output, `crowded-strip-${theme}.png`) })
    return { theme, active, inactive, rail, delta: Math.abs(luminance(active.background) - luminance(inactive.background)) }
  }
  const dark = await contrastIn('dark')
  const light = await contrastIn('light')
  for (const measured of [dark, light]) {
    assert.ok(measured.delta > 0.03, `${measured.theme}: active tab must differ from its neighbours, got delta ${measured.delta.toFixed(4)} between ${measured.active.background} and ${measured.inactive.background}`)
    assert.ok(Number(measured.active.weight) >= 600, `${measured.theme}: active tab title must be heavier than its neighbours`)
    assert.notEqual(measured.rail, 'rgba(0, 0, 0, 0)', `${measured.theme}: active tab must carry its accent rail`)
    assert.ok(measured.active.width > measured.inactive.width, `${measured.theme}: the active tab must stay readable when the strip is full`)
  }

  // 2. Group a tab from the tab menu, name it, then add a second tab to the same group.
  await page.locator('.pane-tab').nth(1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add tab to new group' }).click()
  const nameField = page.getByRole('textbox', { name: 'Group name' })
  await expect(nameField).toBeVisible()
  await nameField.fill('Tab drag')
  await nameField.press('Enter')
  await expect(page.locator('.tab-group-chip')).toHaveText(/Tab drag/)

  await page.locator('.pane-tab').nth(4).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to Tab drag' }).click()
  await expect(page.locator('.tab-group .pane-tab')).toHaveCount(2)
  // Chrome keeps a group's tabs together; the one that joined must have moved beside the first.
  const grouped = await page.locator('.tab-group .pane-tab .pane-tab-title').allTextContents()
  assert.deepEqual(grouped, ['Review layout operations', 'Project backlog pane'], 'a joined tab moves into the run')
  // Nothing in the strip may overlap: a group that could shrink below its own tabs used to
  // let them spill out of its outline and sit on top of the next tab along.
  const overlaps = await page.locator('.pane-tabs').evaluate(strip => {
    const boxes = [...strip.children].map(child => child.getBoundingClientRect())
    return boxes.flatMap((box, index) => index && box.left + 1 < boxes[index - 1].right ? [index] : [])
  })
  assert.deepEqual(overlaps, [], 'tabs and groups must not overlap in the strip')
  // Grouped tabs squeeze within the same bounds as the rest of a crowded strip rather than
  // holding a width that pushes everything else out of legibility.
  const widths = await page.locator('.pane-tab:not(.active)').evaluateAll(tabs => tabs.map(tab => Math.round(tab.getBoundingClientRect().width)))
  assert.ok(widths.every(width => width >= 102 && width <= 226), `every tab stays within the strip's own bounds, got ${widths.join(', ')}`)
  await page.screenshot({ path: resolve(output, 'group-expanded.png') })

  // 3. Collapsing hides the run behind one labelled chip, and expanding brings it back.
  await page.locator('.tab-group-chip').click()
  await expect(page.locator('.tab-group.collapsed')).toHaveCount(1)
  await expect(page.locator('.tab-group .pane-tab')).toHaveCount(0)
  await expect(page.locator('.tab-group-count')).toHaveText('2')
  await expect(page.locator('.pane-tab')).toHaveCount(10)
  // Dragging measures the strip through these slots (see measurePaneAt/tabInsertionIndex). A
  // collapsed group is one slot on screen standing for every tab it hides, so its span has to
  // say so or a tab dropped past it would land in the middle of the hidden run.
  const slots = await page.locator('.pane-tabs [data-drop-slot-id]').evaluateAll(nodes =>
    nodes.map(node => Number(node.dataset.dropSpan ?? 1)))
  assert.equal(slots.length, 11, 'ten loose tabs plus one collapsed group chip')
  assert.equal(slots.reduce((total, span) => total + span, 0), 12, 'the slots must still account for all twelve tabs')
  await page.screenshot({ path: resolve(output, 'group-collapsed.png') })
  await page.locator('.tab-group-chip').click()
  await expect(page.locator('.tab-group .pane-tab')).toHaveCount(2)

  // 4. Recolouring from the group menu reaches the chip.
  await page.locator('.tab-group-chip').click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Purple' }).click()
  await expect(page.locator('.tab-group')).toHaveAttribute('data-tab-group-color', 'purple')

  // 5. Every activity state draws a different glyph and names itself.
  const phases = await page.locator('#phases [data-phase]').evaluateAll(nodes => nodes.map(node => {
    const indicator = node.querySelector('.tab-activity')
    const drawn = indicator.querySelector('circle, path, rect')
    const style = getComputedStyle(drawn)
    return {
      phase: node.dataset.phase,
      title: indicator.getAttribute('title'),
      shape: indicator.querySelector('svg')?.getAttribute('class') ?? '',
      // A glyph the ring's old blanket rules had overpainted would still be in the DOM, so
      // check it is actually drawn: visible stroke, and not dashed out of sight.
      stroke: style.stroke,
      hidden: style.strokeDashoffset !== '0px' && style.strokeDasharray !== 'none' && style.fill === 'none'
    }
  }))
  for (const entry of phases) assert.equal(entry.hidden, false, `${entry.phase}'s glyph must actually be painted`)
  const ended = phases.filter(entry => ['failed', 'disconnected', 'stopped'].includes(entry.phase))
  assert.equal(new Set(ended.map(entry => entry.shape)).size, 3, 'failed, disconnected and stopped must not share a glyph')
  for (const entry of phases) assert.ok(entry.title && entry.title.length > 3, `${entry.phase} must name itself in a tooltip, got ${entry.title}`)
  await page.locator('#phases').screenshot({ path: resolve(output, 'activity-states.png') })

  assert.deepEqual(errors, [], 'the workspace must render without page errors')
  console.log('tab groups: dark delta', dark.delta.toFixed(3), '· light delta', light.delta.toFixed(3))
  console.log('activity states:', phases.map(entry => `${entry.phase}=${entry.title.split(' ')[0]}`).join(' '))
  console.log('screenshots in', output)
} finally {
  await browser.close()
  await server.close()
}
