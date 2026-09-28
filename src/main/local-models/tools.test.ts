import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { LOCAL_CONTROL_METHODS, ToolPolicyError, assertLocalControlAllowed, runTool, toolSpecs } from './tools'
import { resetPageStore } from './web.ts'
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

describe('web_read continuation copies stay in their own conversation', () => {
  beforeEach(() => { resetPageStore(); vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never) })
  afterEach(() => vi.resetAllMocks())
  const page = `<main>${Array.from({ length: 30 }, (_, index) => `<p>Section ${index}: ${'Ordinary text. '.repeat(60)}</p>`).join('')}</main>`
  function serve(): void {
    vi.mocked(request).mockImplementationOnce(((_url: unknown, _options: unknown, done: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end(): void }
      req.end = () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' }, destroy() {} })
        queueMicrotask(() => { done(res); res.emit('data', Buffer.from(page)); res.emit('end') })
      }
      return req
    }) as never)
  }
  const read = (url: string, taskId: string) => runTool('web_read', JSON.stringify({ url }), { workspace: process.cwd(), readOnly: true, sandbox: null, timeoutSec: 10, taskId })
  it('serves a conversation its own copy and makes another read the public page again', async () => {
    serve()
    const first = await read('https://docs.example/guide', 'agent_conversation_a')
    expect(first.failed).toBe(false)
    const next = /web_read url="([^"]+)"/.exec(first.output)![1]!
    expect((await read(next, 'agent_conversation_a')).output).toContain('the same copy as the first page')
    expect(request).toHaveBeenCalledTimes(1)
    serve()
    expect((await read(next, 'agent_conversation_b')).output).toContain('read again and unchanged')
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('agents.report over the local control bridge', () => {
  it('is discoverable and allows only a bounded text field', () => {
    expect(LOCAL_CONTROL_METHODS).toContain('agents.report')
    expect(() => assertLocalControlAllowed('agents.report', { text: 'UPDATE OK 1.2.3' }, false)).not.toThrow()
    expect(() => assertLocalControlAllowed('agents.report', { text: 'x', agentSessionId: 'forged' }, false)).toThrow(ToolPolicyError)
    expect(() => assertLocalControlAllowed('agents.report', { text: '' }, false)).toThrow(/text/)
    expect(() => assertLocalControlAllowed('agents.report', { text: 'x'.repeat(2001) }, false)).toThrow(/2000/)
    expect(() => assertLocalControlAllowed('agents.report', { text: 'x'.repeat(2000) }, false)).not.toThrow()
  })

  it('is refused in read-only mode, like the other methods that write something durable', () => {
    expect(() => assertLocalControlAllowed('agents.report', { text: 'x' }, true)).toThrow('"agents.report" changes something and this turn is read-only')
  })

  it('is offered to a local model whose conversation bridges Conductor control', () => {
    const conductorTool = toolSpecs(false, true).find(spec => spec.function.name === 'conductor')!
    expect(conductorTool.function.description).toContain('agents.report')
    const enumValues = (conductorTool.function.parameters!.properties as { method: { enum: string[] } }).method.enum
    expect(enumValues).toContain('agents.report')
    const readOnlyTool = toolSpecs(true, true).find(spec => spec.function.name === 'conductor')!
    expect((readOnlyTool.function.parameters!.properties as { method: { enum: string[] } }).method.enum).not.toContain('agents.report')
  })
})

describe('local control refusals say what would work (H19)', () => {
  it('names a method outside the allowlist and lists the ones this turn may call', () => {
    expect(() => assertLocalControlAllowed('git.ship', {}, false)).toThrow(`"git.ship" is not a Conductor method a local model may call; these are: ${LOCAL_CONTROL_METHODS.join(', ')}.`)
    const readOnly = (() => { try { assertLocalControlAllowed('git.ship', {}, true) } catch (error) { return (error as Error).message } return '' })()
    expect(readOnly).toContain('memory.recall')
    expect(readOnly).not.toContain('tabs.open')
  })
  it('tells a read-only turn that a writing method cannot run, not that it does not exist', () => {
    expect(() => assertLocalControlAllowed('tasks.update', { id: 't', status: 'done' }, true)).toThrow(/"tasks.update" changes something and this turn is read-only.*Do not call it again this turn/)
  })
  it('names the refused key and the keys the method takes', () => {
    expect(() => assertLocalControlAllowed('memory.recall', { query: 'x', projectId: 'p' }, false)).toThrow('memory.recall does not take projectId; it takes query. projectId, workspaceId and agentId come from your session and cannot be passed.')
    expect(() => assertLocalControlAllowed('tasks.list', { limit: 5 }, false)).toThrow('tasks.list does not take limit; it takes no arguments, so pass {}.')
  })
})
