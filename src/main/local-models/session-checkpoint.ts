/** Stored only in Conductor's existing local database. The agent owns the payload schema. */
export interface SessionCheckpoint {
  load(): unknown
  save(value: unknown): Promise<void>
}

export function sessionCheckpoint(store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }, scope: { projectId: string; taskId: string }, assertLive: () => void): SessionCheckpoint {
  const key = `local-session-checkpoint:${JSON.stringify([scope.projectId, scope.taskId])}`
  return {
    load() {
      assertLive()
      const serialized = store.getSetting(key)
      if (serialized === null) return undefined
      // A corrupt checkpoint must not silently become a fresh task that repeats mutations.
      try { return JSON.parse(serialized) as unknown }
      catch { throw new Error('Local session checkpoint is unreadable; refusing to restart its work') }
    },
    async save(value) {
      assertLive()
      const serialized = JSON.stringify(value)
      if (serialized === undefined) throw new Error('Local session checkpoint must be JSON')
      store.setSetting(key, serialized)
    }
  }
}
