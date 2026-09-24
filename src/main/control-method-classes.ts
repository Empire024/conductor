export type ControlMethodClass = 'read' | 'mutation'

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
    'jobs.list', 'jobs.status', 'jobs.events', 'schedules.list', 'schedules.get'
  ].map(method => `read:${method}` as const),
  ...[
    'tabs.open', 'tabs.focus', 'tabs.rename', 'tabs.split', 'tabs.detach', 'tabs.close',
    'agents.compact', 'agents.configure', 'agents.grant', 'agents.submit', 'agents.steer',
    'agents.interrupt', 'agents.resume', 'agents.fork', 'agents.release', 'agents.handoff',
    'files.write', 'files.open', 'tasks.update', 'memory.remember', 'memory.forget',
    'orchestration.tasks.create', 'orchestration.tasks.update', 'orchestration.routines.save',
    'workspace.rename', 'app.update', 'app.update.authorize', 'git.ship', 'local.stop',
    'router.start', 'router.dispatch', 'jobs.create', 'jobs.pause', 'jobs.resume', 'jobs.cancel',
    'jobs.report', 'schedules.create', 'schedules.update', 'schedules.pause', 'schedules.resume',
    'schedules.runNow', 'schedules.delete', 'schedules.scripts.save', 'schedules.scripts.delete',
    'projects.open', 'app.update.check', 'app.update.download', 'app.update.install',
    'app.restart', 'app.restart.request', 'app.quit.confirm'
  ].map(method => `mutation:${method}` as const)
])

export function controlMethodClass(method: string): ControlMethodClass | undefined {
  if (CONTROL_METHOD_CLASSES.has(`read:${method}`)) return 'read'
  if (CONTROL_METHOD_CLASSES.has(`mutation:${method}`)) return 'mutation'
  return undefined
}
