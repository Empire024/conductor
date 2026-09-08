import { watch, type FSWatcher } from 'node:fs'
import type { AgentFileChange } from '../shared/agent-control'
import type { ProjectRecord } from '../shared/models'
import { invalidateProjectFiles } from './project-file-search'

/** Watch directories, not file handles: atomic editor replacements remain observable. */
export class ProjectFileChanges {
  private watchers = new Map<string, { path: string; watcher: FSWatcher }>()
  private pending = new Map<string, { change: AgentFileChange; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly publish: (change: AgentFileChange) => void) {}
  watch(project: ProjectRecord): void {
    if (this.watchers.get(project.id)?.path === project.path) return
    this.forget(project.id)
    try {
      const watcher = watch(project.path, { recursive: true, persistent: false }, (_event, name) => {
        if (!name) return
        const path = name.toString().replaceAll('\\', '/')
        if (path.split('/').some(part => ['.git', 'node_modules', 'out', 'dist', '.cache', 'release'].includes(part)) || path.includes('.conductor-save-')) return
        invalidateProjectFiles(project.path)
        this.changed({ projectId: project.id, path })
      })
      watcher.on('error', () => this.forget(project.id))
      this.watchers.set(project.id, { path: project.path, watcher })
    } catch { /* Missing/offline projects are retried when opened or edited. */ }
  }
  changed(change: AgentFileChange): void {
    const key = change.projectId + ':' + change.path.toLocaleLowerCase()
    clearTimeout(this.pending.get(key)?.timer)
    this.pending.set(key, { change, timer: setTimeout(() => { this.pending.delete(key); this.publish(change) }, 60) })
  }
  forget(projectId: string): void {
    this.watchers.get(projectId)?.watcher.close(); this.watchers.delete(projectId)
    for (const [key, pending] of this.pending) if (pending.change.projectId === projectId) { clearTimeout(pending.timer); this.pending.delete(key) }
  }
  close(): void { for (const id of this.watchers.keys()) this.forget(id) }
}
