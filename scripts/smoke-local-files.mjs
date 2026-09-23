import { _electron as electron, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import assert from 'node:assert/strict'

// Actual installed provider path, ordinary composer, no mock/local alternative, hidden window.
const output=resolve('artifacts/local-files/ui-'+Date.now())
const option=(name,fallback)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback
const inputs=resolve(option('inputs','artifacts/local-files/bounded-profile-1/workspace'))
await mkdir(output,{recursive:true})
const env={...process.env,CONDUCTOR_TEST_USER_DATA:join(output,'profile'),CONDUCTOR_PROJECTS_ROOT:join(output,'projects'),CONDUCTOR_BACKGROUND_WINDOWS:'1'}
if(option('docker',''))env.CONDUCTOR_DOCKER_PATH=option('docker','')
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_OFFLINE_TESTS
const app=await electron.launch({args:[resolve('out/main/index.js')],env,timeout:60000})
const started=Date.now(),checks=[]
try{
  const page=await app.firstWindow()
  await page.waitForFunction(()=>Boolean(window.conductor?.structured))
  const project=await page.evaluate(()=>window.conductor.projects.create('Local file acceptance'))
  // Only input bytes enter the project; no oracle, helper source, prior parser or answer.
  for(const name of ['data.txt','data2.txt'])await writeFile(join(project.path,name),await readFile(join(inputs,name)))
  await page.reload()
  await page.getByText('Local file acceptance',{exact:true}).first().click()
  await page.locator('.launcher-grid button').filter({hasText:'Ornith 1.5 9B'}).first().click()
  const pane=page.locator('.pane-tab-content:visible .structured-agent-pane').first()
  await pane.waitFor({timeout:30000})
  const id=await pane.getAttribute('data-structured-session')
  assert.ok(id)
  const visible=page.locator('.pane-tab-content:visible')
  const box=visible.getByRole('textbox',{name:/message/i})
  await expect(box).toBeEnabled({timeout:60000})
  await box.fill('Check data2.txt, find these payments in data.txt, and give me the exact payment dates for each.')
  await visible.getByRole('button',{name:'Send message',exact:true}).click()
  await expect.poll(()=>page.evaluate(id=>window.conductor.structured.snapshot(id).then(s=>s.phase),id),{timeout:30000}).toBe('running')
  // A renderer reattachment must not become a second submission or reset the task budget.
  await page.reload()
  await page.waitForFunction(()=>Boolean(window.conductor?.structured))
  await expect.poll(()=>page.evaluate(id=>window.conductor.structured.snapshot(id).then(s=>s.phase),id),{timeout:180000,intervals:[1000]}).toMatch(/completed|failed|interrupted/)
  const state=await page.evaluate(id=>window.conductor.structured.snapshot(id),id)
  await writeFile(join(output,'snapshot.json'),JSON.stringify(state,null,2))
  assert.equal(state.settings.model,'local/ornith1.5-9b')
  assert.equal(state.phase,'completed')
  const resultTool=state.items.findLast(i=>i.data.type==='tool'&&i.data.name==='process_files'&&i.data.status==='completed'&&i.data.output?.startsWith('{'))
  assert.ok(resultTool,'No validated artifact in normal UI timeline')
  const result=JSON.parse(resultTool.data.output).result
  assert.deepEqual(result.outcomes.map(o=>o.status),['matched','ambiguous','not_found','matched'])
  assert.equal(result.outcomes[0].candidates[0].values.date,'2026-04-23')
  assert.equal(result.outcomes[1].candidates.length,2)
  assert.equal(result.outcomes[3].candidates[0].values.date,'2026-04-25')
  const text=state.items.filter(i=>i.data.type==='text'&&i.data.role==='assistant').map(i=>i.data.text).join('')
  assert.match(text,/Validated 4 targets/)
  assert.equal(state.items.filter(i=>i.data.type==='text'&&i.data.role==='user').length,1)
  checks.push('Ordinary composer completed with four source-backed outcomes and zero false matches','Renderer reload during inference preserved the same task and one user submission','No cloud fallback or human continuation')
  await page.screenshot({path:join(output,'completed.png'),fullPage:true})
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,wallMs:Date.now()-started,checks},null,2))
  console.log(JSON.stringify({output,passed:true,checks}))
}finally{await app.close()}
