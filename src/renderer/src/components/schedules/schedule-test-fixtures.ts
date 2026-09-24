import type { ScheduleAgentOption, ScheduleDefinition, ScheduleRun, ScheduleScript } from '../../../../shared/schedules'

/** Shared fixtures for the Schedules panel tests; imported by *.test.ts files only. */

export const NOW = Date.parse('2026-09-24T21:00:00.000Z')
export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
export const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

export const AGENTS: ScheduleAgentOption[] = [
  { provider: 'local', label: 'Local', available: true, models: [{ id: 'default', label: 'Default' }, { id: 'qwen3.6-35b', label: 'Qwen 3.6 35B' }, { id: 'gemma-4-12b', label: 'Gemma 4 12B' }] },
  { provider: 'claude', label: 'Claude', available: true, models: [{ id: 'opus', label: 'Claude Opus', effort: ['low', 'medium', 'high'] }, { id: 'sonnet', label: 'Sonnet' }] },
  { provider: 'codex', label: 'Codex', available: true, models: [{ id: 'gpt-6', label: 'GPT-6 Astra', effort: ['medium', 'high'] }] },
  { provider: 'grok', label: 'Grok', available: false, models: [{ id: 'grok-5', label: 'Grok 5' }] }
]

export function scheduleFixture(overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    id: 's1', projectId: 'p1', name: 'Watch llama.cpp releases', kind: 'agent', prompt: 'Tell me when a new CUDA build lands.',
    agent: { provider: 'claude', model: 'opus', effort: 'high' }, churnModel: null, brain: true, enabled: true,
    everyMinutes: 1_440, timing: 'night', urgent: false, catchUp: 'collapse', timeoutMs: 1_200_000,
    lastRunAt: at(-DAY), nextDueAt: at(3 * HOUR), deferredAt: null, deferredReason: null,
    createdBy: { kind: 'owner' }, delegateAgentSessionId: null, createdAt: at(-7 * DAY), updatedAt: at(-DAY),
    ...overrides
  }
}

export function runFixture(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'r1', scheduleId: 's1', startedAt: at(-DAY), finishedAt: at(-DAY + 4_200), outcome: 'unchanged', detail: 'No new release.',
    digest: null, validUntil: null, artifactPath: null, trigger: 'schedule', scripts: [], churn: null, brain: null,
    ...overrides
  }
}

export function scriptFixture(overrides: Partial<ScheduleScript> = {}): ScheduleScript {
  return {
    scheduleId: 's1', name: 'fetch-releases', description: 'Reads the latest llama.cpp release record.', language: 'node',
    content: 'const r = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")\nconsole.log((await r.json()).tag_name)',
    digest: 'abc', format: 'text', runWhen: 'always', timeoutSec: 120, order: 0, origin: 'agent',
    author: { kind: 'agent', title: 'Release watcher' }, createdAt: at(-DAY), updatedAt: at(-DAY),
    ...overrides
  }
}
