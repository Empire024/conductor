import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedAgentEvent } from '../shared/models'
import {
  extractFileWorkSignals,
  signalsFromNormalizedEvent
} from './agent-collaboration-runtime'

const root = join('C:\\', 'work', 'conductor')

const event = (patch: Partial<NormalizedAgentEvent>): NormalizedAgentEvent => ({
  id: 'event-1',
  agentSessionId: 'agent-1',
  type: 'text',
  message: '',
  createdAt: '2026-09-06T12:00:00.000Z',
  ...patch
})

describe('agent collaboration runtime parsing', () => {
  it('extracts patch operations with write intent and deduplicates later mentions', () => {
    expect(extractFileWorkSignals(`
      *** Update File: src/main/agent-manager.ts
      Edited src/main/agent-manager.ts and then ran tests against src/main/agent-manager.ts:44
      *** Add File: src/main/new-worker.ts
      *** Delete File: src/main/old-worker.ts
    `, root)).toEqual([
      expect.objectContaining({ path: 'src/main/agent-manager.ts', intent: 'edit' }),
      expect.objectContaining({ path: 'src/main/new-worker.ts', intent: 'create' }),
      expect.objectContaining({ path: 'src/main/old-worker.ts', intent: 'delete' })
    ])
  })

  it('combines structured event metadata with shell output file mentions', () => {
    const signals = signalsFromNormalizedEvent(event({
      type: 'file_change',
      message: 'Updated the persistence layer and ran src/main/store.test.ts',
      metadata: { operation: 'updated', path: 'src/main/store.ts' }
    }), root)
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/main/store.ts', intent: 'edit' }),
      expect.objectContaining({ path: 'src/main/store.test.ts', intent: 'edit' })
    ]))
  })

  it('ignores generated dependencies and path-like text outside the project', () => {
    expect(extractFileWorkSignals(
      'Read ../other/secret.ts and updated node_modules/pkg/index.js',
      root
    )).toEqual([])
  })
})
