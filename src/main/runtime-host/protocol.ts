import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

/** Wire version of the runtime host pipe (docs/runtime-host.md). A host that answers `hello`
 *  with another version is left running for the app that started it, and not used. */
export const RUNTIME_HOST_PROTOCOL = 1

/** What the host keeps of one runtime's output after the last acknowledged frame. */
export const RUNTIME_BUFFER_BYTES = 16 * 1024 * 1024
export const RUNTIME_BUFFER_FRAMES = 50_000

export interface RuntimeMeta { agentSessionId?: string; provider?: string; title?: string }

export interface RuntimeSpawn { runtimeId: string; executable: string; args: string[]; cwd: string; env?: Record<string, string>; meta?: RuntimeMeta }

export interface RuntimeInfo {
  runtimeId: string
  pid: number | null
  alive: boolean
  exitCode: number | null
  signal: string | null
  /** A client is receiving this runtime's frames right now. */
  attached: boolean
  /** Its last client let go of it on purpose (`detach`), so it waits to be reattached. */
  detached: boolean
  lastSeq: number
  ackSeq: number
  buffered: number
  lostFrames: number
  startedAt: string
  detachedAt: string | null
  meta: RuntimeMeta
}

export type HostRequest =
  | { op: 'hello'; id: number; secret: string; protocol: number; client?: string }
  | ({ op: 'spawn'; id: number } & RuntimeSpawn)
  | { op: 'send'; runtimeId: string; line: string }
  | { op: 'attach'; id: number; runtimeId: string; afterSeq: number }
  | { op: 'detach'; id: number; runtimeId: string; seq: number; meta?: RuntimeMeta }
  | { op: 'ack'; runtimeId: string; seq: number }
  | { op: 'close'; id?: number; runtimeId: string }
  | { op: 'list'; id: number }
  | { op: 'stopAll'; id: number; onlyUnowned?: boolean }
  | { op: 'shutdown'; id: number }

export type FrameStream = 'stdout' | 'stderr' | 'error'

export type HostMessage =
  | { op: 'result'; id: number; ok: true; value?: unknown }
  | { op: 'result'; id: number; ok: false; error: string }
  | { op: 'frame'; runtimeId: string; seq: number; stream: FrameStream; data: string }
  | { op: 'exit'; runtimeId: string; seq: number; code: number | null; signal: string | null }

export interface HostLock { pid: number; pipe: string; secret: string; protocol: number; startedAt: string }

/** One pipe per Conductor profile: two profiles (a smoke's CONDUCTOR_TEST_USER_DATA and the
 *  owner's app) never share a host. */
export function runtimeHostPipe(userData: string): string {
  const key = createHash('sha256').update(userData.toLowerCase()).digest('hex').slice(0, 24)
  return process.platform === 'win32' ? `\\\\.\\pipe\\conductor-runtime-host-${key}` : `/tmp/conductor-runtime-host-${key}.sock`
}

/** Newline-framed JSON over a socket, in both directions. */
export class LineReader {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  constructor(private line: (text: string) => void, private maxBytes = 64 * 1024 * 1024) {}
  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '')
      this.pending = this.pending.slice(end + 1)
      if (line) this.line(line)
    }
    if (this.pending.length > this.maxBytes) throw new Error('Runtime host line exceeded its limit')
  }
  /** What is left without a newline: a child's last line when it exits. */
  end(): string { const rest = this.pending + this.decoder.end(); this.pending = ''; return rest.replace(/\r$/, '') }
}
