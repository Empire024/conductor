import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AuditRun, ControlResult, Finding } from '../../shared/production'
import { emptyFacts, ownerFact, wizardFact } from './profile'
import { buildReport, renderMarkdown, writeReport, REPORT_SCHEMA } from './report'
import { emptyLedger } from './store'
import { ENV_ID, fingerprint } from './testkit'

const scratch = mkdtempSync(join(tmpdir(), 'prod-report-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const AT = '2026-09-29T10:00:00.000Z'
const run: AuditRun = {
  id: 'prun_1', projectId: 'haftheme', kind: 'audit', environmentId: ENV_ID, trigger: { kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: AT, changes: [], detail: '' },
  parentRunId: null, verifies: [], fingerprint: fingerprint({ registryVersion: 3, profileVersion: 7 }), status: 'completed', statusReason: '3 controls', controls: ['C03', 'C05', 'C13'], steps: [],
  checkpoint: { nextStepIndex: 0, doneStepIds: [], at: AT }, budget: { maxTokens: 120_000, maxModelCalls: 40, maxRequests: 2_000, maxDurationMs: 1, requestsPerSecondPerOrigin: 4, maxCostUsdPerCall: 0.5 },
  ledger: { ...emptyLedger(), requests: 42 }, coverage: { tested: [{ path: '/', devices: ['desktop', 'mobile'], consentStates: ['clean'], authStates: ['guest'] }], sampled: [{ path: '/product/a/', standsFor: 'group:product' }], excluded: [{ path: '/cart/?remove=1', reason: 'state-changing' }], unobservable: ['payment provider pages'] },
  artifactsDir: scratch, reportPaths: null, createdAt: AT, startedAt: AT, finishedAt: AT, rerunRequested: null,
}
const result = (controlId: 'C03' | 'C05' | 'C13', status: ControlResult['status'], findingIds: string[] = []): ControlResult => ({
  runId: run.id, controlId, status, applicability: { status: 'applicable', rationale: 'EU targets', factsUsed: [], ruleIndex: 0 }, rationale: `${controlId} rationale`, evidence: ['a1-ev-0001-abcd'], findingIds,
  humanReview: controlId === 'C13' ? [{ id: 'C13:manual', controlId, question: 'Check screen reader flow', why: 'automated portion only', route: '/', evidence: [] }] : [], checks: [], coverage: run.coverage,
  provenance: [{ kind: 'primary-law', title: 'GDPR', jurisdiction: 'EU', url: null, effectiveDate: '2018-05-25', retrievedAt: null, reviewBy: '2027-03-31' }],
})
const finding = (id: string, category: Finding['category'], controlId: Finding['controlId']): Finding => ({
  id, projectId: 'haftheme', environmentId: ENV_ID, controlId, checkId: 'c', key: id, route: '/', component: null, scope: 'page', category, severity: 'high', confidence: 'confirmed',
  title: `${category} defect ${id}`, expected: 'nothing before consent', observed: 'tracker fired', reproduction: ['open /', 'watch requests'], evidence: ['a1-ev-0002-ef01'], proposedFix: 'gate the tag',
  owner: 'engineering', legal: category === 'legal' ? { sources: [{ kind: 'primary-law', title: 'ePrivacy Directive', jurisdiction: 'EU', url: null, effectiveDate: null, retrievedAt: null, reviewBy: '2027-03-31' }], effectiveDate: null, reviewBy: '2027-03-31' } : null,
  sources: [], applicability: { status: 'applicable', rationale: '', factsUsed: [], ruleIndex: null }, status: 'open', verification: null, firstSeenRunId: run.id, lastSeenRunId: run.id,
  lastSeenFingerprint: run.fingerprint, occurrences: 1, taskId: 'task-9', waiverId: null, createdAt: AT, updatedAt: AT,
})

describe('audit report', () => {
  const report = buildReport({
    run, results: [result('C03', 'FAIL', ['f1']), result('C05', 'WARN', ['f3']), result('C13', 'NEEDS_HUMAN_REVIEW', ['f2'])],
    findings: [finding('f1', 'legal', 'C03'), finding('f2', 'technical', 'C13'), finding('f3', 'internal-quality', 'C05')],
    verifications: [], evidence: [{ id: 'a1-ev-0001-abcd', kind: 'requests', path: 'attempt-1/evidence/0001-requests.json', sha256: 'abcd', description: 'requests on /', capturedAt: AT, redacted: true }],
    modelCalls: [], smoke: { command: 'npm run smoke', status: 'passed', exitCode: 0, durationMs: 10, detail: 'ok', evidence: [] }, legalSources: [],
    gate: { state: 'NEEDS_REVIEW', reasons: ['1 open confirmed critical/high finding(s)'], fingerprint: run.fingerprint }, generatedAt: AT,
  })

  it('report.json carries the rule version, the fingerprint, coverage, evidence references and separate legal/technical/internal sections', () => {
    expect(report.schema).toBe(REPORT_SCHEMA)
    expect(report).toMatchObject({ registryVersion: 3, profileVersion: 7, fingerprint: { commit: run.fingerprint.commit, configHash: 'cfg', policyHash: 'pol' }, coverage: run.coverage })
    expect(report.sections.legal.map(item => item.id)).toEqual(['f1'])
    expect(report.sections.technical.map(item => item.id)).toEqual(['f2'])
    expect(report.sections.internalQuality.map(item => item.id)).toEqual(['f3'])
    expect(report.sections.legal[0]!.legalSources).toEqual([{ title: 'ePrivacy Directive', jurisdiction: 'EU', effectiveDate: null, reviewBy: '2027-03-31' }])
    expect(report.evidence).toEqual([{ id: 'a1-ev-0001-abcd', kind: 'requests', path: 'attempt-1/evidence/0001-requests.json', sha256: 'abcd', description: 'requests on /' }])
    expect(report.controls.find(control => control.controlId === 'C03')).toMatchObject({ classification: 'legal', status: 'FAIL', evidence: ['a1-ev-0001-abcd'] })
  })

  it('report.md has the same content in sections, states scope instead of scoring, and never certifies', () => {
    const markdown = renderMarkdown(report)
    for (const heading of ['## What was tested', '## Control results', '## Legal findings', '## Technical findings', '## Internal quality findings', '## Engineering smoke (additional step, not a source item)', '## Coverage', '## Evidence']) expect(markdown).toContain(heading)
    expect(markdown).toContain('Rule version (control registry): 3')
    expect(markdown).toContain(`Commit: ${run.fingerprint.commit}`)
    expect(markdown).toContain('- Sampled: /product/a/ for group:product')
    expect(markdown).toContain('- Not observable: payment provider pages')
    expect(markdown).toContain('- a1-ev-0001-abcd (requests): attempt-1/evidence/0001-requests.json')
    expect(markdown).toContain('**Needs review at commit c0ffee000000.**')
    expect(markdown.indexOf('## Legal findings')).toBeLessThan(markdown.indexOf('legal defect f1'))
    expect(markdown.indexOf('legal defect f1')).toBeLessThan(markdown.indexOf('## Technical findings'))
    expect(markdown).not.toMatch(/%|certif|secure/i)
  })

  it('lists the profile facts with who set them, and a wizard fact never reads as the owner', () => {
    const withFacts = buildReport({
      run, results: [], findings: [], verifications: [], evidence: [], modelCalls: [], smoke: null, legalSources: [], gate: null, generatedAt: AT,
      facts: { ...emptyFacts(), analytics: ownerFact(true, AT), userUploads: wizardFact(false, AT, 'wizard:agent_w (Haftheme wizard)') },
    })
    expect(withFacts.facts).toEqual([
      expect.objectContaining({ key: 'userUploads', value: false, source: 'wizard', by: 'wizard:agent_w (Haftheme wizard)', label: 'set by wizard agent_w (Haftheme wizard)' }),
      expect.objectContaining({ key: 'analytics', value: true, source: 'owner', label: 'owner' }),
    ])
    const md = renderMarkdown(withFacts)
    expect(md).toContain('| userUploads | no | set by wizard agent_w (Haftheme wizard) |')
    expect(md).toContain('| analytics | yes | owner |')
    expect(report.facts).toEqual([])
  })

  it('writes both files into the run artifacts', () => {
    const paths = writeReport(scratch, report)
    expect(JSON.parse(readFileSync(paths.json, 'utf8')).run.id).toBe('prun_1')
    expect(readFileSync(paths.markdown, 'utf8')).toMatch(/^# Production audit report: haftheme \/ env-a/)
  })
})
