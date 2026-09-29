import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTROL_TITLES,
  type AuditRun, type ControlResult, type EvidenceRef, type FactKey, type Finding, type FindingCategory, type GateState, type ModelCallRecord, type ProfileFact, type ProfileFacts, type VerificationRecord,
} from '../../shared/production'
import { gateSummary } from './gate'
import { formatFactValue } from './profile'
import { controlDefinition } from './registry'

/**
 * report.md and report.json of a run (docs/production-agent.md sections 6-8): the rule version,
 * the fingerprint that was tested, coverage, every control's status with its rationale, findings
 * split into legal, technical and internal-quality sections, independent verifications and their
 * disagreements, the project's own smoke command (an additional engineering step, not a source
 * item), model use, and the evidence index. It states what passed the configured scope at which
 * fingerprint; it never scores, never certifies.
 */

export const REPORT_SCHEMA = 'conductor.production-report/1'

export interface EngineeringSmokeOutcome {
  command: string
  status: 'passed' | 'failed' | 'skipped' | 'error'
  exitCode: number | null
  durationMs: number
  detail: string
  evidence: string[]
}

export interface ReportInput {
  run: AuditRun
  results: readonly ControlResult[]
  /** Findings this run observed (lastSeenRunId) or verified. */
  findings: readonly Finding[]
  verifications: readonly VerificationRecord[]
  evidence: readonly EvidenceRef[]
  modelCalls: readonly ModelCallRecord[]
  smoke: EngineeringSmokeOutcome | null
  legalSources: Array<{ title: string; url: string; status: 'reachable' | 'unreachable' | 'skipped'; sha256: string | null; checkedAt: string; detail: string }>
  gate: Pick<GateState, 'state' | 'reasons' | 'fingerprint'> | null
  /** The profile facts the run decided applicability with; each known one is listed with who set it. */
  facts?: ProfileFacts
  generatedAt: string
}

export interface ProductionReport {
  schema: typeof REPORT_SCHEMA
  generatedAt: string
  statement: string
  run: Pick<AuditRun, 'id' | 'projectId' | 'kind' | 'environmentId' | 'status' | 'statusReason' | 'trigger' | 'parentRunId' | 'verifies' | 'createdAt' | 'startedAt' | 'finishedAt'>
  registryVersion: number
  profileVersion: number
  /** Known profile facts with their source; a wizard's are labelled so they never read as the owner's word. */
  facts: ReportFact[]
  fingerprint: AuditRun['fingerprint']
  gate: { state: GateState['state']; reasons: string[] } | null
  coverage: AuditRun['coverage']
  budget: AuditRun['budget']
  ledger: AuditRun['ledger']
  controls: Array<{
    controlId: string; title: string; classification: string; status: string; applicability: string; rationale: string
    checks: ControlResult['checks']; findingIds: string[]; humanReview: ControlResult['humanReview']; evidence: string[]
    provenance: Array<{ title: string; jurisdiction: string | null; effectiveDate: string | null; retrievedAt: string | null; reviewBy: string | null }>
  }>
  sections: Record<'legal' | 'technical' | 'internalQuality', ReportFinding[]>
  verification: Array<{ findingId: string; title: string; status: VerificationRecord['status']; disagreement: string | null; evidence: string[] }>
  engineeringSmoke: EngineeringSmokeOutcome | null
  legalSources: ReportInput['legalSources']
  modelCalls: Array<{ role: string; provider: string; model: string; tokens: number; costUsd: number | null; refused: string | null }>
  evidence: Array<{ id: string; kind: string; path: string; sha256: string; description: string }>
}

export interface ReportFact {
  key: FactKey; value: unknown; status: ProfileFact<unknown>['status']; source: ProfileFact<unknown>['source']; by: string | null; at: string | null
  /** "owner", "set by wizard <tab>", "discovered", or "assumed". */
  label: string
}

export interface ReportFinding {
  id: string; controlId: string; checkId: string; title: string; severity: string; confidence: string; status: string; route: string | null
  expected: string; observed: string; reproduction: string[]; proposedFix: string; evidence: string[]; taskId: string | null; waiverId: string | null
  legalSources: Array<{ title: string; jurisdiction: string | null; effectiveDate: string | null; reviewBy: string | null }>
}

export function factLabel(fact: Pick<ProfileFact<unknown>, 'source' | 'by'>): string {
  if (fact.source === 'owner') return 'owner'
  if (fact.source === 'wizard') return `set by wizard${fact.by ? ` ${fact.by.replace(/^wizard:?/, '').trim()}` : ''}`
  if (fact.source === 'discovery') return 'discovered'
  if (fact.source === 'assumption') return 'assumed'
  return 'unknown'
}

const reportFacts = (facts: ProfileFacts | undefined): ReportFact[] => Object.entries(facts ?? {})
  .filter(([, fact]) => fact && fact.status !== 'unknown' && fact.value !== null && fact.value !== undefined)
  .map(([key, fact]) => ({ key: key as FactKey, value: fact.value, status: fact.status, source: fact.source, by: fact.by ?? null, at: fact.at, label: factLabel(fact) }))

