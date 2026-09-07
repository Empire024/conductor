import { ProviderIcon } from '../components/ProviderIcon'
import {
  Bot,
  ChevronRight,
  Sparkles,
  TerminalSquare
} from 'lucide-react'
import type { AgentProviderId, PaneKind } from '../../../shared/models'

interface LauncherPaneProps {
  onOpen(kind: PaneKind, provider?: AgentProviderId): void
}

const choices: Array<{
  kind: PaneKind
  provider?: AgentProviderId
  icon: typeof Bot
  title: string
  tone: string
  key: string
}> = [
  { kind: 'agent', provider: 'claude', icon: Sparkles, title: 'Claude Code', tone: 'amber', key: 'C' },
  { kind: 'agent', provider: 'codex', icon: Bot, title: 'Codex', tone: 'green', key: 'X' },
  { kind: 'agent', provider: 'qwen', icon: Bot, title: 'Qwen Code', tone: 'cyan', key: 'Q' },
  { kind: 'agent', provider: 'kimi', icon: Sparkles, title: 'Kimi Code', tone: 'violet', key: 'K' },
  { kind: 'agent', provider: 'gemini', icon: Sparkles, title: 'Gemini CLI', tone: 'blue', key: 'G' },
  { kind: 'terminal', icon: TerminalSquare, title: 'PowerShell', tone: 'blue', key: 'T' }
]

export function LauncherPane({ onOpen }: LauncherPaneProps): React.JSX.Element {
  return (
    <div className="launcher-pane">
      <div className="launcher-grid" aria-label="Open runtime">
        {choices.map(({ kind, provider, icon: Icon, title, tone, key }) => (
          <button key={`${kind}-${provider ?? ''}`} onClick={() => onOpen(kind, provider)}>
            <span className={`launch-icon ${tone}`}>{provider ? <ProviderIcon provider={provider} size={21} /> : <Icon size={19} />}</span>
            <span><strong>{title}</strong></span>
            <kbd>{key}</kbd>
            <ChevronRight className="launch-arrow" size={15} />
          </button>
        ))}
      </div>
    </div>
  )
}
