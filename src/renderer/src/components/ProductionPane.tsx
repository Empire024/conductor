import { useCallback, useEffect, useRef, useState } from 'react'
import { BadgeCheck, FileSearch, FileText, ListOrdered, ListPlus, Play, Radar, RotateCcw, TriangleAlert } from 'lucide-react'
import type {
  DriftSettings, ProductionBridge, ProductionEnvironment, ProductionProjectSnapshot, WaiverRequest, WriteAuthorizationRequest
} from '../../../shared/production'
import { GateBadge } from './production/GateBadge'
import { QuestionList } from './production/QuestionList'
import { ControlTable } from './production/ControlTable'
import { FindingList } from './production/FindingList'
import { FindingDetail } from './production/FindingDetail'
import { WaiverForm, WaiverList } from './production/WaiverForm'
import { RunList } from './production/RunList'
import { EnvironmentForm, EnvironmentList } from './production/EnvironmentForm'
import { WriteAuthorizations } from './production/WriteAuthorizations'
import { DriftSettingsForm } from './production/DriftSettingsForm'
import { ReasonForm } from './production/ReasonForm'
import { answerQuestion, chosenEnvironment, errorText, isOpenFinding, pendingId, reportRun, type PendingAction } from './production/production-model'
import './ProductionPane.css'

/**
 * The Production drawer (docs/production-agent.md section 9): one project's designation, audit
 * gate with its reasons, owner questions, control results, findings, waivers, runs, environments,
 * sandbox write authorizations and drift checks. The renderer is the owner's window, so every
 * action here acts with owner authority; sovereign gating applies to control-method callers.
 */

/** Opens the aggregate queue as a workspace tab (App listens). */
export const OPEN_PRODUCTION_QUEUE_EVENT = 'conductor:open-production-queue'
/** Switches to a project and opens its Production drawer (App listens); detail `{ projectId }`. */
export const OPEN_PRODUCTION_EVENT = 'conductor:open-production'
/** Opens the project task board where fix tasks live (App listens). */
export const OPEN_PROJECT_TASKS_EVENT = 'conductor:open-project-tasks'

const POLL_WHILE_RUNNING_MS = 1_500

export interface Failure { scope: string; message: string }

export interface ProductionHandlers {
  onEnvironment(environmentId: string): void
  onDesignate(productionReady: boolean): void
  onAudit(): void
  onRetest(): void
  onVerify(): void
  onCreateTasks(): void
  onOpenEvidence(runId: string, evidenceId: string): void
  onOpenReport(runId: string): void
  onOpenQueue(): void
  onOpenTasks(): void
  onAnswer(questionId: string, answer: string): void
  /** Opens (or closes, with null) the in-panel confirmation of a settling action. */
  onPending(action: PendingAction | null): void
  /** The confirmed actions; each runs only from its ReasonForm. */
  onDismiss(questionId: string, reason: string): void
  onToggleFinding(findingId: string): void
  onOpenFinding(findingId: string | null): void
  onStartWaive(findingId: string | null): void
  onWaive(request: WaiverRequest): void
  onRevokeWaiver(waiverId: string, reason: string): void
  onPause(runId: string): void
  onResume(runId: string): void
  onCancel(runId: string, reason: string): void
  onAddEnvironment(environment: ProductionEnvironment): void
  onRemoveEnvironment(environmentId: string): void
  onDriftForm(open: boolean): void
  onSaveDrift(drift: DriftSettings): void
  onGrantWrites(request: WriteAuthorizationRequest): void
  onRevokeWrites(authorizationId: string): void
}

export interface ProductionViewProps extends ProductionHandlers {
  snapshot: ProductionProjectSnapshot
  environmentId: string | null
  selected: ReadonlySet<string>
  openFindingId: string | null
  waivingFindingId: string | null
  driftOpen: boolean
  /** The settling action awaiting confirmation in the panel, if any. */
  pending?: PendingAction | null
  busy: string
  failure: Failure | null
  notice: string
  now: number
  /** False only for a caller without owner authority; the owner's own panel always designates. */
  canDesignate?: boolean
}

const Section = ({ title, count, children }: { title: string; count?: number; children: React.ReactNode }): React.JSX.Element =>
  <section className="production-section" aria-label={title}>
    <h3>{title}{count !== undefined && <span className="production-count">{count}</span>}</h3>
    {children}
  </section>

