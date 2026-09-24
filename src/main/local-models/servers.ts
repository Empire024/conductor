import { localModelLabel } from '../../shared/local-models'
import type { LocalModelConfig } from './config'
import type { RunRecord } from './llama'
import type { BlockingServer, ServerProcess } from './resource-guard'

/** One llama.cpp server running on this machine, as app control's local.servers reports it. */
export interface LocalServerEntry {
  model: string
  label: string
  pid: number | null
  port: number | null
  startedAt: string | null
  /** Only a server this Conductor started (a run record with a live pid) can be stopped here. */
  startedByConductor: boolean
}

export interface LocalServerSources {
  models(): LocalModelConfig[]
  record(model: LocalModelConfig): RunRecord | null
  alive(pid: number | null): boolean
  /** The machine-wide llama-server process list; may throw where it cannot be read. */
  inventory(): ServerProcess[]
}

/** Local model ids are 'local/<id>' everywhere (stack config, run records, conversations); a
 *  caller may leave the prefix off. */
export const localModelId = (id: string): string => id.startsWith('local/') ? id : 'local/' + id

/** The running servers: every Conductor-started one with a live pid, then any other llama-server
 *  the process list shows, which is reported so an agent knows what holds the GPU but is never
 *  stopped from here. */
export function listLocalServers(sources: LocalServerSources): LocalServerEntry[] {
  const entries: LocalServerEntry[] = []
  for (const model of sources.models()) {
    const record = sources.record(model)
    if (!record || record.pid === null || !sources.alive(record.pid)) continue
    entries.push({ model: model.id, label: localModelLabel(model.id), pid: record.pid, port: record.port, startedAt: record.startedAt, startedByConductor: true })
  }
  let inventory: ServerProcess[] = []
  try { inventory = sources.inventory() } catch { /* Reported servers stay the Conductor-started ones. */ }
  for (const process of inventory) {
    if (entries.some(entry => entry.pid === process.pid)) continue
    entries.push({ model: process.model, label: localModelLabel(process.model), pid: process.pid, port: process.port ?? null, startedAt: null, startedByConductor: false })
  }
  return entries
}

/** A stop refused because a turn is using the server; the caller may ask the owner and force it. */
export class LocalServerBusy extends Error {
  constructor(readonly label: string, readonly reason: string) { super(`${label} is busy: ${reason}. Wait for that turn to finish, or pass force:true to stop it anyway (the turn fails).`) }
}

export interface LocalStopRequest { model?: string; pid?: number; force?: boolean }
export interface LocalStopPorts {
  /** 'idle', or why the server is busy (a turn mid-flight here, or its slots generating). */
  busy(server: BlockingServer): Promise<'idle' | string>
  stop(model: string): Promise<string>
}

/** Stop one Conductor-started server. Refuses a server this Conductor did not start, and one a
 *  turn is using unless forced; the next local turn simply starts it again. */
export async function stopLocalServer(servers: LocalServerEntry[], request: LocalStopRequest, ports: LocalStopPorts): Promise<{ stopped: true; model: string; pid: number | null; port: number | null; forced: boolean; interrupted?: string; message: string }> {
  const wanted = request.model === undefined ? undefined : localModelId(request.model)
  const matches = servers.filter(server => (wanted === undefined || server.model === wanted) && (request.pid === undefined || server.pid === request.pid))
  if (!matches.length) {
    const running = servers.length ? servers.map(server => `${server.model} (pid ${server.pid ?? 'unknown'})`).join(', ') : 'none'
    throw new Error(`No running local model server matches ${wanted ?? ''}${request.pid !== undefined ? ` pid ${request.pid}` : ''}. Running: ${running}.`)
  }
  if (matches.length > 1) throw new Error(`Several servers match (${matches.map(server => `${server.model} pid ${server.pid}`).join(', ')}); name the model or the pid.`)
  const server = matches[0]!
  if (!server.startedByConductor) throw new Error(`${server.label} (pid ${server.pid ?? 'unknown'}) was not started by this Conductor, so it is left alone. Stop it where it was started.`)
  const verdict = await ports.busy({ model: server.model, port: server.port ?? undefined, pid: server.pid, ours: true })
  if (verdict !== 'idle' && !request.force) throw new LocalServerBusy(server.label, verdict)
  const message = await ports.stop(server.model)
  return { stopped: true, model: server.model, pid: server.pid, port: server.port, forced: verdict !== 'idle', ...(verdict !== 'idle' ? { interrupted: verdict } : {}), message }
}
