import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RemoteJobService } from './service.ts'
import type { LogStream } from './store.ts'
import type { NodeSummary, RemoteJob, RemoteJobStatus } from './types.ts'

/**
 * The nodes.* app-control methods. agent-control.ts decides who is calling; everything about
 * nodes and jobs is decided here, so the control surface stays one line there.
 */
export const nodeSignatures = {
  'nodes.list': '() — execution nodes: other computers of the owner that run bounded commands over SSH inside the tailnet (docs/mac-node.md), each with platform, arch, hardware, capabilities (macos, arm64, apple-silicon, node@24, xcode-clt…), status, last seen and current jobs',
  'nodes.probe': '({nodeId?}) — ask one node (or every node) what it is now; marks it online or offline and refreshes its facts and capabilities',
  'nodes.run': '({command,nodeId?|requires?:string[],cwd?,timeoutSec?,checkout?:boolean|{commit?},title?}) — run one bash command on a node: nodeId names it, or requires picks an online node with all those capabilities (["macos"] never runs anywhere else). Bounded: timeoutSec (default 1800) is enforced on the node, the whole process group is stopped on timeout, cancel or a lost connection, stdout/stderr are kept here. checkout brings the node\'s own checkout of this project to a commit first (HEAD by default; the commit is pushed to the node, nothing needs publishing) and cwd is then inside it. Returns the job; follow with nodes.job({jobId,waitSeconds})',
  'nodes.jobs': '({nodeId?,status?:string[],limit?}) — remote jobs of this project, newest first, without their output',
  'nodes.job': '({jobId,waitSeconds?}) — one job with the last 16 KB of stdout and stderr; waitSeconds (up to 100) waits for it to end',
  'nodes.log': '({jobId,stream?:"stdout"|"stderr",bytes?}) — the end of a job\'s full log (default 64 KB, up to 1 MB) and the log file path',
  'nodes.cancel': '({jobId,reason?}) — stop a job: the node stops its whole process group; the owner, a wizard tab or the conversation that started it',
  'nodes.register': '({id,host,user,identityFile?,port?,name?,labels?:string[],root?,maxConcurrentJobs?,peerMachineId?}) — owner only: add or update a node; host is its Tailscale name, identityFile the private key here whose public half the node authorizes (default ~/.ssh/conductor_mac_ed25519)',
  'nodes.remove': '({nodeId}) — owner only: forget a node that has no jobs running'
} as const

export const nodeMethods = new Set(Object.keys(nodeSignatures))
export const NODE_READ_METHODS = ['nodes.list', 'nodes.jobs', 'nodes.job', 'nodes.log'] as const
export const NODE_MUTATION_METHODS = ['nodes.probe', 'nodes.run', 'nodes.cancel', 'nodes.register', 'nodes.remove'] as const

const allowedKeys: Record<string, string[]> = {
  'nodes.list': [],
  'nodes.probe': ['nodeId'],
  'nodes.run': ['command', 'nodeId', 'requires', 'cwd', 'timeoutSec', 'checkout', 'title'],
  'nodes.jobs': ['nodeId', 'status', 'limit'],
  'nodes.job': ['jobId', 'waitSeconds'],
  'nodes.log': ['jobId', 'stream', 'bytes'],
  'nodes.cancel': ['jobId', 'reason'],
  'nodes.register': ['id', 'host', 'user', 'identityFile', 'port', 'name', 'labels', 'root', 'maxConcurrentJobs', 'peerMachineId'],
  'nodes.remove': ['nodeId']
}

export interface NodeCaller {
  projectId: string
  /** This project's folder on this machine; null for a project that lives on another machine. */
  projectPath: string | null
  agentSessionId: string
  /** The owner credential or a wizard tab. */
  owner: boolean
  /** Why this caller may not start or stop jobs, or null when it may. */
  refusal: string | null
  /** Default key for nodes.register. */
  defaultIdentityFile?: string
}

type Args = Record<string, unknown>

const str = (args: Args, key: string, max: number, required = true): string | undefined => {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${key} must be a non-empty string of up to ${max} characters`)
  return value
}
const int = (args: Args, key: string, min: number, max: number): number | undefined => {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`)
  return value
}
const list = (args: Args, key: string): string[] | undefined => {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 60)) throw new Error(`${key} must be a list of up to 20 short strings`)
  return value as string[]
}

const withoutOutput = ({ stdoutTail, stderrTail, ...job }: RemoteJob): Omit<RemoteJob, 'stdoutTail' | 'stderrTail'> => job

