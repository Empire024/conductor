import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Offline interaction check for project memory curation: no provider process or inference.
// `window.conductor.memory` is backed by the project's own ranking helpers so the pane is
// exercised against the real prune ordering rather than a hand-ordered list.
const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryPane} from '/src/renderer/src/panes/MemoryPane';
import {MemoryRecallStrip} from '/src/renderer/src/panes/MemoryRecallStrip';
import {rankMemoriesForPrune} from '/src/main/memory';
import '/src/renderer/src/styles.css';
const base = (patch) => ({id:'m'+Math.random().toString(36).slice(2),projectId:'p',agentKey:null,kind:'semantic',source:'human',origin:null,gist:'',cues:[],salience:0.5,strength:1,confidence:0.75,occurredAt:'2026-09-08T12:00:00.000Z',lastRecalledAt:null,recallCount:0,correctedAt:null,createdAt:'2026-09-08T12:00:00.000Z',updatedAt:'2026-09-08T12:00:00.000Z',...patch});
let store = [
  base({id:'agent-written',source:'agent',kind:'semantic',gist:'Checkout tax totals are recalculated on save',cues:['checkout','tax'],origin:{agentSessionId:'agent-1',workspaceId:'workspace-1',title:'Tax audit',provider:'claude'},recallCount:3,strength:2}),
  base({id:'owner-written',source:'human',kind:'procedural',gist:'Run npm.cmd on Windows, never npm',cues:['windows','npm'],salience:0.95,confidence:0.95}),
  base({id:'faded',source:'agent',kind:'episodic',gist:'Retried the flaky deploy once',cues:['flaky','retry'],salience:0.15,confidence:0.2,occurredAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',origin:null})
];
window.__opened = [];
window.addEventListener('conductor:focus-process', e => { window.__opened.push(e.detail) });
window.conductor = { memory: {
  list: async () => store.slice(),
  recall: async (p,q) => store.filter(m => (m.gist+' '+m.cues.join(' ')).toLowerCase().includes(q.toLowerCase())),
  remember: async (input) => { store = [base({...input, source:'human'}), ...store]; return store[0] },
  update: async (input) => { store = store.map(m => m.id === input.id ? {...m, ...input, cues: input.cues ?? m.cues, correctedAt:'2026-09-09T12:00:00.000Z'} : m); return store.find(m => m.id === input.id) },
  remove: async (id) => { store = store.filter(m => m.id !== id) },
  pruneCandidates: async () => rankMemoriesForPrune(store, Date.parse('2026-09-09T12:00:00.000Z')),
  turnRecalls: async () => []
} };
function App(){
  const [recall,setRecall]=useState({itemId:'item-1',agentSessionId:'agent-1',prompt:'Fix the checkout tax',createdAt:'2026-09-09T12:00:00.000Z',memories:[store[0],store[1]],forgotten:1});
  return <main style={{display:'flex',height:'100vh'}}>
    <div style={{width:460,display:'flex'}}><MemoryPane project={{id:'p',name:'conductor',path:'C:/Claude/conductor',createdAt:'',updatedAt:''}}/></div>
    <div className="structured-agent-pane" style={{flex:1,padding:24}}>
      <article className="sa-activity sa-kind-text sa-user"><span className="sa-role">You</span><p>Fix the checkout tax</p></article>
      <MemoryRecallStrip recall={recall} onChanged={async()=>{const all=await window.conductor.memory.list();setRecall(r=>({...r,memories:r.memories.map(m=>all.find(x=>x.id===m.id)).filter(Boolean)}))}}/>
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);`

const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: 'memory-curation-fixture',
  resolveId(id) { if (id === '/__memory-curation.tsx') return id },
  load(id) { if (id === '/__memory-curation.tsx') return fixture },
  configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__memory-curation') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__memory-curation.tsx"></script></body></html>'))
  }) }
}], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const output = resolve('artifacts/memory-curation')
await mkdir(output, { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0] + '__memory-curation')

  // Gap 1: provenance is legible, and the writing conversation is reachable.
  const agentMemory = page.locator('.memory-list article', { hasText: 'Checkout tax totals' })
  await expect(agentMemory.getByText('Agent', { exact: true })).toBeVisible()
  await expect(page.locator('.memory-list article', { hasText: 'Run npm.cmd' }).getByText('You', { exact: true })).toBeVisible()
  await expect(agentMemory.getByRole('button', { name: /Tax audit/ })).toBeVisible()
  await expect(page.locator('.memory-list article', { hasText: 'flaky deploy' }).getByText('conversation unknown')).toBeVisible()
  await agentMemory.getByRole('button', { name: /Tax audit/ }).click()
  if (JSON.stringify(await page.evaluate(() => window.__opened)) !== '[{"id":"agent-1","sessionId":"workspace-1"}]') throw new Error('Opening the writing conversation did not request the right tab')
  await page.screenshot({ path: resolve(output, 'provenance.png') })

  // Gap 2: an agent-written memory can be corrected and re-weighted by hand.
  await agentMemory.getByRole('button', { name: 'Edit and re-weight' }).click()
  await page.getByRole('textbox', { name: 'Memory gist' }).fill('Checkout tax totals are recalculated on every save')
  await page.getByRole('slider', { name: 'Salience' }).fill('0.9')
  await page.getByRole('slider', { name: 'Rehearsal' }).fill('6')
  await page.screenshot({ path: resolve(output, 'editing.png') })
  await page.getByRole('button', { name: 'Save correction' }).click()
  await expect(page.getByText('Checkout tax totals are recalculated on every save')).toBeVisible()
  await expect(page.locator('.memory-list article', { hasText: 'on every save' }).getByText('corrected')).toBeVisible()

  // The visible prune ranks what is decaying, and removes nothing on its own.
  await page.getByRole('button', { name: 'Review weakest' }).click()
  await expect(page.locator('.memory-prune article').first()).toContainText('Retried the flaky deploy once')
  await expect(page.locator('.memory-prune article').first()).toContainText(/Faded/)
  await expect(page.locator('.memory-prune article')).toHaveCount(3)
  await page.screenshot({ path: resolve(output, 'prune.png') })
  await page.locator('.memory-prune article', { hasText: 'flaky deploy' }).getByRole('button', { name: 'Forget' }).click()
  await expect(page.locator('.memory-prune article')).toHaveCount(2)
  await page.getByRole('button', { name: 'Back to all' }).click()

  // Gap 3: recall is visible on the turn it steered, and correctable from there.
  const strip = page.getByRole('button', { name: /Recalled 2 memories/ })
  await expect(strip).toContainText('1 since forgotten')
  await strip.click()
  await expect(page.locator('.sa-recall-item').first()).toContainText('Checkout tax totals')
  await page.locator('.sa-recall-item').first().getByRole('button', { name: 'Correct this memory' }).click()
  await page.getByRole('textbox', { name: 'Correct this memory' }).fill('Checkout tax totals are recalculated on submit')
  await page.getByRole('textbox', { name: 'Correct this memory' }).press('Enter')
  await expect(page.locator('.sa-recall-item').first()).toContainText('on submit')
  await page.screenshot({ path: resolve(output, 'recall.png') })

  if (errors.length) throw new Error('Renderer errors: ' + errors.join(' | '))
  console.log('memory curation smoke passed; screenshots in', output)
} finally {
  await browser.close()
  await server.close()
}
