import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'

describe('process board database window', () => {
  it('returns only recent and active rows across projects, while explicit project reads can load older work', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-process-board-'))
    const path = join(root, 'conductor.db')
    const database = new ConductorDatabase(path)
    try {
      const project = database.upsertProject(join(root, 'project'), 'Project')
      const session = database.listSessions(project.id)[0]!
      const addAgent = (id: string, status: 'running' | 'complete') => database.upsertAgent({
        id, projectId: project.id, sessionId: session.id, provider: 'codex', title: id, cwd: project.path
      }, status)
      addAgent('old-settled', 'complete')
      addAgent('old-live', 'running')
      addAgent('recent-settled', 'complete')
      database.setAgentStatus('old-live', 'running', 'working')

      const old = '2026-01-01T00:00:00.000Z'
      const raw = new DatabaseSync(path)
      try { raw.prepare("UPDATE agent_sessions SET updated_at=? WHERE id IN ('old-settled','old-live')").run(old) }
      finally { raw.close() }

      expect(database.listProcesses().map(process => process.id).sort()).toEqual(['old-live', 'recent-settled'])
      expect(database.listProcesses(project.id).map(process => process.id).sort()).toEqual(['old-live', 'old-settled', 'recent-settled'])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
  })
})
