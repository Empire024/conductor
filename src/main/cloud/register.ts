import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import { CLOUD_CHANNELS, type CloudRunSummary } from '../../shared/cloud'
import type { AgentControlUiRequest } from '../../shared/agent-control'
import type { PaneTab } from '../../shared/models'
import { registerCloudIpc } from './ipc'
import { CloudRuns, type CloudSpawn } from './runs'

const spawnPty: CloudSpawn = (file, args, options) => pty.spawn(file, args, {
  name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, useConptyDll: process.platform === 'win32'
})

/** The client's output goes to this machine's windows only: a PTY stream is not a notice for phones. */
const toWindows = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload)
}

export interface CloudRegistration {
  runs: CloudRuns
  /** Registers the owner window's IPC; call once, from where the other trusted IPC is registered. */
  registerIpc(options: { authorize(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, projectId: string): void; projectPath(projectId: string): string | null }): void
  dispose(): void
}

/**
 * Cloud runs for the app: the run store under userData/cloud, plugged into app control with
 * AgentControl.setCloud by the caller, and the owner window's IPC. An offline test launch runs the
 * fixture client (scripts/fixtures/cloud-cli.cjs) instead of the real CLI, so it never creates a
 * cloud session.
 */
export function createCloud(options: {
  userData: string
  /** The claude CLI, or null. */
  claudeExecutable(): string | null
  ui(request: AgentControlUiRequest): Promise<unknown>
}): CloudRegistration {
  const offline = process.env.CONDUCTOR_OFFLINE_TESTS === '1'
  const runs = new CloudRuns({
    root: join(options.userData, 'cloud'),
    executable: offline ? () => process.env.CONDUCTOR_TEST_NODE_EXECUTABLE || process.execPath : options.claudeExecutable,
    // The fixture's teleport saves a conversation; it never lands in the owner's own ~/.claude.
    ...(offline ? { prefixArgs: [join(process.cwd(), 'scripts/fixtures/cloud-cli.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(options.userData, 'claude-config') } } : {}),
    spawn: spawnPty,
    onData: event => toWindows(CLOUD_CHANNELS.data, event),
    onChanged: summary => toWindows(CLOUD_CHANNELS.changed, summary)
  })
  // The owner's own launcher choice opens in front, like any tab the owner opens.
  const openTab = (run: CloudRunSummary): Promise<unknown> => {
    const tab: PaneTab = { id: `tab_${randomUUID().slice(0, 12)}`, kind: 'cloud', title: run.title.slice(0, 120), resourceId: run.id, state: { model: run.model } }
    return options.ui({ projectId: run.projectId, sessionId: run.workspaceId, agentSessionId: 'owner', owner: true, id: randomUUID(), action: 'tabs.open', params: { tab, focus: true } })
  }
  let disposeIpc: (() => void) | undefined
  return {
    runs,
    registerIpc: ipc => { disposeIpc ??= registerCloudIpc({ runs, openTab, ...ipc }) },
    dispose: () => { disposeIpc?.(); disposeIpc = undefined; runs.dispose() }
  }
}
