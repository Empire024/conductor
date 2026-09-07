import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Offline component interaction check: no provider process or inference.
const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StructuredComposerControls} from '/src/renderer/src/panes/StructuredComposerControls';
import {StructuredAgentTelemetry} from '/src/renderer/src/panes/StructuredAgentTelemetry';
import '/src/renderer/src/styles.css';
import '/src/renderer/src/panes/StructuredAgentPane.css';
const caps = {provider:'claude',models:[{id:'default',label:'Default (Opus)',effort:['low','high','xhigh']},{id:'opus',label:'Opus',effort:['low','high','xhigh']}],effectiveSettings:{model:'opus',effort:'xhigh'},permissions:['default','accept-edits','auto'],plans:true};
const item=(sequence,data,extra={})=>({id:String(sequence),runtimeId:'r',sequence,timestamp:'2026-09-07T12:00:00Z',data,...extra});
const items=[item(1,{type:'tool',name:'Agent',status:'completed',input:{prompt:'Review permission changes'}},{nativeItemId:'launch'}),item(2,{type:'subagent',name:'Permission reviewer',status:'completed',nativeSessionId:'review-thread'},{parentId:'launch',nativeItemId:'child'}),item(3,{type:'tool',name:'Read',status:'completed',output:'Permission menu inspected'},{parentId:'launch'}),item(4,{type:'text',role:'assistant',text:'Keyboard navigation and permission settings verified.',mode:'snapshot'},{parentId:'launch'}),item(5,{type:'subagent',name:'Test runner',status:'running'},{nativeItemId:'test-child'}),item(6,{type:'subagent',name:'Failed check',status:'failed'},{nativeItemId:'failed-child'})];
function App(){const [settings,setSettings]=useState({permission:'default',plan:false});return <main className="structured-agent-pane" style={{height:'100vh',padding:24}}><h2>Session controls</h2><StructuredAgentTelemetry items={items} runtimeId="r" phase="running"/><div className="sa-composer" style={{marginTop:'auto'}}><div style={{display:'flex',gap:10,alignItems:'center'}}><StructuredComposerControls settings={settings} capabilities={caps} disabled={false} onChange={change=>setSettings(s=>({...s,...change}))} onDiscover={async()=>{}}/></div></div></main>};createRoot(document.getElementById('root')).render(<App/>);`
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: 'session-controls-fixture',
  resolveId(id) { if (id === '/__session-controls.tsx') return id },
  load(id) { if (id === '/__session-controls.tsx') return fixture },
  configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__session-controls') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__session-controls.tsx"></script></body></html>'))
  }) }
}], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const output = resolve('artifacts/session-controls')
await mkdir(output, {recursive:true})
try {
  const page = await browser.newPage({viewport:{width:1000,height:760}})
  const errors=[]; page.on('pageerror', error=>errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0]+'__session-controls')
  const slider=page.getByRole('slider',{name:'Reasoning effort'})
  await expect(slider).toHaveValue('3')
  await expect(slider).toHaveAttribute('aria-valuetext','Xhigh')
  await slider.press('ArrowLeft'); await expect(slider).toHaveValue('2'); await expect(slider).toHaveAttribute('aria-valuetext','High')
  const mode=page.getByRole('button',{name:'Conversation mode',exact:true})
  await mode.click()
  await expect(page.getByRole('menuitemradio',{name:/Ask/})).toBeFocused()
  await page.screenshot({path:resolve(output,'permissions.png')})
  await page.getByRole('menuitemradio',{name:/Ask/}).press('ArrowDown')
  await page.getByRole('menuitemradio',{name:/Edit/}).press('Enter')
  await expect(mode).toContainText('Edit'); await expect(mode).toBeFocused()
  await mode.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await expect(mode).toContainText('Plan')
  await mode.click(); await page.keyboard.press('Escape'); await expect(mode).toBeFocused()
  await page.getByRole('button',{name:/3 subagents/}).click()
  await expect(page.getByRole('textbox',{name:'Search subagents'})).toBeFocused()
  await page.getByRole('button',{name:/Permission reviewer/}).click()
  await expect(page.getByText('Assigned task',{exact:true})).toBeVisible()
  await expect(page.locator('section').getByText('Keyboard navigation and permission settings verified.',{exact:true})).toBeVisible()
  await page.locator('.sa-agent-activity > summary').click()
  await expect(page.getByText(/Permission menu inspected/)).toBeVisible()
  await page.screenshot({path:resolve(output,'subagents.png')})
  await page.getByRole('button',{name:'Active',exact:true}).click(); await expect(page.locator('.sa-agent-card')).toHaveCount(1)
  await expect(page.getByRole('button',{name:/Test runner/})).toBeVisible()
  await page.getByRole('button',{name:'Needs attention',exact:true}).click(); await expect(page.getByRole('button',{name:/Failed check/})).toBeVisible()
  await page.getByRole('button',{name:'All',exact:true}).click()
  await page.getByRole('textbox',{name:'Search subagents'}).fill('permission'); await expect(page.locator('.sa-agent-card')).toHaveCount(1)
  await page.getByRole('textbox',{name:'Search subagents'}).fill('no match'); await expect(page.getByRole('dialog').getByRole('status')).toHaveText('No subagents match this view.')
  await page.getByRole('textbox',{name:'Search subagents'}).fill('')
  await page.getByRole('button',{name:'Expand all',exact:true}).click(); await expect(page.locator('.sa-agent-card-heading[aria-expanded="true"]')).toHaveCount(3)
  await page.getByRole('button',{name:'Collapse all',exact:true}).click(); await expect(page.locator('.sa-agent-card-heading[aria-expanded="false"]')).toHaveCount(3)
  await page.setViewportSize({width:390,height:740})
  await page.screenshot({path:resolve(output,'subagents-narrow.png')})
  await expect(page.getByRole('dialog')).toBeVisible()
  const overflow=await page.getByRole('dialog').evaluate(el=>el.scrollWidth>el.clientWidth); if(overflow) throw Error('Dialog overflows horizontally')
  if(errors.length) throw Error(errors.join('\n'))
  console.log('Passed: effective effort position, permission keyboard selection, focus restoration, subagent details, search, filters, expand/collapse, narrow layout.')
} finally { await browser.close(); await server.close() }
