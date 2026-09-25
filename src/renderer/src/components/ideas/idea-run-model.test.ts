import { describe, expect, it } from 'vitest'
import type { IdeaRun, IdeaRunStage } from '../../../../shared/idea-runs'
import { canStartRun, currentRun, runStatusLabel, stageLine } from './idea-run-model'

const run = (id: string, status: IdeaRun['status'], dryRun = false): IdeaRun => ({
  id, ideaId: 'idea', ideaTitle: 'Idea', projectId: 'p', status, dryRun, plan: null, stages: [], checkpoints: [], rules: [],
  plannerAgentSessionId: null, reason: null, createdAt: '', updatedAt: '', approvedAt: null
})

describe('idea run panel model', () => {
  it('shows the run still going, else the newest, and offers a new run only when none is going', () => {
    expect(currentRun([run('new', 'completed'), run('old', 'waiting-owner')])!.id).toBe('old')
    expect(currentRun([run('new', 'stopped'), run('old', 'completed')])!.id).toBe('new')
    expect(currentRun([])).toBeNull()
    expect(canStartRun([run('a', 'completed'), run('b', 'failed')])).toBe(true)
    expect(canStartRun([run('a', 'paused')])).toBe(false)
    expect(runStatusLabel(run('a', 'awaiting-approval', true))).toBe('Plan waiting for you · dry run')
  })

  it('describes a recurring stage with its loop and occurrences', () => {
    const stage = {
      id: 'post', title: 'Post', kind: 'public', goal: 'g', doneCriteria: ['d'], agent: { provider: 'claude', model: 'sonnet' },
      budget: { maxMinutes: 30, maxTurns: 4, maxEur: 0 }, checkpoints: ['publish'], generatesMedia: true,
      recurrence: { everyMinutes: 1440, times: 3, loop: { title: 'Loop', steps: [] } },
      index: 2, status: 'done', agentSessionId: null, startedAt: null, finishedAt: null, turns: 2, spentEur: 1.5, summary: '', loopId: 'idea-post-abc', occurrences: 3, nextDueAt: null
    } satisfies IdeaRunStage
    expect(stageLine(stage)).toBe('Done · claude sonnet · 30 min · 4 turns · €0.00 · spent €1.50 · every 1440 min × 3, loop idea-post-abc, 3 done')
  })
})
