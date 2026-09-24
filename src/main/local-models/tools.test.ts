import { describe, expect, it } from 'vitest'
import { LOCAL_CONTROL_METHODS, ToolPolicyError, assertLocalControlAllowed, toolSpecs } from './tools'

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
    expect(() => assertLocalControlAllowed('agents.report', { text: 'x' }, true)).toThrow(/unavailable in this mode/)
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
