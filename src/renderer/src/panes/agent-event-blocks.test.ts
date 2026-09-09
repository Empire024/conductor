import { describe, expect, it } from 'vitest'
import type { NormalizedAgentEvent, NormalizedAgentEventType } from '../../../shared/models'
import {
  buildAgentVisualTimeline,
  normalizedEventToVisualBlock
} from './agent-event-blocks'

const makeEvent = (
  id: string,
  type: NormalizedAgentEventType,
  message: string,
  createdAt = '2026-09-06T12:00:00.000Z',
  metadata?: Record<string, unknown>
): NormalizedAgentEvent => ({
  id,
  agentSessionId: 'agent-1',
  type,
  message,
  metadata,
  createdAt
})

describe('normalizedEventToVisualBlock', () => {
  it('maps every normalized provider event to a stable visual kind and tone', () => {
    const expectations: Array<[NormalizedAgentEventType, string, string]> = [
      ['text', 'message', 'neutral'],
      ['activity', 'activity', 'working'],
      ['shell_command', 'command', 'working'],
      ['file_change', 'file', 'working'],
      ['tool_call', 'tool', 'working'],
      ['question', 'question', 'attention'],
      ['error', 'error', 'danger'],
      ['task_complete', 'completion', 'success'],
      ['artifact', 'artifact', 'success'],
      ['review_finding', 'finding', 'attention']
    ]
    for (const [type, kind, tone] of expectations) {
      expect(normalizedEventToVisualBlock(makeEvent(type, type, `${type} detail`))).toMatchObject({
        kind, tone, sourceEventIds: [type], occurrences: 1
      })
    }
    expect(normalizedEventToVisualBlock(makeEvent(
      'finding-high', 'review_finding', 'Unsafe write', undefined, { severity: 'high' }
    )).tone).toBe('danger')
  })

  it('surfaces commands, tool names, and clickable project file references', () => {
    const command = normalizedEventToVisualBlock(makeEvent(
      'command',
      'shell_command',
      'Ran tests for src/main/store.test.ts:18',
      undefined,
      { command: 'npm test' }
    ), 'C:\\work\\conductor')
    expect(command).toMatchObject({ command: 'npm test', title: 'npm test' })
    expect(command.files).toEqual([{ path: 'src/main/store.test.ts', line: 18 }])

    const file = normalizedEventToVisualBlock(makeEvent(
      'file',
      'file_change',
      'Saved renderer changes',
      undefined,
      { path: 'C:\\work\\conductor\\src\\renderer\\App.tsx', line: 44, column: 3, operation: 'updated' }
    ), 'C:\\work\\conductor')
    expect(file.title).toBe('Updated src/renderer/App.tsx')
    expect(file.files).toEqual([{ path: 'src/renderer/App.tsx', line: 44, column: 3 }])

    const tool = normalizedEventToVisualBlock(makeEvent(
      'tool', 'tool_call', 'Looked up symbols', undefined, { toolName: 'code_search' }
    ))
    expect(tool).toMatchObject({ tool: 'code_search', title: 'code_search' })
  })
})

