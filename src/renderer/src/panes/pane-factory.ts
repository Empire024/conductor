import type { AgentProviderId, PaneKind, PaneTab } from '../../../shared/models'
import { makeId } from '../../../shared/models'

export const createPaneTab = (
  kind: PaneKind,
  options?: { provider?: AgentProviderId; path?: string; title?: string; resume?: boolean; line?: number }
): PaneTab => {
  switch (kind) {
    case 'agent': {
      const provider = options?.provider ?? 'codex'
      return {
        id: makeId('pane'),
        kind,
        title: options?.title ?? ({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen Code', kimi: 'Kimi Code' }[provider]),
        resourceId: makeId('agent'),
        state: { provider, resume: Boolean(options?.resume), model: 'default', effort: 'auto' }
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
