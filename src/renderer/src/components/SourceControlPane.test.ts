import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DeliveryRun, DeliveryStage, RepositoryFile, RepositoryStatus } from '../../../shared/delivery'
import { DELIVERY_STAGES } from '../../../shared/delivery'
import {
  SourceControlView, durationLabel, fileBadge, groupFiles, orderedStages, requesterLabel, runHeadline,
  shipBlocker, shipPaths, stageElapsed, stageExpanded, type SourceControlViewProps
} from './SourceControlPane'

const file = (path: string, index: string, worktree = ' '): RepositoryFile => ({ path, index, worktree })
const files = [file('src/app.ts', ' ', 'M'), file('notes.md', '?', '?'), file('src/old.ts', 'D'), file('src/new.ts', 'A')]
const status = (patch: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  projectId: 'p1', available: true, reason: null, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0,
  head: 'abcdef1234567890', headSubject: 'Previous change', files, github: { owner: 'Empire024', repo: 'conductor' },
  releaseWorkflow: true, checkedAt: '2026-09-22T10:00:00.000Z', ...patch
})
const stage = (id: DeliveryStage['id'], state: DeliveryStage['state'], patch: Partial<DeliveryStage> = {}): DeliveryStage => ({
  id, label: DELIVERY_STAGES.find(item => item.id === id)!.label, state, startedAt: null, finishedAt: null, detail: '', log: [], ...patch
})
const T0 = '2026-09-22T10:00:00.000Z'
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString()
const run = (patch: Partial<DeliveryRun> = {}): DeliveryRun => ({
  id: 'r1', projectId: 'p1', state: 'running', requestedBy: { kind: 'owner' }, message: 'Ship the panel', paths: null,
  startedAt: T0, finishedAt: null, commit: null, releaseTag: null, releaseUrl: null, workflowRunUrl: null,
  stages: [
    stage('preflight', 'passed', { startedAt: T0, finishedAt: at(1) }),
    stage('test', 'running', { startedAt: at(1), detail: 'npm test', log: ['✓ 120 tests passed so far'] }),
    stage('build', 'pending'), stage('commit', 'pending'), stage('push', 'pending'), stage('release', 'pending')
  ],
  error: null, ...patch
})
const noop = (): void => {}
const render = (patch: Partial<SourceControlViewProps> = {}): string => renderToStaticMarkup(createElement(SourceControlView, {
  status: status(), run: null, message: '', selected: new Set(files.map(item => item.path)), shipping: false, refreshing: false, publish: false, onPublish: () => {},
  error: '', now: Date.parse(at(5)), expanded: {},
  onMessage: noop, onToggleFile: noop, onSelectAll: noop, onShip: noop, onCancel: noop, onRefresh: noop, onToggleStage: noop,
  ...patch
}))

