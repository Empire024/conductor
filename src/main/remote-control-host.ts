import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import { conductorUri } from '../shared/agent-control'
import { makeId, type AgentSpec, type LayoutNode, type PaneTab } from '../shared/models'
import type { InteractionResponse, PromptDispatchAuthority, PromptOrigin, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import { LOCAL_MACHINE_ID, type RemotePeerRecord } from '../shared/remote-control'
import { PROJECT_TASK_MAX_LENGTH, projectTaskKinds, projectTaskPriorities, projectTaskWeights, type ProjectTaskKind, type ProjectTaskPriority, type ProjectTaskWeight } from '../shared/project-backlog'
import { workspacePath } from './agent-artifacts'
import type { ConductorDatabase } from './database'
import { writeEditorFile } from './editor-files'
import type { ProjectBacklogs } from './project-backlog'
import { invalidateProjectFiles, searchProjectFiles } from './project-file-search'
import { RemoteAccessError, type RemotePeers } from './remote-peers'
import type { RemoteServiceRegistry } from './remote-services'
import { RemoteTerminalHost, type RemoteTerminalStream, type TerminalRuntime } from './remote-terminals'
import type { StructuredSessions } from './structured-sessions'
import { readTextFile } from './text-files'
import { REMOTE_FILE_CHUNK_BYTES, REMOTE_FILE_MAX_ASSET_BYTES } from '../shared/remote-files'
import type { ContextAttachment } from '../shared/structured-agent'

type Args = Record<string, unknown>

const text = (args: Args, key: string, maximum = 20000): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new RemoteAccessError(`Invalid ${key}`, 400)
  return value
}

const remoteMediaTypes: Record<string, { kind: 'image' | 'video'; mimeType: string }> = {
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.avif': { kind: 'image', mimeType: 'image/avif' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.webm': { kind: 'video', mimeType: 'video/webm' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime' }
}

const fileVersion = (relativePath: string, value: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }): string =>
  createHash('sha256').update([relativePath, value.size, value.mtimeMs, value.ctimeMs, value.dev, value.ino].join('\0')).digest('hex')

const strictUtf8 = (bytes: Buffer): string => {
  const content = bytes.toString('utf8')
  if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) throw new RemoteAccessError('Remote file attachment must be UTF-8 text.', 400)
  return content
}

/**
 * Deliberately narrower than the local agent surface. A paired machine can work inside the
 * projects it was granted and drive agent tabs there; it has no shell, no arbitrary path access,
 * and no way to reach a project the owner did not share.
 */