const SECTION: Readonly<Record<FindingCategory, keyof ProductionReport['sections']>> = { legal: 'legal', technical: 'technical', 'internal-quality': 'internalQuality' }

export function buildReport(input: ReportInput): ProductionReport {
  const { run } = input
  const sections: ProductionReport['sections'] = { legal: [], technical: [], internalQuality: [] }
  for (const finding of input.findings) {
    sections[SECTION[finding.category]].push({
      id: finding.id, controlId: finding.controlId, checkId: finding.checkId, title: finding.title, severity: finding.severity, confidence: finding.confidence,
      status: finding.status, route: finding.route, expected: finding.expected, observed: finding.observed, reproduction: finding.reproduction,
      proposedFix: finding.proposedFix, evidence: finding.evidence, taskId: finding.taskId, waiverId: finding.waiverId,
      legalSources: finding.legal?.sources.map(source => ({ title: source.title, jurisdiction: source.jurisdiction, effectiveDate: source.effectiveDate, reviewBy: source.reviewBy })) ?? [],
    })
  }
  const statement = input.gate ? gateSummary(input.gate) : run.status === 'completed' ? 'Audit completed; the gate was not computed for this report.' : `Run ${run.status}.`
  return {
    schema: REPORT_SCHEMA,
    generatedAt: input.generatedAt,
    statement,
    run: {
      id: run.id, projectId: run.projectId, kind: run.kind, environmentId: run.environmentId, status: run.status, statusReason: run.statusReason, trigger: run.trigger,
      parentRunId: run.parentRunId, verifies: run.verifies, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    },
    registryVersion: run.fingerprint.registryVersion,
    profileVersion: run.fingerprint.profileVersion,
    facts: reportFacts(input.facts),
    fingerprint: run.fingerprint,
    gate: input.gate ? { state: input.gate.state, reasons: input.gate.reasons } : null,
    coverage: run.coverage,
    budget: run.budget,
    ledger: run.ledger,
    controls: input.results.map(result => ({
      controlId: result.controlId, title: CONTROL_TITLES[result.controlId], classification: controlDefinition(result.controlId).classification,
      status: result.status, applicability: result.applicability.rationale, rationale: result.rationale, checks: result.checks, findingIds: result.findingIds,
      humanReview: result.humanReview, evidence: result.evidence,
      provenance: result.provenance.map(entry => ({ title: entry.title, jurisdiction: entry.jurisdiction, effectiveDate: entry.effectiveDate, retrievedAt: entry.retrievedAt, reviewBy: entry.reviewBy })),
    })),
    sections,
    verification: input.verifications.map(record => ({
      findingId: record.findingId, title: input.findings.find(finding => finding.id === record.findingId)?.title ?? record.findingId,
      status: record.status, disagreement: record.disagreement, evidence: record.evidence,
    })),
    engineeringSmoke: input.smoke,
    legalSources: input.legalSources,
    modelCalls: input.modelCalls.map(call => ({ role: call.role, provider: call.provider, model: call.model, tokens: call.inputTokens + call.outputTokens, costUsd: call.costUsd, refused: call.refused })),
    evidence: input.evidence.map(ref => ({ id: ref.id, kind: ref.kind, path: ref.path, sha256: ref.sha256, description: ref.description })),
  }
}

