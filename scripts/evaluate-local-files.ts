/** Serial live evaluation of the actual provider adapter. No server is started by this script. */
import { LocalAdapter } from '../src/main/providers/local'
import { loadConfig, endpointFor, readApiKey } from '../src/main/local-models/config'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { generateBankFixture, generateInventoryFixture, inspectFixture, BANK_FIXTURE_ORACLE, INVENTORY_FIXTURE_ORACLE } from '../src/main/local-models/file-processing.fixtures'

const option = (name: string, fallback: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
if(process.argv.includes('--acceptance-batch')) {
  for(const [suffix,variant,segment] of [['1','principal',''],['2','principal',''],['3-segment','principal','1'],['heldout','heldout',''],['inventory','inventory',''],...(process.argv.includes('--markers')?[['markers','markers','']]:[])]) {
    const label=option('label','acceptance')+'-'+suffix
    const args=[process.argv[1]!,`--label=${label}`,`--variant=${variant}`,'--seconds=180',`--docker=${option('docker','')}`,...(segment?[`--segment=${segment}`]:[])]
    const run=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true,timeout:210000})
    if(run.error||run.status!==0)throw run.error??new Error(`Evaluation ${label} failed to run: ${run.status}`)
  }
  process.exit(0)
}
const label = option('label', 'baseline')
if(option('docker',''))process.env.CONDUCTOR_DOCKER_PATH=option('docker','')
const variant = option('variant', 'principal')
const fixture = variant === 'inventory' ? generateInventoryFixture() : generateBankFixture(variant === 'heldout' ? 'heldout' : 'principal')
const root = resolve('artifacts/local-files', label)
const workspace = resolve(option('workspace', join(root, 'workspace')))
await mkdir(workspace, { recursive: true })
await mkdir(root, { recursive: true })
if (!process.argv.some(v => v.startsWith('--workspace='))) {
  if(variant==='markers') {
    await writeFile(join(workspace,'probe.py'),`import sys\nprint('STDOUT_START_7319\\n' + 'X'*80000 + '\\nMIDDLE_EVIDENCE_9281\\n' + 'Y'*80000 + '\\nSTDOUT_END_4462')\nprint('STDERR_MARKER_5726',file=sys.stderr)\n`)
    await writeFile(join(workspace,'empty.py'),'pass\n')
  } else for(const input of fixture.inputs) await writeFile(join(workspace,input.role==='target'?'data2.txt':'data.txt'),input.bytes)
}
if(process.argv.includes('--prepare-only')) { console.log(workspace); process.exit(0) }
const stack = loadConfig(), model = stack.models['local/ornith1.5-9b']!
const headers = { Authorization: `Bearer ${readApiKey()}` }
const endpoint = endpointFor(model)
const health = await fetch(`${endpoint}/health`, { headers, signal: AbortSignal.timeout(4000) })
if (!health.ok) throw new Error(`Configured Ornith endpoint unavailable: HTTP ${health.status}`)
const slots = await fetch(`${endpoint}/slots`, { headers }).then(r => r.json()) as Array<{is_processing?:boolean}>
if (slots.some(s => s.is_processing)) throw new Error('Ornith is busy; live evaluations must run serially')
const props = await fetch(`${endpoint}/props`, { headers }).then(r => r.json())
await writeFile(join(root, 'settings.json'), JSON.stringify({ model, props }, null, 2))
const events: any[] = [], requests: any[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith('/v1/chat/completions') && typeof init?.body === 'string') requests.push(JSON.parse(init.body))
  return realFetch(input, init)
}
let settle!: () => void
const settled = new Promise<void>(r => { settle = r })
let began = false
const started = Date.now()
const settings = { permission: 'accept-edits' as const, plan: false, model: model.id }
let savedCheckpoint:unknown
const adapter = new LocalAdapter({ executable: '', cwd: workspace, runtimeId: randomUUID(), localTaskId:randomUUID(), localCheckpoint:{load:()=>savedCheckpoint,save:async value=>{savedCheckpoint=structuredClone(value);await writeFile(join(root,'checkpoint.json'),JSON.stringify(value))}}, settings, emit(event) {
  events.push(event)
  const d = event.data
  if (d.type === 'tool' && d.status !== 'running') console.log(JSON.stringify({tool:d.name,status:d.status,output:String(d.output).slice(0,200)}))
  if (d.type === 'session') { if(d.phase === 'running') began = true; else if(began && ['completed','failed','interrupted','waiting_input'].includes(d.phase)) settle() }
}, ...(option('segment','')?{localPolicy:{rounds:{hardLimit:Number(option('segment','')),softWarningAt:1,strongWarningAt:1,finishAt:1}}}:{}) })
const seconds=Number(option('seconds','240'))
if(!Number.isInteger(seconds)||seconds<5||seconds>600)throw new Error('seconds must be 5..600')
const timer = setTimeout(() => { void adapter.interrupt() }, seconds * 1000)
try {
  await adapter.start()
  const promptFile = option('prompt-file', '')
  const prompt = promptFile ? await readFile(resolve(promptFile), 'utf8') : variant==='markers'?'Run probe.py using the run_command saved-script form with python3. Its output is deliberately large: retrieve the middle near byte offset 80000 using the returned artifact handle. Then run empty.py using python3. Report the stdout/stderr markers you actually received and whether the second program produced empty output. Do not edit either script.':variant==='inventory'?'Check data2.txt against the inventory in data.txt and report the stock quantity for each request.': 'Check data2.txt, find these payments in data.txt, and give me the exact payment dates for each.'
  await adapter.submit(prompt, settings)
  await settled
  const processing=events.findLast(e=>e.data.type==='tool'&&e.data.name==='process_files'&&e.data.status==='completed'&&String(e.data.output).startsWith('{'))
  let correctness:any={passed:false,reason:'No validated structured result',falseMatches:0,unresolved:null}
  if(variant==='markers') {
    const payloads=requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content)) as string[]
    const checks={stdout:payloads.some(p=>p.includes('STDOUT_START_7319')&&p.includes('STDOUT_END_4462')),stderr:payloads.some(p=>p.includes('STDERR_MARKER_5726')),retrievedMiddle:payloads.some(p=>p.includes('MIDDLE_EVIDENCE_9281')),empty:payloads.some(p=>p.includes('payload_started=true; stdout_empty=true; stderr_empty=true; exit_code=0')),artifact:payloads.some(p=>p.includes('[result_artifact:')),status:payloads.some(p=>p.includes('exit_code=0; timed_out=false; cancelled=false'))}
    correctness={passed:Object.values(checks).every(Boolean),checks}
  }
  if(processing&&!process.argv.some(v=>v.startsWith('--workspace='))) {
    const result=JSON.parse(processing.data.output).result
    const independent=inspectFixture(fixture)
    const oracle=variant==='inventory'?INVENTORY_FIXTURE_ORACLE:BANK_FIXTURE_ORACLE
    const mismatches:string[]=[]
    for(const [id,expected] of Object.entries(oracle)) {
      const outcome=result.outcomes.find((o:any)=>o.targetId===id)
      if(!outcome||outcome.status!==expected.status){mismatches.push(`${id}: wrong or missing status`);continue}
      const found=outcome.candidates.map((c:any)=>independent.inspections.find(i=>i.role==='source')!.records.find(r=>r.ref.start===c.ref.start&&r.ref.end===c.ref.end&&r.ref.sha256===c.ref.sha256)).filter(Boolean)
      const expectedIds='transactions' in expected?expected.transactions:expected.lots
      const ids=found.map((r:any)=>r.values.transaction??r.values.lot).sort()
      if(JSON.stringify(ids)!==JSON.stringify([...expectedIds].sort()))mismatches.push(`${id}: wrong source records`)
      if('sourceDates' in expected&&JSON.stringify(outcome.candidates.map((c:any)=>c.values.date??c.values.postingDate??c.values.valueDate).sort())!==JSON.stringify([...expected.sourceDates].sort()))mismatches.push(`${id}: wrong dates`)
    }
    if(result.outcomes.length!==Object.keys(oracle).length)mismatches.push('Target cardinality mismatch')
    correctness={passed:mismatches.length===0,mismatches,falseMatches:result.outcomes.filter((o:any)=>o.status==='matched'&&mismatches.some(m=>m.startsWith(o.targetId+':'))).length,unresolved:result.outcomes.filter((o:any)=>['ambiguous','blocked'].includes(o.status)).length}
  }
  const summary = { label,variant,correctness,manualInterventions:0, wallMs: Date.now()-started, modelCalls:requests.length, toolCalls:events.filter(e=>e.data.type==='tool'&&e.data.status==='running').length, inputTokens:events.filter(e=>e.data.type==='usage').reduce((n,e)=>n+(e.data.inputTokens??0),0), outputTokens:events.filter(e=>e.data.type==='usage').reduce((n,e)=>n+(e.data.outputTokens??0),0),peakContext:Math.max(0,...events.filter(e=>e.data.type==='usage').map(e=>e.data.inputTokens??0)), stop:events.findLast(e=>e.data.payload?.localStop)?.data.payload.localStop, state:adapter.runStatus(), phase:events.findLast(e=>e.data.type==='session')?.data.phase }
  await writeFile(join(root, 'events.json'), JSON.stringify(events,null,2))
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests,null,2))
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary,null,2))
  console.log(JSON.stringify({label,correctness,wallMs:summary.wallMs,modelCalls:summary.modelCalls,toolCalls:summary.toolCalls,inputTokens:summary.inputTokens,outputTokens:summary.outputTokens,peakContext:summary.peakContext,stop:summary.stop?{reason:summary.stop.reason,rounds:summary.stop.rounds,compactions:summary.stop.compactions,task:summary.stop.task}:undefined,phase:summary.phase}))
} finally { clearTimeout(timer); await adapter.stop(); globalThis.fetch=realFetch }