export function ProductionView(props: ProductionViewProps): React.JSX.Element {
  const { snapshot, busy, failure, now } = props
  const profile = snapshot.profile
  const environments = profile?.environments ?? []
  const environment = chosenEnvironment(snapshot, props.environmentId)
  const envId = environment?.id ?? null
  const findings = snapshot.findings.filter(finding => !envId || finding.environmentId === envId)
  const runs = snapshot.runs.filter(run => !envId || run.environmentId === envId)
  const selected = findings.filter(finding => props.selected.has(finding.id)).map(finding => finding.id)
  const openFinding = findings.find(finding => finding.id === props.openFindingId) ?? null
  const waiving = findings.find(finding => finding.id === props.waivingFindingId) ?? null
  const report = reportRun(runs, envId)
  const questions = profile?.questions ?? []
  const openQuestions = questions.filter(question => question.status === 'open').length
  const designation = profile?.designation
  const designatedHere = Boolean(designation?.productionReady && designation.environmentId === envId)
  const canDesignate = props.canDesignate ?? true
  const designateTitle = !canDesignate ? 'Only the owner or a wizard tab can change production readiness'
    : !environment ? 'Add an environment first; readiness always names one'
      : designatedHere ? `Production-ready since ${designation?.at ?? 'unknown'}; uncheck to withdraw` : `Mark ${environment.label} production-ready and start the first audit`
  const failureAt = (scope: string): string => failure?.scope === scope ? failure.message : ''
  const activeHere = snapshot.activeRun && snapshot.activeRun.environmentId === envId ? snapshot.activeRun : null
  const gateForOther = snapshot.gate.environmentId && envId && snapshot.gate.environmentId !== envId
  const pending = props.pending ?? null
  const closePending = (): void => props.onPending(null)
  const dismissing = pendingId(pending, 'dismiss'), revoking = pendingId(pending, 'revoke')
  const cancelling = pendingId(pending, 'cancel'), removing = pendingId(pending, 'remove-environment')

  return <div className="production-pane" data-project-id={snapshot.projectId}>
    <header className="production-header">
      <div className="production-header-row">
        <label className="production-env-picker"><span>Environment</span>
          <select aria-label="Environment" value={envId ?? ''} disabled={!environments.length} onChange={event => props.onEnvironment(event.target.value)}>
            {!environments.length && <option value="">No environment</option>}
            {environments.map(item => <option key={item.id} value={item.id}>{item.label} ({item.kind})</option>)}
          </select>
        </label>
        <label className="production-check production-designation" title={designateTitle}>
          <input type="checkbox" aria-label="Production-ready" checked={designatedHere} disabled={!canDesignate || !environment || Boolean(busy)}
            onChange={event => props.onDesignate(event.target.checked)} />Production-ready
        </label>
        <button type="button" className="production-icon-button" onClick={props.onOpenQueue} title="Open the production queue of every designated project"><ListOrdered size={13} />Queue</button>
      </div>
      <GateBadge gate={snapshot.gate} />
      {gateForOther && <p className="production-muted">The gate above is for {environments.find(item => item.id === snapshot.gate.environmentId)?.label ?? snapshot.gate.environmentId}.</p>}
      {snapshot.browser && !snapshot.browser.available && <p className="production-warning"><TriangleAlert size={12} />No audit browser: {snapshot.browser.reason ?? 'no Chromium, Edge or Chrome found'}. Runs end BLOCKED until one is available.</p>}
      <div className="production-actions" role="toolbar" aria-label="Production actions">
        <button type="button" className="primary" disabled={Boolean(busy) || !environment || Boolean(activeHere)} onClick={props.onAudit} title={activeHere ? 'A run is already active for this environment' : 'Audit this environment now'}><Play size={12} />Audit</button>
        <button type="button" disabled={Boolean(busy) || !selected.length} onClick={props.onRetest} title="Re-run the checks of the selected findings"><RotateCcw size={12} />Re-test{selected.length ? ` (${selected.length})` : ''}</button>
        <button type="button" disabled={Boolean(busy) || !selected.length} onClick={props.onVerify} title="Independently verify the selected findings in a fresh browser"><BadgeCheck size={12} />Verify{selected.length ? ` (${selected.length})` : ''}</button>
        <button type="button" disabled={Boolean(busy) || !selected.length} onClick={props.onCreateTasks} title="One board task per selected finding; existing tasks are reused"><ListPlus size={12} />Create fix tasks</button>
        <button type="button" disabled={Boolean(busy) || !openFinding?.evidence.length} onClick={() => openFinding && props.onOpenEvidence(openFinding.lastSeenRunId, openFinding.evidence[0]!)} title={openFinding ? 'Open the first evidence file of the open finding' : 'Open a finding to see its evidence'}><FileSearch size={12} />Open evidence</button>
        <button type="button" disabled={Boolean(busy) || !report} onClick={() => report && props.onOpenReport(report.id)} title={report ? `Open the report of run ${report.id}` : 'No completed run with a report yet'}><FileText size={12} />Open report</button>
        <button type="button" disabled={Boolean(busy) || !profile} onClick={() => props.onDriftForm(!props.driftOpen)} aria-expanded={props.driftOpen}>
          <Radar size={12} />{profile?.drift.enabled ? `Drift checks: every ${Math.round(profile.drift.everyMinutes / 60)} h` : 'Enable drift checks'}
        </button>
      </div>
      {failureAt('pane') && <p className="production-error" role="alert">{failureAt('pane')}</p>}
      {props.notice && <p className="production-notice" role="status">{props.notice}</p>}
      {props.driftOpen && profile && <DriftSettingsForm drift={profile.drift} busy={busy === 'drift'} error={failureAt('drift')} onSave={props.onSaveDrift} onCancel={() => props.onDriftForm(false)} />}
    </header>

    {!profile && <Section title="Get started">
      <p className="production-intro">Production audits a website or web app you designate production-ready against sixteen controls (privacy, consent, identity, pricing, accessibility and more). Add the environment to audit; the audit browser only ever reads from production.</p>
      <EnvironmentForm existing={[]} busy={busy === 'environment'} error={failureAt('environment')} onSave={props.onAddEnvironment} />
    </Section>}

    {profile && <>
      <Section title="Owner questions" count={openQuestions}>
        <QuestionList questions={questions} busy={busy} error={failureAt('questions')} onAnswer={props.onAnswer}
          onDismiss={questionId => props.onPending({ kind: 'dismiss', questionId })} confirmId={dismissing}
          confirm={dismissing && <ReasonForm key={dismissing} label="Dismiss question" consequence="Dismissing keeps the fact unknown: the controls this question blocks stay unverified."
            reasonLabel="Why dismiss it" reasonRequired confirmLabel="Dismiss question" busy={busy === `dismiss:${dismissing}`} error={failureAt('pending')}
            onSubmit={reason => props.onDismiss(dismissing, reason)} onCancel={closePending} />} />
      </Section>
      <Section title="Controls">
        <ControlTable results={snapshot.results} gate={snapshot.gate} />
      </Section>
      <Section title="Findings" count={findings.filter(isOpenFinding).length}>
        <FindingList findings={findings} selected={props.selected} openId={openFinding?.id ?? null} onToggle={props.onToggleFinding} onOpen={props.onOpenFinding} />
        {openFinding && <FindingDetail finding={openFinding} waiver={snapshot.waivers.find(waiver => waiver.id === openFinding.waiverId) ?? null} busy={busy}
          onOpenEvidence={props.onOpenEvidence} onOpenTasks={props.onOpenTasks} onWaive={id => props.onStartWaive(id)} />}
        {waiving && <WaiverForm key={waiving.id} finding={waiving} busy={busy === 'waive'} error={failureAt('waive')} now={now} onSubmit={props.onWaive} onCancel={() => props.onStartWaive(null)} />}
      </Section>
      <Section title="Waivers" count={snapshot.waivers.filter(waiver => !waiver.revokedAt && Date.parse(waiver.expiresAt) > now).length}>
        <WaiverList waivers={snapshot.waivers} findings={snapshot.findings} busy={busy} now={now}
          onRevoke={waiverId => props.onPending({ kind: 'revoke', waiverId })} confirmId={revoking}
          confirm={revoking && <ReasonForm key={revoking} label="Revoke waiver" consequence="Revoking keeps the waiver on record and reopens its finding."
            reasonLabel="Why revoke it" reasonRequired confirmLabel="Revoke waiver" busy={busy === `revoke:${revoking}`} error={failureAt('pending')}
            onSubmit={reason => props.onRevokeWaiver(revoking, reason)} onCancel={closePending} />} />
      </Section>
      <Section title="Runs">
        {failureAt('runs') && <p className="production-error" role="alert">{failureAt('runs')}</p>}
        <RunList runs={runs} busy={busy} onPause={props.onPause} onResume={props.onResume} onOpenReport={props.onOpenReport}
          onCancel={runId => props.onPending({ kind: 'cancel', runId })} confirmId={cancelling}
          confirm={cancelling && <ReasonForm key={cancelling} label="Cancel run" consequence="Cancelling stops the run; its finished steps and evidence are kept."
            reasonLabel="Reason" reasonRequired={false} confirmLabel="Cancel run" busy={busy === `cancel:${cancelling}`} error={failureAt('pending')}
            onSubmit={reason => props.onCancel(cancelling, reason || 'Cancelled from the Production panel')} onCancel={closePending} />} />
      </Section>
      <Section title="Environments" count={environments.length}>
        <EnvironmentList environments={environments} designatedId={designation?.productionReady ? designation.environmentId : null} busy={busy}
          onRemove={environmentId => props.onPending({ kind: 'remove-environment', environmentId })} confirmId={removing}
          confirm={removing && <ReasonForm key={removing} label="Remove environment" consequence="Removing the environment keeps its past runs and findings."
            reasonLabel={null} reasonRequired={false} confirmLabel="Remove environment" busy={busy === `environment:${removing}`} error={failureAt('pending')}
            onSubmit={() => props.onRemoveEnvironment(removing)} onCancel={closePending} />} />
        <details className="production-add-environment">
          <summary>Add environment</summary>
          <EnvironmentForm existing={environments} busy={busy === 'environment'} error={failureAt('environment')} onSave={props.onAddEnvironment} />
        </details>
      </Section>
      <Section title="Sandbox write authorizations" count={profile.writeAuthorizations.length}>
        {failureAt('writes') && <p className="production-error" role="alert">{failureAt('writes')}</p>}
        <WriteAuthorizations authorizations={profile.writeAuthorizations} environments={environments} busy={busy} now={now} onGrant={props.onGrantWrites} onRevoke={props.onRevokeWrites} />
      </Section>
    </>}
  </div>
}

