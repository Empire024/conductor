import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '../../../shared/models'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isUpdateActionVisible, RestorePlanPanel, restartRequestLabel, VersionsMenu } from './AppUpdateButton'

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
    expect(html).toContain('Roll back CLIs only')
    expect(html).toContain('Unpin')
    expect(html).toContain('Claude 2.1.278')
  })
it('shows what a rollback changes before it is confirmed, and the restored CLIs in use', () => {
    const html = renderToStaticMarkup(createElement(RestorePlanPanel, { busy: false, onConfirm() {}, onCancel() {}, plan: {
      version: '0.2.0-local.8', scope: 'clis', app: null, warnings: ['Open tabs keep the CLI process they are running.'],
      clis: [{ provider: 'claude', label: 'Claude Code', from: '2.1.290', to: '2.1.278', action: 'pin', source: 'saved copy' },
        { provider: 'codex', label: 'Codex', from: '0.156.0', to: '0.150.0', action: 'unavailable' }],
      models: [{ provider: 'codex', added: ['gpt-5.6-sol'], removed: ['gpt-7-preview'] }]
    } }))
    expect(html).toContain('Roll back the CLIs to those of 0.2.0-local.8')
    expect(html).toContain('Claude Code 2.1.290 → 2.1.278 (saved copy)')
    expect(html).toContain('Codex 0.150.0: not on this machine, stays on 0.156.0')
    expect(html).toContain('+gpt-5.6-sol')
    expect(html).toContain('Confirm rollback')
    const menu = renderToStaticMarkup(createElement(VersionsMenu, { currentVersion: '0.2.0-local.9', busy: false, versions: [], onRollback() {}, onPin() {},
      cliPins: [{ provider: 'codex', label: 'Codex', version: '0.155.1', installed: '0.156.0', pinnedAt: '2026-09-25T12:00:00Z' }] }))
    expect(menu).toContain('Using restored CLIs: Codex 0.155.1 (installed 0.156.0)')
    expect(menu).toContain('Use installed CLIs')
  })
})