export const remoteToolSignatures = {
  'machine.describe': '() — this machine, the projects it shares with you and the tabs it is running',
  'projects.list': '() — only the projects this machine shared with you',
  'projects.create': '({name}) — creates a project folder on this machine, in its own projects folder, and shares it with you',
  'workspaces.list': '({projectId})',
  'tabs.list': '({projectId,sessionId})',
  'tabs.open': '({projectId,sessionId,kind?,provider?,model?,effort?,title?,permission?}) — opens a visible tab on this machine',
  'tabs.focus': '({projectId,sessionId,tabId})',
  'tabs.close': '({projectId,sessionId,tabId})',
  'agents.list': '({projectId,sessionId})',
  'agents.snapshot': '({projectId,sessionId,agentSessionId})',
  'agents.history': '({projectId,sessionId,agentSessionId,afterSequence?}) — incremental events, for mirroring the tab remotely',
  'agents.submit': '({projectId,sessionId,agentSessionId,prompt,settings?})',
  'agents.steer': '({projectId,sessionId,agentSessionId,prompt,settings?})',
  'agents.queue': '({projectId,sessionId,agentSessionId,prompt,settings})',
  'agents.cancelQueued': '({projectId,sessionId,agentSessionId,promptId?})',
  'agents.interrupt': '({projectId,sessionId,agentSessionId,expediteSubmittedInput?})',
  'agents.resume': '({projectId,sessionId,agentSessionId,settings?})',
  'agents.discover': '({projectId,sessionId,agentSessionId})',
  'agents.settings': '({projectId,sessionId,agentSessionId,settings})',
  'agents.respond': '({projectId,sessionId,agentSessionId,response})',
  'agents.rename': '({projectId,sessionId,agentSessionId,title})',
  'agents.archive': '({projectId,sessionId,agentSessionId,archived})',
  'files.list': '({projectId,path?}) — one directory inside the shared project; legacy query searches it',
  'files.stat': '({projectId,path})',
  'files.read': '({projectId,path})',
  'files.write': '({projectId,path,content,expectedContent})',
  'files.describe': '({projectId,path}) — safe image/video metadata and immutable version token',
  'files.readChunk': '({projectId,path,offset,length,version}) — at most 256 KiB from that exact version',
  'files.open': '({projectId,sessionId,path})',
  'tasks.list': '({projectId})',
  'tasks.create': '({projectId,revision,title,kind,priority?,weight?})',
  'tasks.update': '({projectId,revision,id,status?,title?,priority?})',
  // A shell on this machine runs as this machine's user. docs/multi-device.md says what that
  // means; these methods are the only door to it, and every one of them goes through the grant.
  'terminals.list': '({projectId,sessionId}) — shells this machine is running in that workspace',
  'terminals.open': '({projectId,sessionId,opId,title?,cols,rows}) — opens a shell here and a visible tab for it; a retry with the same opId finds the first one',
  'terminals.attach': '({projectId,sessionId,terminalId,fromOffset}) — buffered output from an offset, with what the buffer no longer holds reported as lost',
  'terminals.write': '({projectId,sessionId,terminalId,data}) — data base64',
  'terminals.resize': '({projectId,sessionId,terminalId,cols,rows})',
  'terminals.close': '({projectId,sessionId,terminalId}) — stops the shell; unsubscribing from the stream does not',
  'services.list': '({projectId}) — preview services this machine\'s owner registered for that project'
} as const

export interface RemoteControlHostDependencies {
  database: ConductorDatabase
  sessions: StructuredSessions
  backlogs: ProjectBacklogs
  peers: RemotePeers
  providers(): Array<{ id: string; available: boolean; models: Array<{ id: string; label: string; isDefault?: boolean }> }>
  ui(request: AgentControlUiRequest): Promise<unknown>
  fileChanged(change: AgentFileChange): void
  machineName(): string
  /** This machine's PTYs. Without it `terminals.*` is refused rather than silently unavailable. */
  terminals?: TerminalRuntime
  /** The push channel terminal output is fanned out over, when one is running. */
  terminalStream?: RemoteTerminalStream
  /** The owner's registered preview services, for `services.list`. */
  services?: RemoteServiceRegistry
  /**
   * Creates a project on this machine, the same way the owner's own "New project" does — same
   * folder, same backlog, same watchers. Without it `projects.create` is refused rather than
   * half-served, because a project row with no folder behind it is worse than no project.
   */
  createProject?(name: string): Promise<{ id: string }>
}

/** Serves one authenticated peer's calls against this machine's own projects. */
export class RemoteControlHost {
  /**
   * The terminal half, constructed here rather than passed in because it needs this host's own
   * grant check and its own tab-opening path, and handing those out would put the trust boundary
   * in whoever wired it up.
   */
  readonly terminals: RemoteTerminalHost | null

  constructor(private readonly deps: RemoteControlHostDependencies) {
    const runtime = deps.terminals
    this.terminals = !runtime ? null : new RemoteTerminalHost({
      terminals: runtime,
      workspace: (peer, args) => this.workspace(peer, args),
      // A stream subscription carries only the peer id, so the grant is re-resolved from it
      // against the project the named shell actually belongs to.
      authorize: (peerId, projectId) => { this.deps.peers.requirePromptAuthority(peerId, projectId) },
      openTab: async (peer, request) => {
        const opened = await this.open(peer, request.projectId, request.sessionId,
          { kind: 'terminal', title: request.title, terminalId: request.terminalId }, 'terminals.open')
        return { id: (opened as PaneTab).id }
      },
      closeTab: async (peer, request) => {
        if (!this.tabs(request.projectId, request.sessionId).some(tab => tab.id === request.tabId)) return
        await this.ui(request.projectId, request.sessionId, 'tabs.close', { tabId: request.tabId })
      },
      tabId: (projectId, sessionId, terminalId) => {
        try {
          return this.tabs(projectId, sessionId).find(tab => tab.kind === 'terminal' && tab.resourceId === terminalId)?.id ?? null
        } catch {
          // A workspace that has since moved or gone simply has no tab to name; the shell itself
          // is still perfectly listable.
          return null
        }
      },
      projectPath: projectId => this.deps.database.getProject(projectId)?.path ?? null,
      stream: deps.terminalStream
    })
  }