export async function callNodeMethod(service: RemoteJobService, caller: NodeCaller, method: string, args: Args): Promise<unknown> {
  const allowed = allowedKeys[method]
  if (!allowed) throw new Error('Unknown nodes method; use tools.list')
  const extra = Object.keys(args).filter(key => !allowed.includes(key))
  if (extra.length) throw new Error(`${method} accepts only ${allowed.join(', ') || 'no arguments'}; ${extra.join(', ')} is not an argument`)
  // A job id from another project reads as missing, so ids disclose nothing.
  const ownJob = (): RemoteJob => {
    const jobId = str(args, 'jobId', 80)!
    let job: RemoteJob
    try { job = service.getJob(jobId) } catch { throw new Error('No remote job with that id in this project; use nodes.jobs') }
    if (!caller.owner && job.projectId !== caller.projectId) throw new Error('No remote job with that id in this project; use nodes.jobs')
    return job
  }
  const mayAct = (): void => { if (caller.refusal) throw new Error(caller.refusal) }
  const ownerOnly = (): void => { if (!caller.owner) throw new Error(`${method} is for the owner or a wizard tab`) }

  if (method === 'nodes.list') return service.listNodes()
  if (method === 'nodes.jobs') {
    const status = list(args, 'status') as RemoteJobStatus[] | undefined
    const nodeId = str(args, 'nodeId', 40, false)
    return service.listJobs({ projectId: caller.owner ? undefined : caller.projectId, nodeId, status, limit: int(args, 'limit', 1, 200) ?? 50 }).map(withoutOutput)
  }
  if (method === 'nodes.job') {
    const job = ownJob()
    const wait = int(args, 'waitSeconds', 0, 100) ?? 0
    return wait ? service.wait(job.id, wait * 1000) : job
  }
  if (method === 'nodes.log') {
    const job = ownJob()
    const stream = args.stream === undefined ? 'stdout' : args.stream
    if (stream !== 'stdout' && stream !== 'stderr') throw new Error('stream is "stdout" or "stderr"')
    return service.readLog(job.id, stream as LogStream, int(args, 'bytes', 1, 1024 * 1024) ?? 64 * 1024)
  }
  if (method === 'nodes.probe') {
    mayAct()
    const nodeId = str(args, 'nodeId', 40, false)
    const ids = nodeId ? [nodeId] : service.listNodes().map(node => node.id)
    const probed: NodeSummary[] = []
    for (const id of ids) probed.push(await service.probeNode(id))
    return probed
  }
  if (method === 'nodes.run') {
    mayAct()
    let checkout: { localRepoPath: string; commit?: string } | undefined
    if (args.checkout !== undefined && args.checkout !== false) {
      if (!caller.projectPath) throw new Error('checkout needs a project whose folder is on this machine')
      const spec = args.checkout === true ? {} : args.checkout
      if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(key => key !== 'commit')) throw new Error('checkout is true or {commit}')
      const commit = (spec as Args).commit
      if (commit !== undefined && (typeof commit !== 'string' || !/^[\w./@^~-]{1,200}$/.test(commit))) throw new Error('checkout.commit must be a commit id, branch or ref')
      checkout = { localRepoPath: caller.projectPath, ...(commit ? { commit } : {}) }
    }
    return service.submit({
      command: str(args, 'command', 20_000)!,
      nodeId: str(args, 'nodeId', 40, false), requires: list(args, 'requires'),
      cwd: str(args, 'cwd', 500, false), timeoutSec: int(args, 'timeoutSec', 1, 24 * 60 * 60),
      title: str(args, 'title', 120, false), checkout,
      projectId: caller.projectId, createdBy: caller.agentSessionId
    })
  }
  if (method === 'nodes.cancel') {
    mayAct()
    const job = ownJob()
    if (!caller.owner && job.createdBy !== caller.agentSessionId) throw new Error('Only the owner, a wizard tab or the conversation that started this job may cancel it')
    return service.cancel(job.id, str(args, 'reason', 500, false))
  }
  if (method === 'nodes.register') {
    ownerOnly()
    const peer = args.peerMachineId
    if (peer !== undefined && peer !== null && typeof peer !== 'string') throw new Error('peerMachineId is a machines.list id or null')
    return service.registerNode({
      id: str(args, 'id', 40)!, name: str(args, 'name', 80, false),
      ssh: { host: str(args, 'host', 253)!, user: str(args, 'user', 64)!, identityFile: str(args, 'identityFile', 1000, false) ?? caller.defaultIdentityFile ?? join(homedir(), '.ssh', 'conductor_mac_ed25519'), ...(args.port !== undefined ? { port: int(args, 'port', 1, 65535)! } : {}) },
      labels: list(args, 'labels'), root: str(args, 'root', 200, false), maxConcurrentJobs: int(args, 'maxConcurrentJobs', 1, 16),
      ...(peer !== undefined ? { peerMachineId: peer as string | null } : {})
    })
  }
  ownerOnly()
  service.removeNode(str(args, 'nodeId', 40)!)
  return { removed: true }
}

/**
 * machines.list with the execution nodes in it: a node that is also a paired Conductor peer is
 * that machine's `node` facet; any other node is listed as its own machine that runs commands,
 * not tabs. One pool, described once.
 */
export function withNodes<T extends { id: string }>(machines: T[], nodes: NodeSummary[]): Array<T | Record<string, unknown>> {
  const facet = (node: NodeSummary): Record<string, unknown> => ({
    nodeId: node.id, status: node.status, platform: node.facts?.platform ?? null, arch: node.facts?.arch ?? null,
    osVersion: node.facts?.osVersion ?? null, model: node.facts?.model ?? null, capabilities: node.capabilities,
    lastSeenAt: node.lastSeenAt, currentJobs: node.currentJobs, workspaceRoot: `~/${node.root}`
  })
  const linked = new Map(nodes.filter(node => node.peerMachineId).map(node => [node.peerMachineId!, node]))
  return [
    ...machines.map(machine => linked.has(machine.id) ? { ...machine, node: facet(linked.get(machine.id)!) } : machine),
    ...nodes.filter(node => !node.peerMachineId || !machines.some(machine => machine.id === node.peerMachineId)).map(node => ({
      id: `node:${node.id}`, name: node.name, kind: 'node', status: node.status, current: false, runsThisProject: false,
      projectNote: 'Runs bounded commands, not tabs: nodes.run({nodeId, command}) or nodes.run({requires, command}).',
      node: facet(node)
    }))
  ]
}