describe('buildAgentVisualTimeline', () => {
  it('merges adjacent response chunks and coalesces repeated activity', () => {
    const timeline = buildAgentVisualTimeline([
      makeEvent('text-2', 'text', 'Second chunk', '2026-09-06T12:00:01.000Z'),
      makeEvent('text-1', 'text', 'First chunk', '2026-09-06T12:00:00.000Z'),
      makeEvent('activity-1', 'activity', 'Indexing project', '2026-09-06T12:00:03.000Z'),
      makeEvent('activity-2', 'activity', 'Indexing project', '2026-09-06T12:00:04.000Z')
    ])
    expect(timeline.blocks).toHaveLength(2)
    expect(timeline.blocks[0]).toMatchObject({
      kind: 'message', body: 'First chunk\nSecond chunk', occurrences: 2,
      sourceEventIds: ['text-1', 'text-2']
    })
    expect(timeline.blocks[1]).toMatchObject({
      kind: 'activity', occurrences: 2,
      sourceEventIds: ['activity-1', 'activity-2']
    })
  })

  it('retains the exact raw event input and transcript while deduplicating visual IDs only', () => {
    const first = makeEvent('same', 'text', 'Hello', '2026-09-06T12:00:00.000Z')
    const duplicate = makeEvent('same', 'text', 'Duplicate delivery', '2026-09-06T12:00:01.000Z')
    const question = makeEvent('question', 'question', 'Proceed?', '2026-09-06T12:00:02.000Z')
    const input = [question, first, duplicate]
    const transcript = '\u001b[32mraw provider output\u001b[0m'
    const timeline = buildAgentVisualTimeline(input, { rawTranscript: transcript })

    expect(timeline.raw.transcript).toBe(transcript)
    expect(timeline.raw.events).toEqual(input)
    expect(timeline.blocks).toHaveLength(2)
    expect(timeline.blocks.map((block) => block.kind)).toEqual(['message', 'question'])
    expect(timeline.blocks[0]?.body).toBe('Hello')
  })

  it('does not merge messages across an activity boundary or outside the merge window', () => {
    const timeline = buildAgentVisualTimeline([
      makeEvent('one', 'text', 'One', '2026-09-06T12:00:00.000Z'),
      makeEvent('activity', 'activity', 'Working', '2026-09-06T12:00:00.500Z'),
      makeEvent('two', 'text', 'Two', '2026-09-06T12:00:01.000Z'),
      makeEvent('three', 'text', 'Three', '2026-09-06T12:00:10.000Z')
    ])
    expect(timeline.blocks.map((block) => block.body)).toEqual(['One', 'Working', 'Two', 'Three'])
  })

  it('keeps a submitted user turn separate from the provider response', () => {
    const timeline = buildAgentVisualTimeline([
      makeEvent('user', 'text', 'Fix the failing test', '2026-09-06T12:00:00.000Z', { role: 'user' }),
      makeEvent('assistant', 'text', 'I found the cause.', '2026-09-06T12:00:00.100Z', { role: 'assistant' })
    ])

    expect(timeline.blocks).toHaveLength(2)
    expect(timeline.blocks[0]).toMatchObject({ label: 'You', title: 'You' })
    expect(timeline.blocks[1]).toMatchObject({ label: 'Response' })
  })

  it('coalesces four small successive edits to the same file into one inflated row instead of four near-identical ones', () => {
    const timeline = buildAgentVisualTimeline([
      makeEvent('edit-1', 'file_change', 'Updated src/app.ts', '2026-09-06T12:00:00.000Z', { path: 'src/app.ts', operation: 'updated' }),
      makeEvent('edit-2', 'file_change', 'Updated src/app.ts', '2026-09-06T12:00:00.500Z', { path: 'src/app.ts', operation: 'updated' }),
      makeEvent('edit-3', 'file_change', 'Updated src/app.ts', '2026-09-06T12:00:01.000Z', { path: 'src/app.ts', operation: 'updated' }),
      makeEvent('edit-4', 'file_change', 'Renamed a variable in src/app.ts', '2026-09-06T12:00:01.500Z', { path: 'src/app.ts', operation: 'updated' })
    ])
    expect(timeline.blocks).toHaveLength(1)
    expect(timeline.blocks[0]).toMatchObject({
      kind: 'file', occurrences: 4, body: 'Renamed a variable in src/app.ts',
      sourceEventIds: ['edit-1', 'edit-2', 'edit-3', 'edit-4']
    })
  })

  it('does not coalesce edits once agent commentary interrupts the run, and keeps different files separate', () => {
    const interrupted = buildAgentVisualTimeline([
      makeEvent('edit-1', 'file_change', 'Updated src/app.ts', '2026-09-06T12:00:00.000Z', { path: 'src/app.ts' }),
      makeEvent('note', 'text', 'Now checking the other file.', '2026-09-06T12:00:00.500Z'),
      makeEvent('edit-2', 'file_change', 'Updated src/app.ts', '2026-09-06T12:00:01.000Z', { path: 'src/app.ts' })
    ])
    expect(interrupted.blocks.map(block => block.kind)).toEqual(['file', 'message', 'file'])

    const differentFiles = buildAgentVisualTimeline([
      makeEvent('edit-1', 'file_change', 'Updated src/app.ts', '2026-09-06T12:00:00.000Z', { path: 'src/app.ts' }),
      makeEvent('edit-2', 'file_change', 'Updated src/other.ts', '2026-09-06T12:00:00.500Z', { path: 'src/other.ts' })
    ])
    expect(differentFiles.blocks).toHaveLength(2)
  })
  it('never merges two unrelated tool calls, whose only shared key is the tool name', () => {
    const timeline = buildAgentVisualTimeline([
      makeEvent('grep-1', 'tool_call', 'Grep for parsePriority', '2026-09-06T12:00:00.000Z', { tool: 'Grep' }),
      makeEvent('grep-2', 'tool_call', 'Grep for runtimeBanner', '2026-09-06T12:00:00.500Z', { tool: 'Grep' })
    ])
    // Merging these would silently replace the first search's title and body with the second's.
    expect(timeline.blocks).toHaveLength(2)
    expect(timeline.blocks.map(block => block.body)).toEqual(['Grep for parsePriority', 'Grep for runtimeBanner'])
  })
})
