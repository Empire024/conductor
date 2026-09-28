import { describe, expect, it } from 'vitest'
import { DEFAULT_DURABLE_JOB_BUDGETS, type DurableJob, type DurableJobStage } from '../../../shared/durable-jobs'
import type { LocalStopReason } from '../../../shared/local-stop'
import type { StageObservation } from '../../durable-jobs/ports'
import { captureDurableStage } from './durable-job'

const counters = (extra: Partial<DurableJob['counters']> = {}): DurableJob['counters'] => ({ stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0, ...extra })
const job = (extra: Partial<DurableJob> = {}): DurableJob => ({
  id: 'job-1', projectId: 'p1', cwd: 'C:/w', title: 'Overnight fix', objective: 'Fix the importer', status: 'running',
  model: { provider: 'local', model: 'local/qwen3.6-35b-a3b', escalation: 'never' }, budgets: DEFAULT_DURABLE_JOB_BUDGETS,
  handoff: { objective: 'Fix the importer', constraints: [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: '', artifacts: [], updatedAt: '2026-09-28T09:00:00Z' },
  createdAt: '2026-09-28T09:00:00Z', updatedAt: '2026-09-28T09:00:00Z', activeMs: 0, counters: counters(), logDir: 'C:/logs', ...extra,
})
const stage = (extra: Partial<DurableJobStage> = {}): DurableJobStage => ({
  id: 'stage-1', jobId: 'job-1', index: 0, title: 'Implement the importer change', kind: 'implement', objective: 'Implement quoted-comma support in the CSV importer', completionCriteria: [], inputs: [], status: 'running', attempt: 1,
  agentSessionId: 'loc-1', startedAt: '2026-09-28T10:00:00Z', completedAt: '2026-09-28T10:05:00Z', ...extra,
})
const observation = (reason: LocalStopReason | null, extra: Partial<StageObservation> = {}): StageObservation => ({
  phase: 'completed', stopSequence: reason ? 9 : 0, lastAnswer: 'Done. The importer now handles quoted commas.', filesChanged: [],
  ...(reason ? { stop: { reason, detail: `${reason} detail`, filesChanged: [] } } : {}), ...extra,
})

describe('captureDurableStage', () => {
  it('maps a successful stage attempt', () => {
    const result = captureDurableStage({ job: job(), stage: stage(), observation: observation('completed', { stop: { reason: 'completed', detail: '', filesChanged: ['a.ts'], acceptance: { command: 'npm test', passed: true, exitCode: 0 } }, filesChanged: ['a.ts'] }), succeeded: true })!
    expect(result).toMatchObject({ key: { provider: 'local', model: 'local/qwen3.6-35b-a3b' }, source: 'durable-job', ref: 'job-1:stage-1:1', category: 'difficult-coding', result: 'success', verifier: 'pass', retries: 0, durationMs: 300_000, projectId: 'p1', agentSessionId: 'loc-1' })
  })
  it('uses classifyStageOutcome when the controller verdict is absent', () => {
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation('completed') })!.result).toBe('success')
    // completed but no visible answer: an empty answer, not a success
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation('completed', { lastAnswer: '<think>still going' }) })).toMatchObject({ result: 'failure', invalidOutput: true })
  })
  it('reads counter deltas, attempts and stop reasons', () => {
    const result = captureDurableStage({ job: job({ counters: counters({ retries: 3, loopsDetected: 1, recoveries: 1 }) }), countersBefore: counters({ retries: 2 }), stage: stage({ attempt: 3 }), observation: observation('stagnation'), succeeded: false })!
    expect(result).toMatchObject({ ref: 'job-1:stage-1:3', result: 'failure', looped: true, retries: 3 })
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation('context_limit', { filesChanged: ['b.ts'] }), succeeded: false })).toMatchObject({ contextFailure: true, result: 'partial' })
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation('round_limit'), succeeded: false })).toMatchObject({ timedOut: true, overBudget: true })
  })
  it('a completed stop that failed its criteria is a false completion', () => {
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation('completed'), succeeded: false, criteriaFailure: 'Completion criteria not met: out.csv missing' })).toMatchObject({ result: 'failure', verifier: 'fail', falseCompletion: true, detail: 'Completion criteria not met: out.csv missing' })
  })
  it('maps stage kinds to categories and skips missing conversations', () => {
    expect(captureDurableStage({ job: job(), stage: stage({ kind: 'research', title: 'Look around', objective: 'Find prior art' }), observation: observation('completed') })!.category).toBe('research')
    expect(captureDurableStage({ job: job(), stage: stage({ kind: 'investigate', title: 'Look around', objective: 'See what is there' }), observation: observation('completed') })!.category).toBe('debugging')
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation(null, { phase: 'missing' }) })).toBeNull()
    expect(captureDurableStage({ job: job(), stage: stage(), observation: observation('interrupted'), interrupted: true })!.result).toBe('cancelled')
  })
})
