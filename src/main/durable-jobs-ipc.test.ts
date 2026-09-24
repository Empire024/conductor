import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DURABLE_JOB_BUDGETS, type DurableJob, type DurableJobsService, type DurableJobSummary } from '../shared/durable-jobs'
import { DURABLE_JOB_CHANNELS, type DurableJobDetail } from '../shared/durable-jobs-bridge'
import { DurableJobStore } from './durable-jobs/store'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, listener) },
    removeHandler: (channel: string) => { handlers.delete(channel) }
  }
}))

const { registerDurableJobsIpc } = await import('./durable-jobs-ipc')

function job(id = 'job_1'): DurableJob {
  const at = '2026-09-24T00:00:00.000Z'
  return {
    id, projectId: 'project_1', cwd: 'C:/work', title: 'Overnight', objective: 'Do the thing', status: 'running',
    model: { provider: 'local', model: 'local/qwen', escalation: 'never' }, budgets: DEFAULT_DURABLE_JOB_BUDGETS,
    handoff: { objective: 'Do the thing', constraints: [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: 'start', artifacts: [], updatedAt: at },
    createdAt: at, updatedAt: at, activeMs: 0,
    counters: { stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0 },
    logDir: 'C:/logs/job_1'
  }
}

function serviceOver(store: DurableJobStore) {
  const service = {
    status: (jobId: string) => ({ id: store.get(jobId).id, projectId: store.get(jobId).projectId }) as DurableJobSummary,
    get: (jobId: string) => ({ ...store.get(jobId), stages: store.stages(jobId) }),
    events: vi.fn((jobId: string, afterId?: string, limit?: number) => store.events(jobId, afterId, limit)),
    latestEvents: vi.fn((jobId: string, limit: number) => store.latestEvents(jobId, limit)),
    checkpoints: (jobId: string) => store.checkpoints(jobId),
    onChange: () => () => {}
  }
  return service
}

describe('durable job detail IPC', () => {
  beforeEach(() => handlers.clear())

  it('shows the exact newest 200 events of a job longer than 20,000, oldest first, without paging the history', async () => {
    const store = new DurableJobStore(':memory:')
    store.create(job(), [], false)
    store.batch('job_1', () => { for (let i = 0; i < 20_500; i++) store.event('job_1', { owner: true }, 'note', `n${i}`) })
    store.event('job_1', { owner: true }, 'note', 'late marker', { marker: true })
    const service = serviceOver(store)
    const dispose = registerDurableJobsIpc({ service: service as unknown as DurableJobsService, authorize: () => {}, localModels: () => [], publish: () => {}, reveal: () => {} })
    try {
      const detail = await handlers.get(DURABLE_JOB_CHANNELS.detail)!({}, 'project_1', 'job_1') as DurableJobDetail
      expect(detail.events.map(event => event.message)).toEqual([...Array.from({ length: 199 }, (_, i) => `n${20_301 + i}`), 'late marker'])
      expect(detail.events.at(-1)?.data).toEqual({ marker: true })
      expect(service.latestEvents).toHaveBeenCalledTimes(1)
      expect(service.latestEvents).toHaveBeenCalledWith('job_1', 200)
      expect(service.events).not.toHaveBeenCalled()

      // Ordinary forward paging is unchanged: oldest first from afterId, capped at 500.
      const head = await handlers.get(DURABLE_JOB_CHANNELS.events)!({}, 'project_1', 'job_1') as unknown[]
      expect(head).toHaveLength(100)
      const page = await handlers.get(DURABLE_JOB_CHANNELS.events)!({}, 'project_1', 'job_1', detail.events.at(-3)!.id, 10_000) as Array<{ message: string }>
      expect(page.map(event => event.message)).toEqual(['n20499', 'late marker'])
      expect(service.events).toHaveBeenLastCalledWith('job_1', detail.events.at(-3)!.id, 500)
    } finally {
      dispose()
      store.close()
    }
  })

  it('reads a job of another project as missing', async () => {
    const store = new DurableJobStore(':memory:')
    store.create(job(), [], false)
    const service = serviceOver(store)
    const dispose = registerDurableJobsIpc({ service: service as unknown as DurableJobsService, authorize: () => {}, localModels: () => [], publish: () => {}, reveal: () => {} })
    try {
      expect(() => handlers.get(DURABLE_JOB_CHANNELS.detail)!({}, 'project_2', 'job_1')).toThrow('No durable job with that id in this project')
      expect(service.latestEvents).not.toHaveBeenCalled()
    } finally {
      dispose()
      store.close()
    }
  })
})
