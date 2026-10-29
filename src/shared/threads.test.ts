import { describe, expect, it } from 'vitest'
import type { PhoneSessionSummary } from './phone-access'
import { buildThreadView, draftThreadHandoff, HANDOFF_CHARS_PER_MESSAGE, HANDOFF_MAX_CHARS, readGeneralAnchor, threadAge, threadBucket, threadStateLabel } from './threads'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

let counter = 0
const session = (fields: Partial<PhoneSessionSummary> = {}): PhoneSessionSummary => {
  counter += 1
  return {
    id: `agent_${counter}`, projectId: 'project_a', projectName: 'Alpha', workspaceId: 'ws_a', workspaceName: 'Workspace',
    tabId: `pane_${counter}`, title: `Thread ${counter}`, provider: 'claude', machineId: 'local', machineName: 'MAIN',
    phase: 'idle', activity: 'idle', state: 'idle', needs: null, updatedAt: ago(5), queued: 0, archived: false, ...fields
  }
}

describe('buildThreadView', () => {
  it('groups open threads by what needs the owner, then work, then recency, newest first', () => {
    const asks = session({ state: 'attention', needs: 'approval', updatedAt: ago(30) })
    const failed = session({ state: 'failed', updatedAt: ago(10) })
    const running = session({ state: 'working', updatedAt: ago(1) })
    const limited = session({ state: 'limited', updatedAt: ago(2) })
    const fresh = session({ state: 'done', updatedAt: ago(3) })
    const older = session({ state: 'idle', updatedAt: ago(4) })
    const old = session({ state: 'done', updatedAt: ago(60 * 30) })
    const view = buildThreadView([old, older, fresh, limited, running, failed, asks], { generalProjectId: null, now: NOW })
    expect(view.groups.map(group => [group.bucket, group.threads.map(thread => thread.id)])).toEqual([
      ['needs-you', [failed.id, asks.id]],
      ['working', [running.id, limited.id]],
      ['recent', [fresh.id, older.id]],
      ['earlier', [old.id]]
    ])
    expect(view.total).toBe(7)
    expect(view.hidden).toBe(0)
  })

  it('lists only open, unarchived conversations and names General threads as such', () => {
    const general = session({ projectId: 'project_general', projectName: 'General' })
    const closed = session({ tabId: null })
    const archived = session({ archived: true })
    const view = buildThreadView([general, closed, archived], { generalProjectId: 'project_general', now: NOW })
    const listed = view.groups.flatMap(group => group.threads)
    expect(listed.map(thread => thread.id)).toEqual([general.id])
    expect(listed[0]!.general).toBe(true)
    expect(buildThreadView([general], { generalProjectId: null, now: NOW }).groups[0]!.threads[0]!.general).toBe(false)
  })

  it('folds a swarm under its controller but always lists a coworker that needs the owner', () => {
    const controller = session({ title: 'Controller', state: 'working' })
    const quiet = Array.from({ length: 20 }, () => session({ controllerId: controller.id, state: 'working' }))
    const stuck = session({ controllerId: controller.id, state: 'attention', needs: 'question' })
    const orphan = session({ controllerId: 'agent_closed_controller', state: 'done' })
    const view = buildThreadView([controller, ...quiet, stuck, orphan], { generalProjectId: null, now: NOW })
    const listed = view.groups.flatMap(group => group.threads)
    expect(listed.map(thread => thread.id).sort()).toEqual([controller.id, stuck.id, orphan.id].sort())
    expect(listed.find(thread => thread.id === controller.id)!.coworkers).toBe(20)
    expect(view.total).toBe(3)
  })

  it('puts a wizard first in its group, filters by words across title, project and last message, and caps rows', () => {
    const plain = session({ title: 'Fix the parser', updatedAt: ago(1), lastText: 'grammar repaired' })
    const wizard = session({ title: 'Orchestrator', wizard: true, updatedAt: ago(9), projectName: 'Conductor' })
    expect(buildThreadView([plain, wizard], { generalProjectId: null, now: NOW }).groups[0]!.threads.map(thread => thread.id)).toEqual([wizard.id, plain.id])
    expect(buildThreadView([plain, wizard], { generalProjectId: null, now: NOW, query: 'GRAMMAR fix' }).groups.flatMap(group => group.threads).map(thread => thread.id)).toEqual([plain.id])
    expect(buildThreadView([plain, wizard], { generalProjectId: null, now: NOW, query: 'conductor' }).total).toBe(1)
    const many = Array.from({ length: 10 }, (_, index) => session({ updatedAt: ago(index + 1) }))
    const capped = buildThreadView(many, { generalProjectId: null, now: NOW, limit: 4 })
    expect(capped.groups.flatMap(group => group.threads)).toHaveLength(4)
    expect(capped).toMatchObject({ total: 10, hidden: 6 })
  })
})

