import type { AgentProviderId, PaneKind, PaneTab } from '../../../shared/models'
import { makeId } from '../../../shared/models'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'

export const createPaneTab = (
  kind: PaneKind,
  options?: {
    provider?: AgentProviderId; path?: string; title?: string; resume?: boolean; line?: number
    /** Where this tab runs. Absent means this machine, which is what an unplaced tab has always meant. */
    machineId?: string
    /** The mirrored session id minted when the tab was placed on another machine. */
    resourceId?: string
  }
): PaneTab => {
  switch (kind) {
    case 'agent': {
      const provider = options?.provider ?? 'codex'
      const remote = options?.machineId && options.machineId !== LOCAL_MACHINE_ID ? { machineId: options.machineId } : {}
      return {
        id: makeId('pane'),
        kind,
        title: options?.title ?? ({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen Code', kimi: 'Kimi Code' }[provider]),
        resourceId: options?.resourceId ?? makeId('agent'),
        state: { provider, resume: Boolean(options?.resume), model: 'default', effort: 'auto', ...remote }
      }
    }
    case 'terminal':
      return {
        id: makeId('pane'),
        kind,
        title: options?.title ?? 'PowerShell',
        resourceId: makeId('terminal'),
        state: { shell: 'powershell' }
      }
    case 'file-tree':
      return { id: makeId('pane'), kind, title: options?.title ?? 'Files' }
    case 'code': {
      const path = options?.path ?? ''
      return {
        id: makeId('pane'),
        kind,
        title: options?.title ?? path.split('/').pop() ?? 'Editor',
        resourceId: path,
        state: { path, line: options?.line }
      }
    }
    case 'preview': {
      const path = options?.path ?? ''
      return {
        id: makeId('pane'),
        kind,
        title: options?.title ?? path.split('/').pop() ?? 'Preview',
        resourceId: path,
        state: { path }
      }
    }
    case 'browser':
      return {
        id: makeId('pane'),
        kind,
        title: options?.title ?? 'Browser',
        state: { url: 'http://localhost:3000' }
      }
    case 'memory':
      return { id: makeId('pane'), kind, title: options?.title ?? 'Memory' }
    case 'logs':
      return { id: makeId('pane'), kind, title: options?.title ?? 'Processes' }
    default:
      return { id: makeId('pane'), kind, title: options?.title ?? kind }
  }
}