  /** The stream host is built after this one, so it attaches itself here once it exists. */
  useTerminalStream(stream: RemoteTerminalStream): void {
    this.terminals?.useStream(stream)
  }

  private workspace(peer: RemotePeerRecord, args: Args): { projectId: string; sessionId: string } {
    const project = this.deps.peers.requireProject(peer, args.projectId)
    const sessionId = text(args, 'sessionId', 160)
    const workspace = this.deps.database.getSession(sessionId)
    if (workspace?.projectId !== project.id) throw new RemoteAccessError('That workspace is not in the shared project.', 403)
    return { projectId: project.id, sessionId }
  }

  private tabs(projectId: string, sessionId: string): Array<PaneTab & { groupId: string; detachedId?: string; uri: string }> {
    const workspace = this.deps.database.getSession(sessionId)
    if (workspace?.projectId !== projectId) throw new RemoteAccessError('That workspace is not in the shared project.', 403)
    const tabs: Array<PaneTab & { groupId: string; detachedId?: string; uri: string }> = []
    const visit = (node: LayoutNode, detachedId?: string): void => {
      if (node.type === 'split') { node.children.forEach(child => visit(child, detachedId)); return }
      node.tabs.forEach(tab => tabs.push({ ...tab, groupId: node.id, ...(detachedId ? { detachedId } : {}), uri: conductorUri(projectId, 'tab', tab.id) }))
    }
    visit(workspace.layout.root)
    for (const window of this.deps.database.listDetachedWindows()) {
      if (window.projectId === projectId && window.sessionId === sessionId) visit(window.layout.root, window.id)
    }
    return tabs
  }

  private ui(projectId: string, sessionId: string, action: AgentControlUiRequest['action'], params: Args): Promise<unknown> {
    return this.deps.ui({ projectId, sessionId, agentSessionId: '', id: randomUUID(), action, params })
  }

