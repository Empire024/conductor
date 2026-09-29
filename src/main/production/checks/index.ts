import type { ControlCheck, ControlId, ControlRegistry } from '../../../shared/production'
import { REGISTRY } from '../registry'
import { accessibilityCheck } from './accessibility'
import { childrenCheck } from './children'
import { claimsCheck } from './claims'
import { consentCheck } from './consent'
import { dataRightsCheck } from './data-rights'
import { emailCheck } from './email'
import { formsCheck } from './forms'
import { identityCheck } from './identity'
import { policiesCheck } from './policies'
import { pricingCheck } from './pricing'
import { refundsCheck } from './refunds'
import { replayCheck } from './replay'
import { storageCheck } from './storage'
import { subscriptionsCheck } from './subscriptions'
import { uploadsCheck } from './uploads'
import { vendorsCheck } from './vendors'

/**
 * Every automated control check, C01-C16 (docs/production-agent.md section 11): M5's document and
 * claims checks, M4's technical and accessibility checks, M6's commerce and lifecycle checks. The
 * runner looks checks up here by control; `checkRegistryProblems` (asserted in the tests) keeps
 * this list and the registry's `checks` ids in agreement.
 */
export const CHECKS: readonly ControlCheck[] = [
  policiesCheck,        // C01
  identityCheck,        // C02
  consentCheck,         // C03
  formsCheck,           // C04
  vendorsCheck,         // C05
  replayCheck,          // C06
  dataRightsCheck,      // C07
  emailCheck,           // C08
  pricingCheck,         // C09
  subscriptionsCheck,   // C10
  refundsCheck,         // C11
  claimsCheck,          // C12
  accessibilityCheck,   // C13
  childrenCheck,        // C14
  uploadsCheck,         // C15
  storageCheck,         // C16
]

export function checksFor(controlId: ControlId, checks: readonly ControlCheck[] = CHECKS): ControlCheck[] {
  return checks.filter(check => check.controlId === controlId)
}

/** Disagreements between the check list and the registry: a registry check id with no implementation, or an implementation the registry does not list. */
export function checkRegistryProblems(checks: readonly ControlCheck[] = CHECKS, registry: ControlRegistry = REGISTRY): string[] {
  const problems: string[] = []
  for (const definition of registry.controls) {
    for (const checkId of definition.checks) if (!checks.some(check => check.controlId === definition.id && check.checkId === checkId)) problems.push(`${definition.id} lists check ${checkId}, which is not registered`)
  }
  for (const check of checks) {
    const definition = registry.controls.find(entry => entry.id === check.controlId)
    if (!definition) problems.push(`check ${check.checkId} names unknown control ${check.controlId}`)
    else if (!definition.checks.includes(check.checkId)) problems.push(`check ${check.checkId} is registered for ${check.controlId}, whose definition does not list it`)
  }
  const ids = checks.map(check => `${check.controlId}/${check.checkId}`)
  for (const id of new Set(ids)) if (ids.filter(entry => entry === id).length > 1) problems.push(`check ${id} is registered twice`)
  return problems
}
