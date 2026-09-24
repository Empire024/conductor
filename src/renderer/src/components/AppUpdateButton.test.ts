import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '../../../shared/models'
import { isUpdateActionVisible, restartRequestLabel } from './AppUpdateButton'

const state = (phase: AppUpdateState['phase'], availableVersion?: string): AppUpdateState => ({
  phase,
  currentVersion: '0.1.3',
  configured: true,
  availableVersion
})

describe('bottom-bar update action', () => {
  it('appears for actionable update states', () => {
    expect(isUpdateActionVisible(state('available', '0.1.4'))).toBe(true)
    expect(isUpdateActionVisible(state('downloading', '0.1.4'))).toBe(true)
    expect(isUpdateActionVisible(state('ready', '0.1.4'))).toBe(true)
    expect(isUpdateActionVisible(state('installing', '0.1.4'))).toBe(true)
    expect(isUpdateActionVisible(state('error', '0.1.4'))).toBe(true)
  })

  it('names the wizard that asked the owner to restart, and why', () => {
    expect(restartRequestLabel(state('ready', '0.1.4'))).toBeUndefined()
    expect(restartRequestLabel({ ...state('idle'), restartRequest: { title: 'Overnight wizard', reason: 'install 0.1.4', at: '2026-09-24T18:00:00Z' } })).toBe('Restart requested by Overnight wizard — install 0.1.4')
  })

  it('stays out of the work surface when no update needs action', () => {
    expect(isUpdateActionVisible(state('idle'))).toBe(false)
    expect(isUpdateActionVisible(state('checking'))).toBe(false)
    expect(isUpdateActionVisible(state('error'))).toBe(false)
  })
})
