export type ControlMethodClass = 'read' | 'mutation'

/**
 * Mutations are serialized per (session, family): calls of one family from one caller run in
 * arrival order, while a long call in one family (a git.ship verifying for half a minute) never
 * holds up another (tabs.open). Every mutation belongs to exactly one family.
 */
export const MUTATION_FAMILIES = {
  delivery: ['git.ship'],
  tabs: ['tabs.open', 'tabs.focus', 'tabs.rename', 'tabs.split', 'tabs.detach', 'tabs.close', 'router.start', 'router.dispatch', 'workspace.rename'],
  agents: ['agents.compact', 'agents.configure', 'agents.grant', 'agents.submit', 'agents.steer', 'agents.interrupt', 'agents.resume', 'agents.fork', 'agents.release', 'agents.handoff', 'agents.supersede', 'agents.report', 'agents.finish'],
  app: ['projects.open', 'app.update', 'app.update.authorize', 'app.update.check', 'app.update.download', 'app.update.install', 'app.restart', 'app.restart.request', 'app.quit.confirm', 'local.stop'],
  files: ['files.write', 'files.open', 'tasks.update', 'memory.remember', 'memory.forget'],
  schedules: [
    'jobs.create', 'jobs.pause', 'jobs.resume', 'jobs.cancel', 'jobs.report',
    'schedules.create', 'schedules.update', 'schedules.pause', 'schedules.resume', 'schedules.runNow', 'schedules.delete', 'schedules.scripts.save', 'schedules.scripts.delete',
    'loops.run', 'loops.record', 'loops.propose', 'loops.apply', 'loops.reject'
  ],
  other: [
    'orchestration.tasks.create', 'orchestration.tasks.update', 'orchestration.routines.save',
    'ideas.capture', 'ideas.link', 'ideas.note', 'ideas.explore', 'ideas.work'
  ]
} as const satisfies Record<string, readonly string[]>
export type MutationFamily = keyof typeof MUTATION_FAMILIES
const FAMILY_OF = new Map<string, MutationFamily>(Object.entries(MUTATION_FAMILIES).flatMap(([family, methods]) => methods.map(method => [method, family as MutationFamily] as const)))

/**
 * One exhaustive, auditable classification for the methods tools.list may advertise. A method
 * added to discovery without an entry here makes the protocol boundary test fail instead of
 * silently escaping the intended concurrency policy.
 */
export const CONTROL_METHOD_CLASSES = new Set<`${ControlMethodClass}:${string}`>([
  ...[
    'tools.list', 'app.state', 'projects.list', 'machines.list', 'models.list', 'tabs.list',
    'agents.list', 'agents.snapshot', 'agents.history', 'agents.artifact', 'agents.status',
    'files.list', 'files.read', 'tasks.list', 'memory.recall', 'orchestration.snapshot',
    'app.update.status', 'git.status', 'git.ship.status', 'local.servers', 'usage.limits',
    'jobs.list', 'jobs.status', 'jobs.events', 'schedules.list', 'schedules.get',
    'loops.list', 'loops.get', 'loops.history', 'loops.proposals', 'ideas.list', 'ideas.get'
  ].map(method => `read:${method}` as const),
  ...[...FAMILY_OF.keys()].map(method => `mutation:${method}` as const)
])

/** The lock family of a mutation; undefined for a read or an unknown method. */
export function controlMethodFamily(method: string): MutationFamily | undefined {
  return FAMILY_OF.get(method)
}

export function controlMethodClass(method: string): ControlMethodClass | undefined {
  if (CONTROL_METHOD_CLASSES.has(`read:${method}`)) return 'read'
  if (CONTROL_METHOD_CLASSES.has(`mutation:${method}`)) return 'mutation'
  return undefined
}
