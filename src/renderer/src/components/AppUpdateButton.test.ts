import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '../../../shared/models'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isUpdateActionVisible, restartRequestLabel, VersionsMenu } from './AppUpdateButton'

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

  it('offers rollback and pin controls with known-good metadata', () => {
    const html = renderToStaticMarkup(createElement(VersionsMenu, {
      currentVersion: '0.2.0-local.9', busy: false,
      versions: [{ version: '0.2.0-local.8', commit: 'abcdef0123456789', createdAt: '2026-09-23T12:00:00Z', dirty: false,
        cliVersions: { claude: '2.1.278', codex: '0.155.1', grok: '1.0.41' }, models: [], pinned: true, knownGood: true,
        crashCount: 0, failedShipCount: 0, installer: 'Conductor-Setup-0.2.0-local.8.exe', blockmap: 'Conductor-Setup-0.2.0-local.8.exe.blockmap' }],
      onRollback() {}, onPin() {}
    }))
    expect(html).toContain('Versions')
    expect(html).toContain('Known good')
    expect(html).toContain('Roll back to this version')
    expect(html).toContain('Unpin')
    expect(html).toContain('Claude 2.1.278')
  })
})