describe('source control helpers', () => {
  it('reduces porcelain status pairs to one badge letter', () => {
    expect(fileBadge(file('a', ' ', 'M'))).toBe('M')
    expect(fileBadge(file('a', 'M', 'M'))).toBe('M')
    expect(fileBadge(file('a', 'A', ' '))).toBe('A')
    expect(fileBadge(file('a', ' ', 'D'))).toBe('D')
    expect(fileBadge(file('a', 'R', ' '))).toBe('R')
    expect(fileBadge(file('a', '?', '?'))).toBe('?')
    expect(fileBadge(file('a', 'U', 'U'))).toBe('U')
    expect(fileBadge(file('a', 'A', 'A'))).toBe('U')
  })
  it('groups tracked changes before untracked files, ordered by kind then path', () => {
    const groups = groupFiles([...files, file('b.ts', 'M')])
    expect(groups.map(group => group.label)).toEqual(['Changes', 'Untracked'])
    expect(groups[0]?.files.map(item => item.path)).toEqual(['b.ts', 'src/app.ts', 'src/new.ts', 'src/old.ts'])
    expect(groups[1]?.files.map(item => item.path)).toEqual(['notes.md'])
    expect(groupFiles([])).toEqual([])
  })
  it('omits paths for the whole tree and sends exactly a partial selection', () => {
    expect(shipPaths(files, new Set(files.map(item => item.path)))).toBeUndefined()
    expect(shipPaths(files, new Set(['src/app.ts', 'missing.ts']))).toEqual(['src/app.ts'])
    expect(shipPaths(files, new Set())).toEqual([])
    expect(shipPaths([], new Set())).toBeUndefined()
  })
  it('explains why Ship is disabled', () => {
    const gate = { status: status(), message: 'Fix it', selectedCount: 4, running: false, shipping: false }
    expect(shipBlocker(gate)).toBeNull()
    expect(shipBlocker({ ...gate, status: null })).toMatch(/Reading/)
    expect(shipBlocker({ ...gate, status: status({ available: false, reason: 'Not a Git repository.' }) })).toBe('Not a Git repository.')
    expect(shipBlocker({ ...gate, running: true })).toMatch(/already running/)
    expect(shipBlocker({ ...gate, message: '   ' })).toMatch(/commit message/)
    expect(shipBlocker({ ...gate, selectedCount: 0 })).toMatch(/Select at least one/)
    expect(shipBlocker({ ...gate, selectedCount: 0, status: status({ files: [] }) })).toMatch(/Nothing to ship/)
    // Committed work that is only ahead can still be pushed with nothing selected.
    expect(shipBlocker({ ...gate, selectedCount: 0, status: status({ ahead: 2 }) })).toBeNull()
  })
  it('formats elapsed time for finished and running stages', () => {
    expect(durationLabel(4_400)).toBe('4s')
    expect(durationLabel(72_000)).toBe('1m 12s')
    expect(durationLabel(3_720_000)).toBe('1h 2m')
    expect(stageElapsed({ startedAt: T0, finishedAt: at(3) }, 0)).toBe('3s')
    expect(stageElapsed({ startedAt: T0, finishedAt: null }, Date.parse(at(9)))).toBe('9s')
    expect(stageElapsed({ startedAt: null, finishedAt: null }, 0)).toBe('')
  })
  it('orders stages by the pipeline and fills unreported ones as pending', () => {
    const stages = orderedStages(run({ stages: [stage('push', 'passed'), stage('preflight', 'passed')] }))
    expect(stages.map(item => item.id)).toEqual(DELIVERY_STAGES.map(item => item.id))
    expect(stages[1]?.state).toBe('pending')
  })
  it('opens the running and failed stage logs unless toggled', () => {
    expect(stageExpanded(stage('test', 'running'), {})).toBe(true)
    expect(stageExpanded(stage('test', 'failed'), {})).toBe(true)
    expect(stageExpanded(stage('test', 'passed'), {})).toBe(false)
    expect(stageExpanded(stage('test', 'failed'), { test: false })).toBe(false)
  })
  it('summarises a run into a headline', () => {
    expect(runHeadline(run())).toEqual({ tone: 'running', title: 'Run tests…', detail: 'Stage 2 of 6' })
    expect(runHeadline(run({ state: 'delivered', commit: '0123456789', releaseTag: 'v1.2.3' }))).toEqual({ tone: 'delivered', title: 'Delivered v1.2.3', detail: 'commit 0123456 · release verified' })
    const failed = runHeadline(run({ state: 'failed', error: 'Build failed: tsc exited 2', stages: [stage('build', 'failed')] }))
    expect(failed).toEqual({ tone: 'failed', title: 'Failed at build', detail: 'Build failed: tsc exited 2' })
    expect(runHeadline(run({ state: 'cancelled', error: 'Cancelled by the owner.' })).detail).toBe('Cancelled by the owner.')
  })
  it('names who asked for the delivery', () => {
    expect(requesterLabel(run())).toBe('You')
    expect(requesterLabel(run({ requestedBy: { kind: 'agent', agentSessionId: 's1', title: 'Fix sidebar' } }))).toBe('Fix sidebar')
  })
})

