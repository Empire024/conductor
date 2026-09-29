import { describe, expect, it } from 'vitest'
import { CONTROL_IDS } from '../../../shared/production'
import { REGISTRY } from '../registry'
import { CHECKS, checkRegistryProblems, checksFor } from './index'

describe('check registry', () => {
  it('registers exactly the checks the control registry lists, one or more for every control C01-C16', () => {
    expect(checkRegistryProblems()).toEqual([])
    for (const controlId of CONTROL_IDS) expect(checksFor(controlId).length).toBeGreaterThan(0)
    expect(new Set(CHECKS.map(check => check.controlId)).size).toBe(16)
    expect(CHECKS.map(check => check.checkId)).toEqual(REGISTRY.controls.flatMap(definition => definition.checks))
  })

  it('reports a registry id without an implementation, an unlisted implementation and a duplicate', () => {
    const [first, ...rest] = CHECKS
    expect(checkRegistryProblems(rest)).toEqual([`C01 lists check ${first!.checkId}, which is not registered`])
    expect(checkRegistryProblems([...CHECKS, { ...first!, checkId: 'extra' }])).toEqual(['check extra is registered for C01, whose definition does not list it'])
    expect(checkRegistryProblems([...CHECKS, first!])).toEqual([`check C01/${first!.checkId} is registered twice`])
  })
})
