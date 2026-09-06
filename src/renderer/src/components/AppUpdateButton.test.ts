import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '../../../shared/models'
import { isUpdateActionVisible } from './AppUpdateButton'

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

  it('stays out of the work surface when no update needs action', () => {
    expect(isUpdateActionVisible(state('idle'))).toBe(false)
    expect(isUpdateActionVisible(state('checking'))).toBe(false)
    expect(isUpdateActionVisible(state('error'))).toBe(false)
  })
})