describe('source control view', () => {
  it('shows repository facts and every change selected when idle', () => {
    const html = render()
    expect(html).toContain('main')
    expect(html).toContain('abcdef1')
    expect(html).toContain('Previous change')
    expect(html).toContain('Empire024/conductor')
    expect(html).toContain('Local commit; no push or release')
    expect(html).toContain('Publish release')
    expect(html).not.toContain('Release workflow will be')
    expect(render({ publish: true })).toContain('Release workflow will be started and verified')
    expect(render({ publish: true })).toContain('Ship &amp; publish')
    expect(html).toContain('4 of 4 changes selected')
    expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(4)
    expect(html).toContain('badge-untracked')
    expect(html).not.toContain('isolated copy')
    // No message yet, so Ship is disabled and says why.
    expect(html).toMatch(/<button type="submit" class="scp-ship" disabled=""/)
    expect(html).toContain('Write a commit message.')
  })
  it('enables Ship with a message and hints that a partial selection is verified in isolation', () => {
    const html = render({ message: 'Ship it', selected: new Set(['src/app.ts']) })
    expect(html).not.toMatch(/class="scp-ship" disabled/)
    expect(html).toContain('1 of 4 changes selected')
    expect(html).toContain('isolated copy')
  })
  it('shows only the reason when delivery is unavailable', () => {
    const html = render({ status: status({ available: false, reason: 'This project is not a Git repository.' }) })
    expect(html).toContain('This project is not a Git repository.')
    expect(html).not.toContain('scp-ship')
    expect(html).not.toContain('type="checkbox"')
  })
  it('renders a running run with its live stage expanded and a Cancel button', () => {
    const html = render({ run: run(), message: 'Ship the panel' })
    expect(html).toContain('Run tests…')
    expect(html).toContain('Cancel')
    expect(html).toContain('state-running')
    expect(html).toContain('✓ 120 tests passed so far')
    expect(html).toContain('npm test')
    expect(html).toContain('>4s<')
    expect(html).toContain('>You<')
    expect(html).toContain('A delivery is already running.')
    expect(html.match(/data-stage=/g)).toHaveLength(6)
  })
  it('renders a failure prominently with the failing stage and its log', () => {
    const html = render({ run: run({
      state: 'failed', finishedAt: at(30), error: 'Tests failed: 2 failing in delivery.test.ts',
      requestedBy: { kind: 'agent', agentSessionId: 's1', title: 'Fix sidebar' },
      stages: [stage('preflight', 'passed'), stage('test', 'failed', { detail: 'vitest exited 1', log: ['FAIL delivery.test.ts'] })]
    }) })
    expect(html).toContain('Failed at run tests')
    expect(html).toContain('scp-banner-error')
    expect(html).toContain('Tests failed: 2 failing in delivery.test.ts')
    expect(html).toContain('FAIL delivery.test.ts')
    expect(html).toContain('Fix sidebar')
    expect(html).not.toContain('Cancel')
  })
  it('renders a delivered run with release and workflow links', () => {
    const html = render({ status: status({ files: [] }), run: run({
      state: 'delivered', finishedAt: at(200), commit: '0123456789abcdef', releaseTag: 'v1.4.2',
      releaseUrl: 'https://github.com/Empire024/conductor/releases/tag/v1.4.2', workflowRunUrl: 'https://github.com/Empire024/conductor/actions/runs/1',
      stages: DELIVERY_STAGES.map(item => stage(item.id, 'passed', { log: ['ok'] }))
    }) })
    expect(html).toContain('Delivered v1.4.2')
    expect(html).toContain('href="https://github.com/Empire024/conductor/releases/tag/v1.4.2" target="_blank" rel="noreferrer"')
    expect(html).toContain('Workflow run')
    expect(html).toContain('Working tree clean')
    expect(html).not.toContain('<pre')
    expect(html).toContain('Nothing to ship')
  })
})
