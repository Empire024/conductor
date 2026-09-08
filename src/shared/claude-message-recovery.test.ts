import { expect, it } from 'vitest'
import type { TimelineItem } from './structured-agent'
import { recoverClaudeMessageDuplicates } from './claude-message-recovery'
const item = (id: string, mode: 'delta' | 'snapshot', turnId = 'turn'): TimelineItem => ({ id, nativeItemId: id, runtimeId: 'runtime', turnId, sequence: 1, timestamp: '', data: { type: 'text', role: 'assistant', mode, text: 'Same visible words' } })
it('repairs the historical hidden-thinking offset without collapsing repeated messages or snapshot blocks', () => {
  const final = item('msg_a:0', 'snapshot'), otherTurn = item('msg_a:1', 'delta', 'other-turn'), repeatedBlock = item('msg_a:2', 'snapshot'), otherMessage = item('msg_b:1', 'delta')
  expect(recoverClaudeMessageDuplicates([item('msg_a:1', 'delta'), final, otherTurn, repeatedBlock, otherMessage])).toEqual([final, otherTurn, repeatedBlock, otherMessage])
})
