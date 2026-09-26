import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { OrchestrationStore } from './orchestration-store'
import { startRosterAgent } from './agent-roster'
import { ROSTER_ROLES, rosterRole, rosterStartPrompt } from '../shared/agent-roster'

const withProject = (briefs: string[], run: (store: OrchestrationStore, projectId: string) => void | Promise<void>) => async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-agent-roster-'))
  const folder = join(root, 'project')
  for (const brief of briefs) { mkdirSync(dirname(join(folder, brief)), { recursive: true }); writeFileSync(join(folder, brief), '# brief\n') }
  mkdirSync(folder, { recursive: true })
  const path = join(root, 'conductor.db')
  const database = new ConductorDatabase(path)
  const project = database.upsertProject(folder, 'Project')
  const store = new OrchestrationStore(path)
  try { await run(store, project.id) } finally {
    store.close(); database.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

const everyBrief = [...new Set(ROSTER_ROLES.flatMap(role => role.briefs))]

describe('the Agent roster lists the roles Conductor actually runs', () => {
  it('covers every role the owner named, each with model, permission, brief and when to use it', () => {
    const roles = ROSTER_ROLES.map(role => role.role)
    for (const expected of ['swarm-orchestrator', 'swarm-fixer', 'verifier', 'verifier-runner', 'approval-reviewer', 'updater', 'loop-runner', 'loop-improver', 'overseer', 'recovery-agent', 'project-controller', 'local-helper', 'cloud-coworker']) expect(roles).toContain(expected)
    expect(new Set(roles).size).toBe(roles.length)
    for (const role of ROSTER_ROLES) {
      expect(role.model, role.role).toBeTruthy()
      expect(role.permission, role.role).toBeTruthy()
      expect(role.whenToUse.length, role.role).toBeGreaterThan(20)
      expect(role.briefs.length, role.role).toBeGreaterThan(0)
      for (const brief of role.briefs) expect(role.instructions, role.role).toContain(brief)
    }
  })

  it('points at briefs that exist in this repository', () => {
    const repo = resolve(__dirname, '..', '..')
    for (const brief of everyBrief) expect(existsSync(join(repo, brief)), brief).toBe(true)
  })

  it('seeds the roles into a project that holds their briefs, with their model', withProject(everyBrief, (store, projectId) => {
    const agents = store.snapshot(projectId).agents
    for (const role of ROSTER_ROLES) {
      const entry = agents.find(agent => agent.role === role.role)
      expect(entry, role.role).toBeDefined()
      expect(entry!.name).toBe(role.name)
      expect(entry!.provider).toBe(role.provider)
      expect(entry!.model).toBe(role.model)
      expect(entry!.instructions).toBe(role.instructions)
    }
    expect(agents.some(agent => agent.role === 'auto-fixer')).toBe(true)
    // Read again: still one row per role.
    expect(store.snapshot(projectId).agents).toHaveLength(agents.length)
  }))

  it('leaves them out of an unrelated project', withProject([], (store, projectId) => {
    expect(store.snapshot(projectId).agents.map(agent => agent.role)).toEqual(['auto-fixer'])
  }))

  it('keeps the owner\'s model choice for a seeded role', withProject(everyBrief, (store, projectId) => {
    const fixer = store.snapshot(projectId).agents.find(agent => agent.role === 'swarm-fixer')!
    store.saveAgent({ ...fixer, model: 'sonnet' })
    expect(store.snapshot(projectId).agents.find(agent => agent.role === 'swarm-fixer')!.model).toBe('sonnet')
  }))
})

describe('starting a roster entry', () => {
  const rig = (store: OrchestrationStore) => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = []
    const deps = {
      agent: (id: string) => store.getAgent(id),
      ownerScope: (input: { projectId: string }) => ({ owner: true, ...input }),
      call: async (_scope: unknown, method: string, args: Record<string, unknown>) => {
        calls.push({ method, args })
        return method === 'tabs.open' ? { id: 'tab_1', resourceId: args.provider === 'cloud' ? undefined : 'agent_1', state: { provider: args.provider, model: args.model, effort: args.effort } } : { ok: true }
      }
    }
    return { calls, deps }
  }

  it('opens the role on its model, effort and stated permission and sends its brief with the goal', withProject(everyBrief, async (store, projectId) => {
    const fixer = store.snapshot(projectId).agents.find(agent => agent.role === 'swarm-fixer')!
    const { calls, deps } = rig(store)
    const result = await startRosterAgent(deps, { agentId: fixer.id, goal: 'Fix the energy price editor' })
    expect(calls[0]).toEqual({ method: 'tabs.open', args: { kind: 'agent', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto', exactPermission: true, title: 'Fixer', focus: true } })
    expect(calls[1]!.method).toBe('agents.submit')
    expect(calls[1]!.args.agentSessionId).toBe('agent_1')
    expect(calls[1]!.args.prompt).toBe(rosterStartPrompt(rosterRole('swarm-fixer')!.instructions, 'Fix the energy price editor'))
    expect(String(calls[1]!.args.prompt)).toContain('docs/swarm/worker-rules.md')
    expect(result).toMatchObject({ tabId: 'tab_1', agentSessionId: 'agent_1', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto' })
  }))

  it('without a goal tells the role to read its brief and ask', withProject(everyBrief, async (store, projectId) => {
    const verifier = store.snapshot(projectId).agents.find(agent => agent.role === 'verifier')!
    const { calls, deps } = rig(store)
    await startRosterAgent(deps, { agentId: verifier.id })
    expect(String(calls[1]!.args.prompt)).toMatch(/ask the owner in one short question/)
  }))

  it('opens a local role on its local model with its own mode, and an owner-edited model without the role\'s effort', withProject(everyBrief, async (store, projectId) => {
    const agents = store.snapshot(projectId).agents
    const { calls, deps } = rig(store)
    await startRosterAgent(deps, { agentId: agents.find(agent => agent.role === 'local-helper')!.id })
    expect(calls[0]!.args).toMatchObject({ provider: 'local', model: 'local/qwen3.5-9b', permission: 'accept-edits', exactPermission: true })
    expect(calls[0]!.args.effort).toBeUndefined()
    const verifier = agents.find(agent => agent.role === 'verifier')!
    store.saveAgent({ ...verifier, model: 'haiku' })
    calls.length = 0
    await startRosterAgent(deps, { agentId: verifier.id })
    expect(calls[0]!.args).toMatchObject({ provider: 'claude', model: 'haiku', permission: 'auto' })
    expect(calls[0]!.args.effort).toBeUndefined()
  }))

  it('starts the cloud coworker as a cloud session from its goal and refuses one without', withProject(everyBrief, async (store, projectId) => {
    const cloud = store.snapshot(projectId).agents.find(agent => agent.role === 'cloud-coworker')!
    const { calls, deps } = rig(store)
    await expect(startRosterAgent(deps, { agentId: cloud.id, goal: ' ' })).rejects.toThrow(/goal/)
    expect(calls).toHaveLength(0)
    await startRosterAgent(deps, { agentId: cloud.id, goal: 'Run the mac smoke' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toMatchObject({ provider: 'cloud', model: 'claude-opus-5-5', title: 'Cloud coworker' })
    expect(String(calls[0]!.args.prompt)).toContain('Goal: Run the mac smoke')
  }))

  it('refuses an archived or missing entry', withProject(everyBrief, async (store, projectId) => {
    const fixer = store.snapshot(projectId).agents.find(agent => agent.role === 'swarm-fixer')!
    store.saveAgent({ ...fixer, status: 'archived' })
    const { deps } = rig(store)
    await expect(startRosterAgent(deps, { agentId: fixer.id })).rejects.toThrow(/archived/)
    await expect(startRosterAgent(deps, { agentId: 'nope' })).rejects.toThrow(/no longer exists/)
  }))
})
