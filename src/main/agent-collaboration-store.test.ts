import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSpec } from '../shared/models'
import { ConductorDatabase } from './database'
import {
  AgentCollaborationStore,
  conflictSeverity,
  normalizeCollaborationPath
} from './agent-collaboration-store'

interface CollaborationFixture {
  store: AgentCollaborationStore
  path: string
  projectId: string
  projectRoot: string
  first: AgentSpec
  second: AgentSpec
  outsider: AgentSpec
}

const withCollaboration = (run: (fixture: CollaborationFixture) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-collaboration-test-'))
  const path = join(root, 'conductor.db')
  const database = new ConductorDatabase(path)
  const projectRoot = join(root, 'project')
  const project = database.upsertProject(projectRoot, 'Project')
  const firstSession = database.listSessions(project.id)[0]!
  const secondSession = database.createSession(project.id, 'Parallel workspace')
  const otherProject = database.upsertProject(join(root, 'other-project'), 'Other project')
  const otherSession = database.listSessions(otherProject.id)[0]!
  const first: AgentSpec = {
    id: 'agent-first', projectId: project.id, sessionId: firstSession.id,
    provider: 'codex', title: 'Builder', cwd: projectRoot
  }
  const second: AgentSpec = {
    id: 'agent-second', projectId: project.id, sessionId: secondSession.id,
    provider: 'claude', title: 'Reviewer', cwd: projectRoot
  }
  const outsider: AgentSpec = {
    id: 'agent-outsider', projectId: otherProject.id, sessionId: otherSession.id,
    provider: 'qwen', title: 'Outsider', cwd: join(root, 'other-project')
  }
  database.upsertAgent(first, 'running')
  database.upsertAgent(second, 'running')
  database.upsertAgent(outsider, 'running')
  const store = new AgentCollaborationStore(path)
  try {
    run({ store, path, projectId: project.id, projectRoot, first, second, outsider })
  } finally {
    store.close()
    database.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

describe('AgentCollaborationStore', () => {
  it('coordinates exclusive file leases across workspaces in the same project', () => {
    withCollaboration(({ store, projectId, first, second }) => {
      const firstLease = store.announcePresence({
        projectId,
        sessionId: first.sessionId,
        agentSessionId: first.id,
        path: 'src/payment.ts',
        intent: 'edit'
      })
      expect(firstLease.granted).toBe(true)

      const collision = store.announcePresence({
        projectId,
        sessionId: second.sessionId,
        agentSessionId: second.id,
        path: './src/payment.ts:42',
        intent: 'edit'
      })
      expect(collision.granted).toBe(false)
      expect(collision.presence.state).toBe('blocked')
      expect(collision.conflicts).toHaveLength(1)
      expect(collision.conflicts[0]).toMatchObject({
        path: 'src/payment.ts', severity: 'blocking'
      })
      expect(collision.conflicts[0]?.presence.sessionId).toBe(first.sessionId)

      const projectPresence = store.listPresence({ projectId })
      expect(projectPresence.map((presence) => presence.agentSessionId)).toEqual(
        expect.arrayContaining([first.id, second.id])
      )
      expect(store.listPresence({ projectId, sessionId: first.sessionId })).toHaveLength(1)

      store.releasePresence(first.id, 'src/payment.ts')
      const claimed = store.announcePresence({
        projectId,
        sessionId: second.sessionId,
        agentSessionId: second.id,
        path: 'src/payment.ts',
        intent: 'edit'
      })
      expect(claimed.granted).toBe(true)
      expect(claimed.presence.state).toBe('active')
    })
  })

  it('allows reads with an advisory warning and keeps projects isolated', () => {
    withCollaboration(({ store, projectId, first, second, outsider }) => {
      store.announcePresence({
        projectId,
        sessionId: first.sessionId,
        agentSessionId: first.id,
        path: 'src/index.ts',
        intent: 'edit'
      })
      const read = store.announcePresence({
        projectId,
        sessionId: second.sessionId,
        agentSessionId: second.id,
        path: 'src/index.ts',
        intent: 'view'
      })
      expect(read.granted).toBe(true)
      expect(read.conflicts[0]?.severity).toBe('advisory')
      expect(() => store.detectConflicts({
        projectId,
        agentSessionId: outsider.id,
        path: 'src/index.ts',
        intent: 'edit'
      })).toThrow('does not belong to this project')
    })
  })

  it('persists structured messages and builds a cross-workspace coworker briefing', () => {
    withCollaboration(({ store, path, projectId, first, second, outsider }) => {
      store.announcePresence({
        projectId,
        sessionId: first.sessionId,
        agentSessionId: first.id,
        path: 'src/release.ts',
        intent: 'edit',
        detail: 'Preparing release validation'
      })
      store.postMessage({
        projectId,
        sessionId: first.sessionId,
        agentSessionId: first.id,
        kind: 'handoff',
        body: 'The migration is ready for review.',
        paths: ['src/release.ts']
      })
      expect(() => store.postMessage({
        projectId,
        sessionId: first.sessionId,
        agentSessionId: first.id,
        toAgentSessionId: outsider.id,
        kind: 'question',
        body: 'This must not cross projects.'
      })).toThrow('cannot cross projects')

      const briefing = store.buildBriefing(second.id)
      expect(briefing).toContain('project-wide')
      expect(briefing).toContain('src/release.ts')
      expect(briefing).toContain('another workspace')
      expect(briefing).toContain('migration is ready for review')
      expect(store.listMessages({ projectId, sessionId: second.sessionId })).toEqual([])
      expect(store.listMessages({ projectId, agentSessionId: second.id })).toHaveLength(1)

      const reopened = new AgentCollaborationStore(path)
      try {
        expect(reopened.listMessages({ projectId })[0]).toMatchObject({
          kind: 'handoff', paths: ['src/release.ts']
        })
        expect(reopened.listPresence({ projectId })).toHaveLength(1)
      } finally {
        reopened.close()
      }
    })
  })
})

describe('collaboration path and conflict helpers', () => {
  it('normalizes project paths and rejects traversal', () => {
    const root = join('C:\\', 'work', 'project')
    expect(normalizeCollaborationPath(root, './src/app.ts:12:4')).toBe('src/app.ts')
    expect(() => normalizeCollaborationPath(root, '../secret.txt')).toThrow('outside the project')
  })

  it('only makes overlapping writers blocking', () => {
    expect(conflictSeverity('view', 'execute')).toBeNull()
    expect(conflictSeverity('view', 'edit')).toBe('advisory')
    expect(conflictSeverity('delete', 'edit')).toBe('blocking')
  })
})