const cell = (text: string | null | undefined): string => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export function renderMarkdown(report: ProductionReport): string {
  const lines: string[] = []
  const fp = report.fingerprint
  lines.push(`# Production audit report: ${report.run.projectId} / ${report.run.environmentId}`, '')
  lines.push(`**${report.statement}**`, '')
  lines.push(`Run ${report.run.id} (${report.run.kind}, trigger ${report.run.trigger.kind}), ${report.run.status}${report.run.statusReason ? `: ${report.run.statusReason}` : ''}. Started ${report.run.startedAt ?? 'never'}, finished ${report.run.finishedAt ?? 'not yet'}. Generated ${report.generatedAt}.`, '')
  if (report.gate?.reasons.length) {
    lines.push('## Gate', '', `State: ${report.gate.state}`, '', ...report.gate.reasons.map(reason => `- ${reason}`), '')
  }
  lines.push('## What was tested', '')
  lines.push(`- Rule version (control registry): ${report.registryVersion}`)
  lines.push(`- Profile version: ${report.profileVersion}`)
  lines.push(`- Commit: ${fp.commit ?? 'unknown'}; build: ${fp.build ?? 'unknown'}`)
  lines.push(`- Config hash ${fp.configHash.slice(0, 16)}, policy hash ${fp.policyHash.slice(0, 16)}, dependency hash ${fp.dependencyHash.slice(0, 16)}, routes hash ${fp.routesHash.slice(0, 16)} (computed ${fp.computedAt})`, '')

  if (report.facts.length) {
    lines.push('## Profile facts', '', '| Fact | Value | Set by |', '| --- | --- | --- |')
    for (const fact of report.facts) lines.push(`| ${fact.key} | ${cell(formatFactValue(fact.value)).slice(0, 200)} | ${cell(fact.label)} |`)
    lines.push('')
  }

  lines.push('## Control results', '', '| Control | Class | Status | Rationale |', '| --- | --- | --- | --- |')
  for (const control of report.controls) lines.push(`| ${control.controlId} ${cell(control.title)} | ${control.classification} | ${control.status} | ${cell(control.rationale).slice(0, 400)} |`)
  lines.push('')
  const review = report.controls.flatMap(control => control.humanReview.map(item => ({ control, item })))
  if (review.length) {
    lines.push('### Human review', '')
    for (const { control, item } of review) lines.push(`- ${control.controlId}: ${item.question} (${item.why})`)
    lines.push('')
  }

  const section = (title: string, findings: ReportFinding[]): void => {
    lines.push(`## ${title}`, '')
    if (!findings.length) { lines.push('None.', ''); return }
    for (const finding of findings) {
      lines.push(`### ${finding.controlId} ${finding.title}`, '')
      lines.push(`- Finding ${finding.id}; ${finding.severity}, ${finding.confidence}; status ${finding.status}${finding.route ? `; at ${finding.route}` : ''}`)
      lines.push(`- Expected: ${finding.expected}`)
      lines.push(`- Observed: ${finding.observed}`)
      if (finding.reproduction.length) lines.push(`- Reproduction: ${finding.reproduction.join(' → ')}`)
      if (finding.proposedFix) lines.push(`- Proposed fix: ${finding.proposedFix}`)
      if (finding.evidence.length) lines.push(`- Evidence: ${finding.evidence.join(', ')}`)
      if (finding.legalSources.length) lines.push(`- Sources: ${finding.legalSources.map(source => `${source.title}${source.jurisdiction ? ` (${source.jurisdiction})` : ''}${source.reviewBy ? `, review by ${source.reviewBy}` : ''}`).join('; ')}`)
      if (finding.taskId) lines.push(`- Fix task: ${finding.taskId}`)
      if (finding.waiverId) lines.push(`- Waiver: ${finding.waiverId}`)
      lines.push('')
    }
  }
  section('Legal findings', report.sections.legal)
  section('Technical findings', report.sections.technical)
  section('Internal quality findings', report.sections.internalQuality)

  if (report.verification.length) {
    lines.push('## Independent verification', '', '| Finding | Result | Disagreement |', '| --- | --- | --- |')
    for (const record of report.verification) lines.push(`| ${cell(record.title)} (${record.findingId}) | ${record.status} | ${cell(record.disagreement) || '—'} |`)
    lines.push('')
  }
  lines.push('## Engineering smoke (additional step, not a source item)', '')
  lines.push(report.engineeringSmoke ? `\`${report.engineeringSmoke.command}\`: ${report.engineeringSmoke.status}${report.engineeringSmoke.exitCode !== null ? ` (exit ${report.engineeringSmoke.exitCode})` : ''}. ${report.engineeringSmoke.detail}` : 'No smoke command is configured for this environment.', '')
  if (report.legalSources.length) {
    lines.push('## Legal sources checked', '')
    for (const source of report.legalSources) lines.push(`- ${source.title}: ${source.status}${source.sha256 ? `, content ${source.sha256.slice(0, 16)}` : ''} (${source.checkedAt}) ${source.detail}`)
    lines.push('')
  }
  lines.push('## Coverage', '')
  lines.push(`- Tested: ${report.coverage.tested.map(item => `${item.path} (${item.devices.join('/')})`).join(', ') || 'none'}`)
  lines.push(`- Sampled: ${report.coverage.sampled.map(item => `${item.path} for ${item.standsFor}`).join(', ') || 'none'}`)
  lines.push(`- Excluded: ${report.coverage.excluded.map(item => `${item.path} (${item.reason})`).join(', ') || 'none'}`)
  lines.push(`- Not observable: ${report.coverage.unobservable.join('; ') || 'nothing declared'}`, '')
  lines.push('## Model use', '')
  lines.push(`${report.ledger.modelCalls} call(s), ${report.ledger.tokens} tokens, ${report.ledger.requests} requests${report.ledger.exhausted ? `; budget exhausted: ${report.ledger.exhausted}` : ''}.`)
  for (const call of report.modelCalls) lines.push(`- ${call.role} via ${call.provider}/${call.model}: ${call.refused ? `refused (${call.refused})` : `${call.tokens} tokens`}`)
  lines.push('', '## Evidence', '')
  if (!report.evidence.length) lines.push('No evidence files.')
  for (const ref of report.evidence) lines.push(`- ${ref.id} (${ref.kind}): ${ref.path}, ${cell(ref.description)}`)
  lines.push('')
  return lines.join('\n')
}

/** Writes report.md and report.json into the run's artifacts directory (atomically) and returns their paths. */
export function writeReport(artifactsDir: string, report: ProductionReport): { markdown: string; json: string } {
  mkdirSync(artifactsDir, { recursive: true })
  const paths = { markdown: join(artifactsDir, 'report.md'), json: join(artifactsDir, 'report.json') }
  for (const [path, content] of [[paths.markdown, renderMarkdown(report)], [paths.json, JSON.stringify(report, null, 2)]] as const) {
    writeFileSync(`${path}.tmp`, content)
    renameSync(`${path}.tmp`, path)
  }
  return paths
}
