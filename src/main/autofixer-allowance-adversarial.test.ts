import { describe, expect, it } from 'vitest'
import { autoFixerAllowance } from './project-task-dispatch'

describe('AutoFixer allowance freshness adversarial review', () => {
  it('does not treat old low usage as proof of remaining allowance just because reset is future', () => {
    const now = Date.parse('2026-09-12T12:00:00Z')
    const result = autoFixerAllowance([{
      key: 'codex:weekly', kind: 'weekly', label: 'Weekly', scope: 'provider',
      usedPercent: 10, windowMinutes: 10080, overage: false,
      observedAt: '2026-09-10T12:00:00Z', resetsAt: '2026-09-15T12:00:00Z'
    }], { id: 'gpt-6-astra', label: 'GPT-6-Astra' }, now)
    // Usage may have reached 100% after the observation. The reset date is not a refresh.
    expect(result.status).not.toBe('usable')
  })
})