describe('thread labels', () => {
  it('buckets by state before age', () => {
    expect(threadBucket({ state: 'disconnected', updatedAt: ago(60 * 48) }, NOW)).toBe('needs-you')
    expect(threadBucket({ state: 'idle', updatedAt: 'not a date' }, NOW)).toBe('earlier')
  })

  it('shows compact ages and a state word only when there is something to say', () => {
    expect([0.2, 5, 125, 60 * 30, 60 * 24 * 10].map(minutes => threadAge(ago(minutes), NOW))).toEqual(['now', '5m', '2h', '1d', '1w'])
    expect(threadAge(ago(60 * 24 * 60), NOW)).toBe('2026-08-30')
    expect(threadAge('', NOW)).toBe('')
    expect(threadStateLabel({ state: 'attention', needs: 'approval' })).toBe('Approval')
    expect(threadStateLabel({ state: 'attention', needs: null })).toBe('Needs you')
    expect(threadStateLabel({ state: 'working', needs: null })).toBe('Working')
    expect(threadStateLabel({ state: 'done', needs: null })).toBeNull()
  })
})

describe('draftThreadHandoff', () => {
  it('names the folder and the project, keeps the last messages and clips long ones', () => {
    const long = 'x'.repeat(HANDOFF_CHARS_PER_MESSAGE * 2)
    const text = draftThreadHandoff({
      title: 'Logo ideas', folder: 'C:/Conductor/General', projectName: 'Brand',
      messages: [{ role: 'user', text: 'first, dropped' }, ...Array.from({ length: 5 }, (_, index) => ({ role: 'assistant' as const, text: `answer ${index}` })), { role: 'user', text: long }, { role: 'assistant', text: '   ' }]
    })
    expect(text).toContain('"Logo ideas"')
    expect(text).toContain('C:/Conductor/General')
    expect(text).toContain('project Brand')
    expect(text).not.toContain('first, dropped')
    expect(text).toContain('Agent: answer 0')
    expect(text).toContain('Me: ' + 'x'.repeat(HANDOFF_CHARS_PER_MESSAGE - 1) + '…')
    expect(text.endsWith('Next: ')).toBe(true)
    expect(draftThreadHandoff({ title: 't', folder: 'f', projectName: 'p', messages: [] })).not.toContain('Where it left off')
    expect(draftThreadHandoff({ title: 'y'.repeat(HANDOFF_MAX_CHARS * 2), folder: 'f', projectName: 'p', messages: [] }).length).toBe(HANDOFF_MAX_CHARS)
  })
})

describe('readGeneralAnchor', () => {
  it('reads only a complete anchor', () => {
    expect(readGeneralAnchor(JSON.stringify({ projectId: 'project_1', path: '/x/General' }))).toEqual({ projectId: 'project_1', path: '/x/General' })
    for (const raw of [null, '', '{', '{}', JSON.stringify({ projectId: 'p' }), JSON.stringify({ projectId: '', path: '/x' }), 'null']) expect(readGeneralAnchor(raw)).toBeNull()
  })
})