  private async promptAttachments(peer: RemotePeerRecord, projectId: string, raw: unknown): Promise<{
    attachments: ContextAttachment[]
    current(): void
  }> {
    const authority = this.deps.peers.captureProjectAuthority(peer, projectId)
    const current = (): void => { this.deps.peers.requireCurrentProject(peer, projectId, authority.revision) }
    if (raw === undefined) return { attachments: [], current }
    if (!Array.isArray(raw) || raw.length > 20) throw new RemoteAccessError('A remote prompt can attach at most 20 host files.', 400)
    const attachments: ContextAttachment[] = []
    let total = 0
    for (const rawItem of raw) {
      const item = rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem) ? rawItem as Record<string, unknown> : {}
      const remoteFile = item.remoteFile && typeof item.remoteFile === 'object' && !Array.isArray(item.remoteFile)
        ? item.remoteFile as Record<string, unknown> : {}
      if (item.kind !== 'file' || typeof item.id !== 'string' || !item.id || item.id.length > 160
        || typeof item.name !== 'string' || !item.name || item.name.length > 512
        || Object.hasOwn(item, 'content') || Object.hasOwn(item, 'path')
        || remoteFile.machineId !== this.deps.peers.machineId || remoteFile.projectId !== projectId || typeof remoteFile.path !== 'string') {
        throw new RemoteAccessError('Remote attachments must name a host-project text file without supplied content.', 400)
      }
      const path = await workspacePath(authority.project.path, remoteFile.path, false)
      current()
      const relativePath = relative(await realpath(authority.project.path), path).replaceAll('\\', '/')
      current()
      const handle = await open(path, 'r')
      current()
      try {
        const before = await handle.stat()
        current()
        if (!before.isFile() || before.size > 128_000) throw new RemoteAccessError('Remote file attachment exceeds 128 KB.', 400)
        const bytes = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset)
          current()
          if (!read.bytesRead) break
          offset += read.bytesRead
        }
        const after = await handle.stat()
        current()
        if (offset > before.size || fileVersion(relativePath, after) !== fileVersion(relativePath, before)) {
          throw new RemoteAccessError('Remote file attachment changed while it was being read.', 409)
        }
        const content = strictUtf8(bytes.subarray(0, offset))
        total += Buffer.byteLength(content)
        if (total > 250_000) throw new RemoteAccessError('Total remote file context exceeds 250 KB.', 400)
        attachments.push({ id: item.id, kind: 'file', name: item.name, content })
      } finally { await handle.close(); current() }
    }
    return { attachments, current }
  }

  private agentTab(projectId: string, sessionId: string, agentSessionId: string): PaneTab & { uri: string } {
    const tab = this.tabs(projectId, sessionId).find(candidate => candidate.kind === 'agent' && candidate.resourceId === agentSessionId)
    if (!tab) throw new RemoteAccessError('That agent tab is not open in the shared workspace.', 404)
    return tab
  }

  /**
   * Runs a peer's call. Every branch records what happened so the owner sees remote work in this
   * machine's UI with the same weight as a local agent's actions.
   */
  async call(peer: RemotePeerRecord, method: string, rawArgs: unknown): Promise<unknown> {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Args
    if (process.env.CONDUCTOR_LIVE_TESTS === '1') throw new RemoteAccessError('Remote control is disabled during isolated live acceptance tests.', 503)
    // `in` would also accept every inherited key, so `constructor` and friends would pass here.
    if (!Object.hasOwn(remoteToolSignatures, method) && method !== 'tools.list') throw new RemoteAccessError('Unknown remote method; use tools.list.', 400)
    try {
      const result = await this.dispatch(peer, method, args)
      this.deps.peers.record(peer, method, typeof args.projectId === 'string' ? args.projectId : null, this.describe(method, args), 'allowed')
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.peers.record(peer, method, typeof args.projectId === 'string' ? args.projectId : null, this.describe(method, args), 'denied', message)
      throw error
    }
  }

  private describe(method: string, args: Args): string {
    const path = typeof args.path === 'string' ? ` ${args.path}` : ''
    const title = typeof args.title === 'string' ? ` “${args.title}”` : ''
    return `${method}${path}${title}`
  }

  private async dispatch(peer: RemotePeerRecord, method: string, args: Args): Promise<unknown> {
    const { database, backlogs, sessions } = this.deps
    if (method === 'tools.list') return remoteToolSignatures
    if (method === 'machine.describe') {
      return {
        machineId: this.deps.peers.machineId,
        machineName: this.deps.machineName(),
        observedAt: new Date().toISOString(),
        // Each project is advertised with the identity of the working copy behind it, so the
        // controlling machine can tell that it is still the project its owner confirmed.
        projects: this.deps.peers.sharedProjects(peer),
        providers: this.deps.providers().filter(provider => provider.available).map(provider => ({ id: provider.id, models: provider.models.map(model => model.id) }))
      }
    }
    if (method === 'projects.list') return this.deps.peers.sharedProjects(peer)
    /*
     * A project the owner asked for from their other machine. It is the one write outside a
     * granted project that exists, and it is bounded on purpose: a folder named from the request
     * but sanitised here, created inside this machine's own projects folder and nowhere else, and
     * shared with the peer that asked for it only. The alternative — pairing a folder made here
     * with a folder made there — is the mapping this whole feature exists to be rid of.
     */
    if (method === 'projects.create') {
      const create = this.deps.createProject
      if (!create) throw new RemoteAccessError('This machine cannot create projects for a paired machine.', 501)
      const created = await create(text(args, 'name', 120))
      const shared = this.deps.peers.shareProject(peer, created.id, `created from ${peer.machineName}`)
      if (!shared) throw new RemoteAccessError('This machine created the project but could not share it back.', 500)
      return shared
    }
    if (method === 'workspaces.list') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      return database.listSessions(project.id).map(workspace => ({ id: workspace.id, name: workspace.name, projectId: workspace.projectId }))
    }
    if (method === 'files.list') {
      const authority = this.deps.peers.captureProjectAuthority(peer, args.projectId)
      const project = authority.project
      const current = (): void => { this.deps.peers.requireCurrentProject(peer, args.projectId, authority.revision) }
      if (args.path === undefined && typeof args.query === 'string') {
        const query = args.query.slice(0, 300)
        const found = await searchProjectFiles([database.getProject(project.id)!], query, { showHidden: true })
        current()
        return found.map(file => ({ ...file, uri: conductorUri(project.id, 'file', file.path) }))
      }
      const requested = args.path === undefined || args.path === '' ? '.' : text(args, 'path', 4000)
      const directory = await workspacePath(project.path, requested, false)
      current()
      const directoryStat = await stat(directory)
      current()
      if (!directoryStat.isDirectory()) throw new RemoteAccessError('Remote file listing requires a directory.', 400)
      const entries = await readdir(directory, { withFileTypes: true })
      current()
      const root = await realpath(project.path)
      current()
      return entries
        .filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()) && !['.git', 'node_modules', 'out', 'dist'].includes(entry.name))
        .slice(0, 5000)
        .map(entry => ({
          name: entry.name,
          path: relative(root, join(directory, entry.name)).replaceAll('\\', '/'),
          kind: entry.isDirectory() ? 'directory' as const : 'file' as const
        }))
        .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1)
    }
    if (method === 'files.stat' || method === 'files.read' || method === 'files.write' || method === 'files.open'
      || method === 'files.describe' || method === 'files.readChunk') {
      const authority = this.deps.peers.captureProjectAuthority(peer, args.projectId)
      const project = authority.project
      const current = (): void => { this.deps.peers.requireCurrentProject(peer, args.projectId, authority.revision) }
      // workspacePath is the same containment check local agents get; it refuses anything that
      // resolves outside the project folder, including through symlinks and 8.3 aliases.
      const path = await workspacePath(project.path, text(args, 'path', 4000), method === 'files.write')
      current()
      const relativePath = relative(await realpath(project.path), path).replaceAll('\\', '/')
      current()
      if (method === 'files.describe' || method === 'files.readChunk') {
        const media = remoteMediaTypes[extname(relativePath).toLowerCase()]
        if (!media) throw new RemoteAccessError('Only safe raster images and allowlisted video files can be previewed remotely.', 400)
        const handle = await open(path, 'r')
        current()
        try {
          const before = await handle.stat()
          current()
          if (!before.isFile() || before.size <= 0 || before.size > REMOTE_FILE_MAX_ASSET_BYTES) {
            throw new RemoteAccessError(`Remote previews must be files no larger than ${REMOTE_FILE_MAX_ASSET_BYTES} bytes.`, 400)
          }
          const version = fileVersion(relativePath, before)
          if (method === 'files.describe') {
            return { path: relativePath, size: before.size, modifiedAt: before.mtime.toISOString(), version, ...media }
          }
          if (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) >= before.size
            || !Number.isSafeInteger(args.length) || Number(args.length) < 1 || Number(args.length) > REMOTE_FILE_CHUNK_BYTES
            || typeof args.version !== 'string' || args.version !== version) {
            throw new RemoteAccessError('The requested remote resource range or version is invalid.', 409)
          }
          const offset = Number(args.offset), length = Math.min(Number(args.length), before.size - offset)
          const bytes = Buffer.allocUnsafe(length)
          const { bytesRead } = await handle.read(bytes, 0, length, offset)
          current()
          const after = await handle.stat()
          current()
          if (fileVersion(relativePath, after) !== version || after.size !== before.size) {
            throw new RemoteAccessError('The remote resource changed while it was being read.', 409)
          }
          return {
            path: relativePath, offset, length: bytesRead, totalSize: before.size, version,
            bytesBase64: bytes.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= before.size
          }
        } finally { await handle.close(); current() }
      }
      if (method === 'files.stat') {
        const fileStat = await stat(path)
        current()
        return { size: fileStat.size, isFile: fileStat.isFile(), modifiedAt: fileStat.mtime.toISOString() }
      }
      if (method !== 'files.write' && (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)) throw new RemoteAccessError('Only text files up to 1 MiB are supported.', 400)
      if (method === 'files.open') {
        const { sessionId } = this.workspace(peer, args)
        return this.ui(project.id, sessionId, 'files.open', { path: relativePath })
      }
      if (method === 'files.read') return { path: relativePath, content: readTextFile(path), uri: conductorUri(project.id, 'file', relativePath) }
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 1024 * 1024
        || !(args.expectedContent === null || typeof args.expectedContent === 'string' && Buffer.byteLength(args.expectedContent) <= 1024 * 1024)) {
        throw new RemoteAccessError('Provide content and the exact expectedContent (null for a new file), up to 1 MiB.', 400)
      }
      const saved = writeEditorFile(path, args.content, args.expectedContent)
      if (saved.status === 'saved') { invalidateProjectFiles(project.path); this.deps.fileChanged({ projectId: project.id, path: relativePath }) }
      return saved
    }
    if (method === 'services.list') {
      if (!this.deps.services) throw new RemoteAccessError('This machine is not sharing any services.', 503)
      return this.deps.services.list(peer, args.projectId)
    }
    if (method.startsWith('terminals.')) {
      if (!this.terminals) throw new RemoteAccessError('Terminals are not available on this machine.', 503)
      return this.terminals.call(peer, method, args)
    }
    if (method === 'tasks.list') return backlogs.get(this.deps.peers.requireProject(peer, args.projectId).id)
    if (method === 'tasks.create') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      const board = await backlogs.get(project.id)
      const revision = text(args, 'revision', 100)
      const title = text(args, 'title', PROJECT_TASK_MAX_LENGTH)
      const kind = args.kind
      const priority = args.priority ?? 'normal', weight = args.weight ?? 'medium'
      if (!projectTaskKinds.includes(kind as ProjectTaskKind)) throw new RemoteAccessError('Invalid task kind.', 400)
      if (!projectTaskPriorities.includes(priority as ProjectTaskPriority)) throw new RemoteAccessError('Invalid task priority.', 400)
      if (!projectTaskWeights.includes(weight as ProjectTaskWeight)) throw new RemoteAccessError('Invalid task weight.', 400)
      const before = new Set(board.tasks.map(task => task.id))
      const updated = await backlogs.edit(project.id, revision, { type: 'add', title, kind: kind as ProjectTaskKind, priority: priority as ProjectTaskPriority, weight: weight as ProjectTaskWeight }, { actor: 'you' })
      const added = updated.tasks.find(task => !before.has(task.id))
      if (!added) throw new RemoteAccessError('The task was not added.', 409)
      this.deps.fileChanged({ projectId: project.id, path: 'feature-list.md' })
      return added
    }
    if (method === 'tasks.update') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      const board = await backlogs.get(project.id), id = text(args, 'id', 160)
      const task = board.tasks.find(entry => entry.id === id)
      if (!task) throw new RemoteAccessError('Task not found.', 404)
      const status = args.status === undefined ? task.status : args.status
      if (!['todo', 'doing', 'done'].includes(String(status))) throw new RemoteAccessError('Invalid task status.', 400)
      if (args.priority !== undefined && !projectTaskPriorities.includes(args.priority as ProjectTaskPriority)) throw new RemoteAccessError('Invalid task priority.', 400)
      const updated = await backlogs.edit(project.id, text(args, 'revision', 100), {
        type: 'update', id, status: status as 'todo' | 'doing' | 'done',
        ...(args.title === undefined ? {} : { title: text(args, 'title', PROJECT_TASK_MAX_LENGTH) }),
        ...(args.priority === undefined ? {} : { priority: args.priority as ProjectTaskPriority })
      })
      this.deps.fileChanged({ projectId: project.id, path: 'feature-list.md' })
      return updated
    }
    const { projectId, sessionId } = this.workspace(peer, args)
    if (method === 'tabs.list') return this.tabs(projectId, sessionId)
    if (method === 'tabs.open') return this.open(peer, projectId, sessionId, args)
    if (method === 'tabs.focus' || method === 'tabs.close') {
      const tabId = text(args, 'tabId', 160)
      if (!this.tabs(projectId, sessionId).some(tab => tab.id === tabId)) throw new RemoteAccessError('That tab is no longer open.', 404)
      return this.ui(projectId, sessionId, method, { tabId })
    }
    if (method === 'agents.list') {
      return this.tabs(projectId, sessionId).filter(tab => tab.kind === 'agent').map(tab => {
        const snapshot = database.structured.snapshot(tab.resourceId!)
        return { tabId: tab.id, agentSessionId: tab.resourceId, title: tab.title, uri: tab.uri, machineId: LOCAL_MACHINE_ID, phase: snapshot?.phase, provider: tab.state?.provider, model: snapshot?.settings.model }
      })
    }
    if (method.startsWith('agents.')) {
      const agentSessionId = text(args, 'agentSessionId', 160)
      const tab = this.agentTab(projectId, sessionId, agentSessionId)
      const state = database.structured.snapshot(agentSessionId)
      if (!state) throw new RemoteAccessError('That agent session is not available.', 404)
      if (method === 'agents.snapshot') {
        const recent = [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence)).slice(0, 60)
        return { tabId: tab.id, agentSessionId, machineId: LOCAL_MACHINE_ID, ...state, items: recent.sort((a, b) => a.sequence - b.sequence), truncated: state.truncated || state.items.length > recent.length }
      }
      if (method === 'agents.history') {
        const after = typeof args.afterSequence === 'number' && Number.isSafeInteger(args.afterSequence) && args.afterSequence >= 0 ? args.afterSequence : 0
        return database.structured.events(agentSessionId, after).slice(0, 100)
      }
      const requestedSettings = args.settings === undefined ? state.settings : args.settings as SessionSettings
      if (method === 'agents.interrupt') {
        await sessions.interrupt(agentSessionId, args.expediteSubmittedInput === true)
        return { interrupted: true }
      }
      if (method === 'agents.resume') { await sessions.resume(agentSessionId, args.settings === undefined ? undefined : requestedSettings); return { resumed: true } }
      if (method === 'agents.discover') return sessions.discover(agentSessionId)
      if (method === 'agents.settings') { sessions.saveSettings(agentSessionId, requestedSettings); return { saved: true } }
      if (method === 'agents.cancelQueued') {
        if (args.promptId !== undefined && typeof args.promptId !== 'string') throw new RemoteAccessError('Invalid promptId', 400)
        return sessions.cancelQueued(agentSessionId, args.promptId as string | undefined)
      }
      if (method === 'agents.respond') {
        if (!args.response || typeof args.response !== 'object') throw new RemoteAccessError('Invalid response', 400)
        const response = args.response as InteractionResponse
        await sessions.respond({ ...response, sessionId: agentSessionId })
        return { responded: true }
      }
      if (method === 'agents.rename') { await sessions.rename(agentSessionId, text(args, 'title', 160)); return { renamed: true } }
      if (method === 'agents.archive') {
        if (typeof args.archived !== 'boolean') throw new RemoteAccessError('Invalid archived', 400)
        await sessions.archive(agentSessionId, args.archived)
        return { archived: args.archived }
      }
      if (method === 'agents.submit' || method === 'agents.steer' || method === 'agents.queue') {
        const prompt = text(args, 'prompt')
        const remoteContext = await this.promptAttachments(peer, projectId, args.attachments)
        remoteContext.current()
        // Attributed to the peer machine, never to "You", so the owner can always tell remote
        // work apart in the transcript.
        // Caller-supplied origin/authority is deliberately ignored. Only the host that already
        // authenticated this socket may stamp the durable dispatch authority.
        const authority: PromptDispatchAuthority = { kind: 'remote-peer', peerId: peer.id, projectId }
        const origin: PromptOrigin = {
          agentSessionId: `remote:${peer.id}`, label: `${peer.machineName} (remote)`, authority
        }
        if (method === 'agents.submit') await sessions.submit(agentSessionId, prompt, requestedSettings, remoteContext.attachments, origin)
        else if (method === 'agents.steer') await sessions.steer(agentSessionId, prompt, requestedSettings, remoteContext.attachments, origin)
        else await sessions.queue(agentSessionId, prompt, requestedSettings, remoteContext.attachments, origin)
        remoteContext.current()
        return { agentSessionId, tabId: tab.id, uri: tab.uri, phase: database.structured.snapshot(agentSessionId)?.phase }
      }
    }
    throw new RemoteAccessError('Unknown remote method; use tools.list.', 400)
  }

  /**
   * Opens a real, visible tab on this machine. The remote caller never gets more autonomy than it
   * asks for and the peer's machine is stamped on the tab so the owner can see whose work it is.
   */
  private async open(peer: RemotePeerRecord, projectId: string, sessionId: string, args: Args, source: 'tabs.open' | 'terminals.open' = 'tabs.open'): Promise<unknown> {
    const kind = args.kind === undefined ? 'agent' : String(args.kind)
    // Kinds a peer may open are listed here rather than excluded, so a new tab kind is opt-in.
    const allowed = ['agent', 'file-tree', 'tasks', 'logs']
    // A terminal tab is a PTY on this machine. `tabs.open` may never ask for one: the only way a
    // paired machine gets a shell here is terminals.open, which is the trust boundary
    // docs/multi-device.md spells out - a device allowed to open a shell acts as this machine's
    // user, reaching every file, credential and network this machine's own commands reach. That
    // decision belongs to the operation the owner approved, with its grant, its bounded write and
    // its ring buffer, not to a general "open me a tab" call.
    if (source === 'terminals.open') allowed.push('terminal')
    if (!allowed.includes(kind)) throw new RemoteAccessError('Unsupported remote tab kind.', 400)
    const project = this.deps.database.getProject(projectId)
    if (!project) throw new RemoteAccessError('That project is no longer registered on this machine.', 404)
    const tab: PaneTab = { id: makeId('tab'), kind: kind as PaneTab['kind'], title: args.title === undefined ? (kind === 'agent' ? 'Agent' : kind) : text(args, 'title', 120) }
    if (kind === 'terminal') {
      // The pane binds to the shell that terminals.open already started; it never spawns one, and
      // it is stamped like a remote agent tab so the owner sees whose shell is running here.
      tab.resourceId = text(args, 'terminalId', 160)
      tab.state = { machineId: LOCAL_MACHINE_ID, remotePeerId: peer.id, remoteMachineName: peer.machineName }
    }
    if (kind === 'agent') {
      const provider = String(args.provider ?? 'codex') as StructuredProvider
      const entry = this.deps.providers().find(candidate => candidate.id === provider && candidate.available)
      if (!entry) throw new RemoteAccessError('That provider is not available on this machine.', 409)
      const model = typeof args.model === 'string'
        ? entry.models.find(candidate => candidate.id === args.model)
        : entry.models.find(candidate => candidate.isDefault) ?? entry.models[0]
      if (!model) throw new RemoteAccessError('Choose a model this machine offers.', 400)
      tab.resourceId = makeId('agent')
      tab.title = args.title === undefined ? model.label : tab.title
      tab.state = { provider, model: model.id, effort: typeof args.effort === 'string' ? args.effort : 'auto', viewMode: 'visual', machineId: LOCAL_MACHINE_ID, remotePeerId: peer.id, remoteMachineName: peer.machineName }
      const spec: AgentSpec = { id: tab.resourceId, projectId, sessionId, provider, model: model.id, title: tab.title, cwd: project.path }
      const created = this.deps.sessions.ensure(spec)
      if (!created.available) throw new RemoteAccessError(created.message || 'Provider unavailable on this machine.', 409)
      const snapshot = this.deps.database.structured.snapshot(spec.id)!
      // A remote caller cannot hand itself more permission than the owner granted; anything
      // beyond the default has to be chosen on this machine. A runtime with no neutral default at
      // all - the local models never ask, so 'default' is a mode they cannot honour - keeps the
      // mode ensure() opened it on, the same one a tab opened on this machine gets: forcing
      // 'default' there produced a conversation that refused its first message as unsupported.
      const offered = snapshot.capabilities?.permissions
      const permission = !offered?.length || offered.includes('default') ? 'default' : snapshot.settings.permission
      const settings: SessionSettings = { ...snapshot.settings, model: model.id, permission }
      this.deps.database.structured.update(spec.id, { settings })
    }
    await this.ui(projectId, sessionId, 'tabs.open', { tab })
    const opened = this.tabs(projectId, sessionId).find(candidate => candidate.id === tab.id)
    if (!opened) throw new RemoteAccessError('The tab was not opened on this machine.', 500)
    return opened
  }
}
