import { describe, expect, it, vi } from 'vitest'
import type { CloudRunSummary } from '../../shared/cloud'
import { CLOUD_MUTATION_METHODS, CLOUD_READ_METHODS, callCloudMethod, cloudCatalogEntry, cloudMethods, cloudSignatures, type CloudCaller } from './control'
import type { CloudRuns } from './runs'
import { CONTROL_METHOD_CLASSES } from '../control-method-classes'

const run = (patch: Partial<CloudRunSummary> = {}): CloudRunSummary => ({
  id: 'cloud_1', projectId: 'p', workspaceId: 'w', title: 'Note', prompt: 'Add a note', model: 'claude-opus-5-5', effort: null, ref: null,
  status: 'running', attached: false, liveView: false, cwd: 'C:/project', branchHint: null, headCommit: null, transcriptAt: null, transcriptEntries: 0, usage: null, sessionId: 'session_01X', sessionUrl: 'https://claude.ai/code/session_01X', confirmedModel: null, branch: null, prUrl: null,
  worktreePath: null, fetchedCommit: null, startedBy: 'agent_c', createdAt: 1, updatedAt: 1, endedAt: null, exitCode: null, error: null, ...patch
})

const fakeRuns = (): CloudRuns & Record<string, ReturnType<typeof vi.fn>> => ({
  available: vi.fn(() => true),
  list: vi.fn(() => [run()]),
  get: vi.fn((id: string, projectId?: string) => { if (id !== 'cloud_1' || projectId !== undefined && projectId !== 'p') throw new Error('No cloud run with that id in this project'); return run() }),
  start: vi.fn((input: Record<string, unknown>) => run({ prompt: String(input.prompt), startedBy: String(input.startedBy) })),
  refreshResult: vi.fn(async () => run({ branch: 'claude/x' })),
  transcript: vi.fn(async () => [{ role: 'assistant', text: 'Done', at: null }]),
  screen: vi.fn(() => '● Done\n>'),
  send: vi.fn(async () => run()),
  interrupt: vi.fn(() => run()),
  stop: vi.fn(async () => run({ status: 'stopped' })),
  attach: vi.fn(() => run()),
  fetch: vi.fn(async () => ({ worktreePath: 'W', commit: 'c', ref: 'refs/heads/claude/x', branch: 'claude/x', prUrl: null, diffStat: '' }))
}) as unknown as CloudRuns & Record<string, ReturnType<typeof vi.fn>>

const caller = (patch: Partial<CloudCaller> = {}): CloudCaller => ({
  projectId: 'p', workspaceId: 'w', projectPath: 'C:/project', startedBy: 'agent_c', refusal: null, openTab: vi.fn(async () => ({ id: 'tab_1', kind: 'cloud' })), ...patch
})

describe('cloud.* control methods', () => {
  it('starts a run on the caller\'s project and opens its tab', async () => {
    const runs = fakeRuns(), who = caller()
    const result = await callCloudMethod(runs, who, 'cloud.start', { prompt: 'Add a note', model: 'claude-sonnet-5', focus: false }) as CloudRunSummary & { tab: unknown }
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', workspaceId: 'w', cwd: 'C:/project', prompt: 'Add a note', model: 'claude-sonnet-5', startedBy: 'agent_c' }))
    expect(who.openTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud_1' }), false)
    expect(result.tab).toEqual({ id: 'tab_1', kind: 'cloud' })
  })

  it('refuses mutations for a caller that may not spend cloud credit, but lets it read', async () => {
    const runs = fakeRuns(), who = caller({ refusal: 'This conversation is read-only or planning' })
    for (const method of CLOUD_MUTATION_METHODS) await expect(callCloudMethod(runs, who, method, { runId: 'cloud_1', prompt: 'x', message: 'y' })).rejects.toThrow(/read-only/)
    expect(runs.start).not.toHaveBeenCalled()
    await expect(callCloudMethod(runs, who, 'cloud.list', {})).resolves.toHaveLength(1)
    await expect(callCloudMethod(runs, who, 'cloud.status', { runId: 'cloud_1' })).resolves.toMatchObject({ branch: 'claude/x', screen: '● Done\n>' })
    await expect(callCloudMethod(runs, who, 'cloud.transcript', { runId: 'cloud_1' })).resolves.toMatchObject({ total: 1 })
    await expect(callCloudMethod(runs, who, 'cloud.transcript', { runId: 'cloud_1', refresh: true })).rejects.toThrow(/read-only/)
  })

  it('keeps runs to their project and rejects arguments it does not know', async () => {
    const runs = fakeRuns()
    await expect(callCloudMethod(runs, caller({ projectId: 'other' }), 'cloud.status', { runId: 'cloud_1' })).rejects.toThrow(/No cloud run/)
    await expect(callCloudMethod(runs, caller(), 'cloud.send', { runId: 'cloud_1', message: 'x', force: true })).rejects.toThrow(/Unsupported argument/)
    await expect(callCloudMethod(runs, caller(), 'cloud.status', { runId: 'cloud_1', lines: 5000 })).rejects.toThrow(/lines/)
    await expect(callCloudMethod(runs, caller({ projectPath: null }), 'cloud.start', { prompt: 'x' })).rejects.toThrow(/this machine/)
  })

  it('routes steering, stopping, attaching and fetching to the run', async () => {
    const runs = fakeRuns()
    await callCloudMethod(runs, caller(), 'cloud.send', { runId: 'cloud_1', message: 'more' })
    expect(runs.send).toHaveBeenCalledWith('cloud_1', 'more')
    await callCloudMethod(runs, caller(), 'cloud.interrupt', { runId: 'cloud_1' })
    await callCloudMethod(runs, caller(), 'cloud.stop', { runId: 'cloud_1' })
    await callCloudMethod(runs, caller(), 'cloud.attach', { runId: 'cloud_1' })
    expect(runs.attach).toHaveBeenCalledWith('cloud_1')
    await expect(callCloudMethod(runs, caller(), 'cloud.fetch', { runId: 'cloud_1' })).resolves.toMatchObject({ worktreePath: 'W', branch: 'claude/x' })
    expect(runs.fetch).toHaveBeenCalledWith('cloud_1')
    await expect(callCloudMethod(runs, caller(), 'cloud.transcript', { runId: 'cloud_1', refresh: true, limit: 5 })).resolves.toMatchObject({ total: 1, entries: [{ text: 'Done' }] })
    expect(runs.transcript).toHaveBeenCalledWith('cloud_1', true)
  })

  it('refuses to start without the CLI', async () => {
    const runs = fakeRuns(); (runs.available as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await expect(callCloudMethod(runs, caller(), 'cloud.start', { prompt: 'x' })).rejects.toThrow(/not installed/)
  })

  it('lists the cloud models for models.list and classifies every method for the control server', () => {
    const entry = cloudCatalogEntry(true)
    expect(entry.provider).toBe('cloud')
    expect(entry.models.map(model => model.id)).toContain('claude-opus-5-5')
    expect(entry.models.find(model => model.isDefault)?.id).toBe('claude-opus-5-5')
    expect(entry.models[0]!.effort).toContain('high')
    expect([...cloudMethods].sort()).toEqual([...CLOUD_READ_METHODS, ...CLOUD_MUTATION_METHODS].sort())
    for (const method of CLOUD_READ_METHODS) expect(CONTROL_METHOD_CLASSES.has(`read:${method}`)).toBe(true)
    for (const method of CLOUD_MUTATION_METHODS) expect(CONTROL_METHOD_CLASSES.has(`mutation:${method}`)).toBe(true)
    expect(Object.keys(cloudSignatures)).toHaveLength(9)
  })
})
