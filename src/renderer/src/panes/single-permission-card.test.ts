import { describe, expect, it } from 'vitest'
import type { Json, TimelineItem } from '../../../shared/structured-agent'
import { singlePermissionCards } from './single-permission-card'

const interaction: TimelineItem = { id: 'interaction', runtimeId: 'runtime', sequence: 2, timestamp: '', data: { type: 'interaction', interaction: { id: 'native-request', permissionGrantId: 'grant', kind: 'approval', title: 'Allow?', input: {}, choices: [], status: 'pending' } } }
function notice(runtimeId = 'runtime', source = 'native', requestId = 'native-request', status = 'pending'): TimelineItem {
  return { id: 'notice', runtimeId, sequence: 1, timestamp: '', data: { type: 'notice', message: 'Allow this provider request once', payload: { permissionGrant: { id: 'grant', source, status, nativeAvailable: status === 'pending', tool: 'Bash', action: 'Run', resource: '*', class: 'local', requestedAt: '', call: { runtimeId, nativeSessionId: 'session', toolUseId: 'tool', tool: 'Bash', argsDigest: 'digest', requestId } } } as Json } }
}
describe('single native permission card', () => {
  it('renders the exact native grant once while preserving the provider projection', () => {
    const grant = notice(), items = [grant, interaction]
    expect(singlePermissionCards(items)).toEqual([grant])
    expect(items).toHaveLength(2)
  })
  it('keeps controls if the card is outside this rendered window or is unrelated', () => {
    expect(singlePermissionCards([interaction])).toEqual([interaction])
    for (const grant of [notice('old-runtime'), notice('runtime', 'agent'), notice('runtime', 'native', 'other-request')])
      expect(singlePermissionCards([grant, interaction])).toEqual([grant, interaction])
  })
  // videos 2026-10-21: "Request cancelled" on the card while the CLI still waited for approval.
  it('gives a still-pending native request its own buttons back once its card has settled', () => {
    for (const status of ['approved-once', 'expired', 'denied']) {
      const grant = notice('runtime', 'native', 'native-request', status)
      expect(singlePermissionCards([grant, interaction])).toEqual([grant, interaction])
    }
    // An answered native request is shown once, by its card.
    const answered: TimelineItem = { ...interaction, data: { type: 'interaction', interaction: { ...(interaction.data as { interaction: object }).interaction, status: 'resolved' } } } as TimelineItem
    const settled = notice('runtime', 'native', 'native-request', 'approved-once')
    expect(singlePermissionCards([settled, answered])).toEqual([settled])
  })
})

