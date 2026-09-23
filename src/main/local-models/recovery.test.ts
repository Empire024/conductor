import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession } from './agent'
import { runtimePromptTokens } from './client'
import { StagnationDetector } from './progress'
import { DEFAULT_LOCAL_AGENT_POLICY } from './agent-policy'
import { defaultResultStore } from './result-artifacts'

const cleanup:Array<()=>void>=[]
afterEach(()=>{cleanup.splice(0).forEach(f=>f());vi.restoreAllMocks()})
function workspace(){const p=mkdtempSync(join(tmpdir(),'local-recovery-'));cleanup.push(()=>rmSync(p,{recursive:true,force:true}));for(let n=0;n<8;n++)writeFileSync(join(p,`${n}.txt`),`evidence ${n}: 23.04.2026 85 000,00 CZK\n`);return p}
async function endpoint(reply:(n:number,body:any)=>any){const requests:any[]=[];const server=createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{const parsed=JSON.parse(body);const message=reply(requests.length,parsed);requests.push(parsed);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:message,finish_reason:message.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)})});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>server.close());return{url:`http://127.0.0.1:${(server.address() as any).port}`,requests}}
const call=(n:number,name='read_file',args:any={path:`${n}.txt`})=>({tool_calls:[{index:0,id:`call-${n}`,function:{name,arguments:JSON.stringify(args)}}]})
const options=(url:string,root:string)=>({endpoint:url,apiKey:'k'.repeat(64),model:'local/ornith1.5-9b',workspace:root,sandbox:null,readOnly:true,timeoutSec:5,contextTokens:32768,policy:{rounds:{softWarningAt:1,strongWarningAt:1,finishAt:2,hardLimit:2},task:{maxRounds:8,maxRequests:12,maxRecoveries:3,maxMilliseconds:10000}}})

