import { describe, expect, it } from 'vitest'
import { conversationMarkdown, toolSubject } from './conversation-transcript'
import type { AgentEventData, TimelineItem } from './structured-agent'

let sequence = 0
const item = (data: AgentEventData): TimelineItem => ({ id: 'item-' + ++sequence, runtimeId: 'runtime', sequence, timestamp: '2026-09-24T00:00:00.000Z', data })
const text = (role: 'user' | 'assistant' | 'status', body: string): TimelineItem => item({ type: 'text', role, text: body, mode: 'snapshot' })

describe('conversation transcript', () => {
  it('writes user and assistant turns verbatim and summarizes tool calls on one line each', () => {
    const { markdown, messages } = conversationMarkdown([
      text('user', 'Fix the failing test\nin src/app.ts'),
      text('status', 'Thinking'),
      item({ type: 'tool', name: 'Bash', input: { command: 'npm test -- app' }, status: 'completed', exitCode: 1, output: 'FAIL src/app.test.ts\n'.repeat(50) }),
      item({ type: 'tool', name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, status: 'completed' }),
      text('assistant', 'Fixed: the guard was inverted.'),
      text('user', 'Thanks')
    ], { title: 'Fix test', assistant: 'Claude Code' })
    expect(messages).toBe(3)
    expect(markdown).toBe([
      '# Fix test',
      '## You', 'Fix the failing test\nin src/app.ts',
      '## Claude Code', '- `Bash` `npm test -- app` (exit 1)\n- `Edit` `src/app.ts`', 'Fixed: the guard was inverted.',
      '## You', 'Thanks'
    ].join('\n\n') + '\n')
    // Tool output never lands in a transcript; only the one-line summary does.
    expect(markdown).not.toContain('FAIL')
  })

  it('names dispatched prompts by their origin and keeps approvals, errors and attachments', () => {
    const prompt = item({ type: 'text', role: 'user', text: 'Review W3', mode: 'snapshot', origin: { agentSessionId: 'agent', label: 'Controller' }, attachments: [{ id: 'a', kind: 'file', name: 'notes.md' }] })
    const approval = item({ type: 'interaction', interaction: { id: 'r', kind: 'approval', title: 'Run `rm -rf out`', input: {}, choices: [], status: 'resolved', outcome: 'accept' } })
    const { markdown } = conversationMarkdown([prompt, approval, item({ type: 'error', message: 'Usage limit reached' })], { title: '', assistant: 'Codex', olderUnavailable: true })
    expect(markdown).toContain('_Earlier activity in this conversation is no longer stored._')
    expect(markdown).toContain('## Controller\n\nReview W3\n\n_Attached: notes.md_')
    expect(markdown).toContain('## Codex\n\n- Approval: Run `rm -rf out` → accept')
    expect(markdown).toContain('> **Error:** Usage limit reached')
  })

  it('fences commands that contain backticks', () => {
    const { markdown } = conversationMarkdown([item({ type: 'tool', name: 'Bash', input: { command: 'echo `date`' }, status: 'running' })], { title: 't', assistant: 'Claude Code' })
    expect(markdown).toContain('- `Bash` `` echo `date` `` (running)')
  })

  it('reads the subject a tool acted on', () => {
    const tool = (input: unknown, description?: string) => ({ type: 'tool' as const, name: 'X', input: input as never, status: 'completed' as const, description })
    expect(toolSubject(tool({ command: 'ls\n  -la' }))).toBe('ls -la')
    expect(toolSubject(tool({ pattern: 'TODO', path: 'src' }))).toBe('TODO')
    expect(toolSubject(tool({ query: 'retry budget' }))).toBe('retry budget')
    expect(toolSubject(tool({}, 'Explore the repo'))).toBe('Explore the repo')
  })
})