export function ProductionPane({ projectId, bridge = window.conductor.production }: { projectId: string; bridge?: ProductionBridge }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ProductionProjectSnapshot | null>(null)
  const [environmentId, setEnvironmentId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [openFindingId, setOpenFindingId] = useState<string | null>(null)
  const [waivingFindingId, setWaivingFindingId] = useState<string | null>(null)
  const [driftOpen, setDriftOpen] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // App renders this pane without a key, so a project switch arrives as a new prop: answers for
  // the previous project are dropped rather than shown under the new one.
  const shownProject = useRef(projectId)

  const load = useCallback(async () => {
    try {
      const next = await bridge.snapshot(projectId)
      if (shownProject.current !== projectId) return
      setSnapshot(next)
      setNow(Date.now())
      setFailure(current => current?.scope === 'pane' ? null : current)
    } catch (reason) {
      if (shownProject.current === projectId) setFailure({ scope: 'pane', message: errorText(reason) })
    }
  }, [bridge, projectId])

  useEffect(() => {
    shownProject.current = projectId
    setSnapshot(null); setEnvironmentId(null); setSelected(new Set()); setOpenFindingId(null); setWaivingFindingId(null)
    setDriftOpen(false); setPending(null); setBusy(''); setFailure(null); setNotice('')
    void load()
  }, [projectId, load])
  useEffect(() => bridge.onChanged(changed => { if (changed === projectId) void load() }), [bridge, load, projectId])
  const running = Boolean(snapshot?.activeRun)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => void load(), POLL_WHILE_RUNNING_MS)
    return () => window.clearInterval(timer)
  }, [running, load])

  /** One action at a time; an error lands in the section the action was started from. */
  const act = async (key: string, scope: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(key); setFailure(null); setNotice('')
    try { await action(); await load(); return true }
    catch (reason) { setFailure({ scope, message: errorText(reason) }); return false }
    finally { setBusy('') }
  }

  if (!snapshot) {
    return <div className="production-pane">
      {failure ? <p className="production-error" role="alert">{failure.message}</p> : <p className="production-muted">Loading production audit…</p>}
    </div>
  }

  const environment = chosenEnvironment(snapshot, environmentId)
  const profile = snapshot.profile
  const selectedIds = snapshot.findings.filter(finding => selected.has(finding.id) && finding.environmentId === environment?.id).map(finding => finding.id)
  const clearSelection = (): void => setSelected(new Set())
  const saveEnvironments = (environments: ProductionEnvironment[]): Promise<unknown> => bridge.updateProfile(projectId, { environments })
  /** A confirmed settling action: its error stays in the confirmation, which closes only on success. */
  const settle = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    if (await act(key, 'pending', action)) setPending(null)
  }

  return <ProductionView
    snapshot={snapshot} environmentId={environment?.id ?? null} selected={selected} openFindingId={openFindingId} waivingFindingId={waivingFindingId}
    driftOpen={driftOpen} pending={pending} busy={busy} failure={failure} notice={notice} now={now}
    onEnvironment={id => { setEnvironmentId(id); clearSelection(); setOpenFindingId(null); setWaivingFindingId(null) }}
    onDesignate={productionReady => void act('designate', 'pane', () => bridge.designate(projectId, {
      productionReady, environmentId: environment?.id ?? null, note: productionReady ? 'Designated from the Production panel' : 'Withdrawn from the Production panel'
    }))}
    onAudit={() => void act('audit', 'pane', async () => {
      const run = await bridge.audit(projectId, { environmentId: environment?.id })
      setNotice(`Audit ${run.id} is ${run.status}.`)
    })}
    onRetest={() => void act('retest', 'pane', async () => { const run = await bridge.retest(projectId, selectedIds); clearSelection(); setNotice(`Re-test ${run.id} is ${run.status}.`) })}
    onVerify={() => void act('verify', 'pane', async () => { const run = await bridge.verify(projectId, selectedIds); clearSelection(); setNotice(`Verification ${run.id} is ${run.status}.`) })}
    onCreateTasks={() => void act('tasks', 'pane', async () => {
      const tasks = await bridge.createFixTasks(projectId, selectedIds)
      const created = tasks.filter(task => task.created).length
      setNotice(`${created} fix task${created === 1 ? '' : 's'} created${tasks.length - created ? `, ${tasks.length - created} already had one` : ''}.`)
    })}
    onOpenEvidence={(runId, evidenceId) => void act('evidence', 'pane', () => bridge.openEvidence(projectId, runId, evidenceId))}
    onOpenReport={runId => void act('report', 'pane', () => bridge.openReport(projectId, runId))}
    onOpenQueue={() => window.dispatchEvent(new CustomEvent(OPEN_PRODUCTION_QUEUE_EVENT))}
    onOpenTasks={() => window.dispatchEvent(new CustomEvent(OPEN_PROJECT_TASKS_EVENT))}
    onAnswer={(questionId, answer) => void act(`answer:${questionId}`, 'questions', () => answerQuestion(bridge, projectId, questionId, answer))}
    onPending={action => { setFailure(null); setPending(action) }}
    onDismiss={(questionId, reason) => void settle(`dismiss:${questionId}`, () => bridge.dismissQuestion(projectId, questionId, reason))}
    onToggleFinding={id => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })}
    onOpenFinding={id => { setOpenFindingId(id); if (id !== waivingFindingId) setWaivingFindingId(null) }}
    onStartWaive={id => { setFailure(null); setWaivingFindingId(id) }}
    onWaive={request => void act('waive', 'waive', async () => { await bridge.waive(projectId, request); setWaivingFindingId(null) })}
    onRevokeWaiver={(waiverId, reason) => void settle(`revoke:${waiverId}`, () => bridge.revokeWaiver(projectId, waiverId, reason))}
    onPause={runId => void act(`pause:${runId}`, 'runs', () => bridge.pause(projectId, runId))}
    onResume={runId => void act(`resume:${runId}`, 'runs', () => bridge.resume(projectId, runId))}
    onCancel={(runId, reason) => void settle(`cancel:${runId}`, () => bridge.cancel(projectId, runId, reason))}
    onAddEnvironment={added => void act('environment', 'environment', async () => {
      await saveEnvironments([...(profile?.environments ?? []), added])
      setEnvironmentId(added.id)
    })}
    onRemoveEnvironment={removed => void settle(`environment:${removed}`, () => saveEnvironments((profile?.environments ?? []).filter(item => item.id !== removed)))}
    onDriftForm={setDriftOpen}
    onSaveDrift={drift => void act('drift', 'drift', async () => { await bridge.updateProfile(projectId, { drift }); setDriftOpen(false) })}
    onGrantWrites={request => void act('writes', 'writes', () => bridge.authorizeWrites(projectId, request))}
    onRevokeWrites={id => void act(`writes:${id}`, 'writes', () => bridge.revokeWrites(projectId, id))}
  />
}