describe('durable local task recovery',()=>{
  it('preserves raw evidence and processing scope through compaction and malformed-plan repair',async()=>{
    const root=workspace()
    writeFileSync(join(root,'data2.txt'),'id\tsku\twarehouse\nrequest\tA-100\tBrno\n')
    writeFileSync(join(root,'data.txt'),'lot\tsku\twarehouse\tquantity\nlot-1\tA-100\tBrno\t12\n')
    vi.spyOn(defaultResultStore,'save').mockReturnValue('00000000-0000-4000-8000-000000000001')
    const s=await endpoint(n=>n<2?call(n,'read_file',{path:n===0?'data2.txt':'data.txt',mode:'inspect'}):call(n,'process_files',{target:'data2.txt',source:'data.txt',...(n===2?{plan:{}}:{})}))
    const session=new LocalAgentSession({...options(s.url,root),readOnly:false})
    const result=await session.run('Check data2.txt against inventory in data.txt.',{})
    expect(result.stopReason).toBe('completed');expect(result.text).toContain('Validated 1 targets')
    expect(result.report.task?.recoveries).toBeGreaterThan(0)
    for(const request of s.requests)expect(request.tools.map((t:any)=>t.function.name)).not.toContain('run_command')
    expect(session.state()?.execution?.observations.some(o=>o.rawSample?.includes('A-100'))).toBe(true)
    expect(JSON.stringify(s.requests.at(-1))).toContain('A-100')
  })
  it('continues across segments automatically with paired results, evidence and cumulative budgets',async()=>{
    const root=workspace(),s=await endpoint(n=>n<5?call(n):{content:'Done from source evidence.'});let saved:any
    for(let n=0;n<5;n++)writeFileSync(join(root,`${n}.txt`),`evidence ${n}: 23.04.2026 85 000,00 CZK\n`.repeat(500))
    const session=new LocalAgentSession({...options(s.url,root),taskId:'owned',checkpoint:{load:()=>saved,save:async v=>{saved=structuredClone(v)}}})
    const result=await session.run('Read the five files and report.',{})
    expect(result.stopReason).toBe('completed');expect(s.requests).toHaveLength(6)
    expect(result.report.task).toMatchObject({requests:6,recoveries:2})
    expect(saved.state.execution.observations.some((o:any)=>o.excerpt.includes('23.04.2026'))).toBe(true)
    expect(result.report.compactions).toBeGreaterThan(0)
    for(const request of s.requests)for(const m of request.messages.filter((m:any)=>m.role==='tool'))expect(request.messages.some((a:any)=>a.tool_calls?.some((c:any)=>c.id===m.tool_call_id))).toBe(true)
    expect(saved.state.execution.budgets.rounds).toBe(5)
  })
  it('charges continuation and retries to the total budget and emits a deterministic blocker',async()=>{
    const s=await endpoint(n=>call(n)),root=workspace()
    const base=options(s.url,root);base.policy.task.maxRounds=3
    const session=new LocalAgentSession(base),result=await session.run('Read everything.',{})
    expect(s.requests).toHaveLength(3);expect(result.stopReason).toBe('round_limit')
    expect(result.text).toContain('cumulative limit of 3');expect(result.report.task?.recoveries).toBe(1)
  })
  it('allows one bounded repair segment after a new tool error and then stops if no evidence appears',async()=>{
    const root=workspace(),s=await endpoint(n=>n===0?call(0):call(n,'read_file',{path:'missing.txt'}))
    const base=options(s.url,root);base.policy.rounds={softWarningAt:1,strongWarningAt:1,finishAt:1,hardLimit:1}
    const result=await new LocalAgentSession(base).run('Read the files.',{})
    expect(result.stopReason).toBe('stagnation');expect(s.requests).toHaveLength(3)
    expect(result.report.task?.recoveries).toBe(2)
  })
  it('never replays a mutation whose result checkpoint failed',async()=>{
    const root=workspace(),s=await endpoint(n=>call(n,'write_file',{path:'once.txt',content:'one\n',append:true}));let saved:any
    const checkpoint={load:()=>saved,save:async(v:any)=>{if(v.messages.some((m:any)=>m.role==='tool'))throw new Error('disk full');saved=structuredClone(v)}}
    const opts={...options(s.url,root),taskId:'durable',readOnly:false,checkpoint}
    const first=await new LocalAgentSession(opts).run('Append one line.',{})
    expect(first.stopReason).toBe('provider_error');expect(readFileSync(join(root,'once.txt'),'utf8')).toBe('one\n')
    const second=await new LocalAgentSession(opts).run('continue',{})
    expect(second.stopReason).not.toBe('completed');expect(s.requests).toHaveLength(1)
    expect(readFileSync(join(root,'once.txt'),'utf8')).toBe('one\n')
    expect(second.text).toMatch(/checkpoint|interrupted|replayed/)
  })
  it('does not execute a repeated provider call identity twice',async()=>{
    const root=workspace(),s=await endpoint(n=>n<2?call(0,'write_file',{path:'once.txt',content:'one\n',append:true}):{content:'Stopped after the recorded append.'})
    const session=new LocalAgentSession({...options(s.url,root),readOnly:false})
    await session.run('Append one line.',{})
    expect(readFileSync(join(root,'once.txt'),'utf8')).toBe('one\n')
    expect(JSON.stringify(s.requests.at(-1))).toContain('no mutation was replayed')
  })
  it('cancellation never automatically continues or runs a queued second mutation',async()=>{
    const root=workspace(),s=await endpoint(n=>call(n,'write_file',{path:'once.txt',content:'one\n',append:true})),abort=new AbortController()
    const session=new LocalAgentSession({...options(s.url,root),readOnly:false})
    const outcome=await session.run('Append one line.',{toolEnd:()=>abort.abort()},abort.signal)
    expect(outcome.stopReason).toBe('interrupted');expect(s.requests).toHaveLength(1)
    expect(session.state()?.execution?.lifecycle).toBe('cancelled')
  })
  it('restores user corrections and source observations before another request',async()=>{
    const root=workspace(),s=await endpoint(n=>n===0?call(0):{content:'done'});let saved:any
    const opts={...options(s.url,root),taskId:'same',checkpoint:{load:()=>saved,save:async(v:any)=>{saved=structuredClone(v)}}}
    await new LocalAgentSession(opts).run('Inspect the original objective.',{})
    saved.state.execution.lifecycle='blocked';saved.state.execution.corrections=['Invoice date is not payment date.'];saved.state.execution.budgets.startedAt=Date.now()
    const restored=new LocalAgentSession(opts);restored.compactNow()
    await restored.run('Use the correction and finish.',{})
    expect(JSON.stringify(s.requests.at(-1))).toContain('Invoice date is not payment date')
    expect(JSON.stringify(s.requests.at(-1))).toContain('23.04.2026')
  })
  it('detects alternating stale-anchor failures without treating script rewrites as progress',()=>{
    const detector=new StagnationDetector(DEFAULT_LOCAL_AGENT_POLICY.stagnation)
    let verdict:any
    for(let n=0;n<6;n++) {verdict=detector.observe({name:'edit_file',arguments:{path:'parser.py',old_text:`anchor${n}`},output:'old_text not found',failed:true,analysis:true});detector.observe({name:'write_file',arguments:{path:'probe.py',content:`probe${n}`},output:'written',failed:false,analysis:true})}
    expect(verdict.action).toBe('stop')
  })
})

it('counts the complete server-rendered request with the runtime tokenizer',async()=>{
  const paths:string[]=[]
  const server=createServer((req,res)=>{paths.push(req.url!);let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const body=JSON.parse(raw);res.setHeader('Content-Type','application/json');if(req.url==='/apply-template'){expect(body.tools[0].function.name).toBe('read_file');res.end(JSON.stringify({prompt:'framed tool schema and content'}))}else{expect(body.content).toBe('framed tool schema and content');res.end(JSON.stringify({tokens:[1,2,3,4,5]}))}})})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>server.close())
  const count=await runtimePromptTokens({endpoint:`http://127.0.0.1:${(server.address() as any).port}`,apiKey:'k',model:'local',messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'read_file',description:'read',parameters:{}}}],measureTokens:true})
  expect(count).toBe(5);expect(paths).toEqual(['/apply-template','/tokenize'])
})
