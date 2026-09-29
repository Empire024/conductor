import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { OrchestrationStore } from './orchestration-store'
import { startRosterAgent } from './agent-roster'
import { parseLogicLoop } from './logic-loops'
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
const loop = (id: string) => parseLogicLoop(readFileSync(join(resolve(__dirname, '..', '..'), '.conductor', 'loops', `${id}.md`), 'utf8'), `${id}.md`)
const primary = (model: string) => {
  const [provider, name] = model.split(':')
  return { provider, model: name }
}

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

  it('has an entry for every role a saved loop runs (VR8d R1b)', () => {
    // The loop step roles map to the roster entry that plays them; a new loop role needs one.
    const playedBy: Record<string, string> = { implementer: 'swarm-fixer', churn: 'local-helper', verifier: 'verifier', controller: 'swarm-orchestrator', architect: 'architect', reviewer: 'code-reviewer' }
    const loops = join(resolve(__dirname, '..', '..'), '.conductor', 'loops')
    const loopRoles = new Set(readdirSync(loops).filter(name => name.endsWith('.md')).flatMap(name => [...readFileSync(join(loops, name), 'utf8').matchAll(/^\s+role: (\w[\w-]*)/gm)].map(match => match[1]!)))
    expect([...loopRoles]).toEqual(expect.arrayContaining(['architect', 'reviewer']))
    for (const loopRole of loopRoles) expect(rosterRole(playedBy[loopRole] ?? loopRole), loopRole).toBeDefined()
    expect(rosterRole('architect')).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', briefs: ['.conductor/loops/batch-delivery.md'] })
    expect(rosterRole('code-reviewer')).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', briefs: ['.conductor/loops/batch-delivery.md'] })
    expect(rosterRole('code-reviewer')!.instructions).toMatch(/diff/)
  })

  it('never runs the Approval reviewer on Ask, where each tool call under a wizard costs a stronger-model review', () => {
    expect(rosterRole('approval-reviewer')!.permission).toBe('read-only')
    expect(ROSTER_ROLES.filter(role => role.permission === 'default')).toEqual([])
  })

  it('keeps loop-linked defaults, Auto mode and verifier scope aligned with the current loop steps', () => {
    const batch = loop('batch-delivery')
    const verify = loop('verify')
    const step = (steps: typeof batch.steps, id: string) => {
      const found = steps.find(item => item.id === id)
      expect(found, id).toBeDefined()
      expect(found!.model, id).toBeTruthy()
      return found!
    }
    for (const [role, expected] of [
      ['swarm-orchestrator', step(batch.steps, 'contract')],
      ['swarm-fixer', step(batch.steps, 'implement')],
      ['code-reviewer', step(batch.steps, 'review')],
      ['verifier', step(verify.steps, 'plan')],
      ['verifier', step(verify.steps, 'judge')],
      ['verifier-runner', step(batch.steps, 'churn')]
    ] as const) {
      expect(rosterRole(role), role).toMatchObject({ ...primary(expected.model!), effort: expected.effort, permission: 'auto' })
    }
    expect(step(verify.steps, 'execute')).toMatchObject({ model: 'codex:gpt-6.1-sol', effort: 'medium' })
    expect(rosterRole('verifier')!.instructions).toMatch(/distinct Sol tab/)
    expect(rosterRole('verifier-runner')!.instructions).toMatch(/committed smokes unchanged/)
    expect(rosterRole('verifier-runner')!.instructions).toMatch(/Never write harness code and never give verdicts/)
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
    store.saveAgent({ ...fixer, provider: 'claude', model: 'sonnet' })
    expect(store.snapshot(projectId).agents.find(agent => agent.role === 'swarm-fixer')).toMatchObject({ provider: 'claude', model: 'sonnet' })
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
    expect(calls[0]).toEqual({ method: 'tabs.open', args: { kind: 'agent', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', permission: 'auto', exactPermission: true, title: 'Fixer', focus: true } })
    expect(calls[1]!.method).toBe('agents.submit')
    expect(calls[1]!.args.agentSessionId).toBe('agent_1')
    expect(calls[1]!.args.prompt).toBe(rosterStartPrompt(rosterRole('swarm-fixer')!.instructions, 'Fix the energy price editor'))
    expect(String(calls[1]!.args.prompt)).toContain('docs/swarm/worker-rules.md')
    expect(result).toMatchObject({ tabId: 'tab_1', agentSessionId: 'agent_1', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', permission: 'auto' })
  }))

  it('starts the committed-command Verifier runner on Sol 6.1 low in Auto mode', withProject(everyBrief, async (store, projectId) => {
    const runner = store.snapshot(projectId).agents.find(agent => agent.role === 'verifier-runner')!
    const { calls, deps } = rig(store)
    const result = await startRosterAgent(deps, { agentId: runner.id, goal: 'Rerun the named committed smoke' })
    expect(calls[0]).toEqual({ method: 'tabs.open', args: { kind: 'agent', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', permission: 'auto', exactPermission: true, title: 'Verifier runner', focus: true } })
    expect(String(calls[1]!.args.prompt)).toContain('Never write harness code and never give verdicts')
    expect(result).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', permission: 'auto' })
  }))

  it('starts the Approval reviewer read only, which tabs.open runs as plan mode on Claude', withProject(everyBrief, async (store, projectId) => {
    const reviewer = store.snapshot(projectId).agents.find(agent => agent.role === 'approval-reviewer')!
    const { calls, deps } = rig(store)
    const result = await startRosterAgent(deps, { agentId: reviewer.id, goal: 'Re-review the held git push' })
    expect(calls[0]!.args).toMatchObject({ provider: 'claude', model: 'opus[1m]', permission: 'read-only', exactPermission: true })
    expect(result.permission).toBe('read-only')
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
    store.saveAgent({ ...verifier, provider: 'claude', model: 'haiku' })
    calls.length = 0
    await startRosterAgent(deps, { agentId: verifier.id })
    expect(calls[0]!.args).toMatchObject({ provider: 'claude', model: 'haiku' })
    expect(calls[0]!.args.effort).toBeUndefined()
    expect(calls[0]!.args.permission).toBeUndefined()
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
