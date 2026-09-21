import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

// Real relationship component, layout, scroll clipping and hit testing; no inference or desktop window.
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentControlLinks} from '/src/renderer/src/components/AgentControlLinks';
const links=[{projectId:'p',sessionId:'s',controllerAgentSessionId:'a',targetAgentSessionId:'b',controllerTabId:'main',controlledTabId:'child'}];
window.conductor={agentControl:{links:async()=>links,onLinksChanged:()=>()=>{},focusTab:async()=>{},release:async()=>{}}};
const layout={version:1,root:{type:'group',id:'g',tabs:[{id:'main',title:'Main'},{id:'child',title:'Child'}],activeTabId:'main'}};
createRoot(document.getElementById('root')).render(<><div className="pane-tabs" style={{display:'flex',width:220,height:40,overflow:'auto',background:'#233',position:'relative'}}><button data-control-tab-id="main" style={{flex:'0 0 150px'}}>Main</button><button data-control-tab-id="child" style={{flex:'0 0 150px'}}>Child</button></div><div id="cover" style={{display:'none',position:'fixed',inset:0,zIndex:10,background:'#555'}}>Covering content</div><AgentControlLinks projectId="p" sessionId="s" layout={layout}/></>);`
const server = await createServer({ configFile: false, plugins: [react(), {
  name: 'control-marker-fixture', resolveId: id => id === '/__marker.tsx' ? id : undefined,
  load: id => id === '/__marker.tsx' ? fixture : undefined,
  configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__marker') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__marker.tsx"></script></body></html>'))
  }) }
}], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true, ...(!existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) })
const output = resolve('artifacts/control-marker-clipping')
await mkdir(output, { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(server.resolvedUrls.local[0] + '__marker')
  await expect(page.locator('.pane-tabs > .agent-control-marker')).toHaveCount(2)
  const hit = selector => page.locator(selector).evaluate(node => {
    const r = node.getBoundingClientRect()
    return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  assert.equal(await hit('.agent-control-marker.controller'), true)
  assert.equal(await hit('.agent-control-marker.controlled'), false, 'Overflowed child badge is clipped')
  await page.evaluate(() => { document.querySelector('.pane-tabs').scrollLeft = 100 })
  await expect.poll(() => hit('.agent-control-marker.controlled')).toBe(true)
  await page.evaluate(() => { document.getElementById('cover').style.display = 'block' })
  assert.equal(await hit('.agent-control-marker.controlled'), false, 'Badge cannot paint above covering content')
  await page.screenshot({ path: resolve(output, 'covered.png') })
  await page.evaluate(() => { document.getElementById('cover').style.display = 'none'; document.querySelector('.pane-tabs').style.display = 'none' })
  await expect(page.locator('.agent-control-marker').first()).not.toBeVisible()
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: true, checks: ['strip portal', 'overflow clipping', 'scroll reveal', 'cover stacking', 'hidden pane'] }, null, 2))
  console.log('PASS relationship markers follow tab clipping, scroll and stacking')
} finally { await browser.close(); await server.close() }
