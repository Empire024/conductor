import type { CSSProperties } from 'react'
import openai from '../assets/providers/openai.svg'
import claude from '../assets/providers/claude.svg'
import gemini from '../assets/providers/gemini.svg'
import qwen from '../assets/providers/qwen.svg'
import kimi from '../assets/providers/kimi.svg'
const icons: Record<string, string> = { codex: openai, openai, claude, gemini, qwen, kimi }
const labels: Record<string, string> = { codex: 'OpenAI', openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen', kimi: 'Kimi' }
export function ProviderIcon({ provider = 'codex', model, size = 16 }: { provider?: string; model?: string; size?: number }): React.JSX.Element {
  const key = /claude|opus|sonnet|haiku|fable/i.test(model ?? '') ? 'claude' : /gemini/i.test(model ?? '') ? 'gemini' : /qwen/i.test(model ?? '') ? 'qwen' : /kimi/i.test(model ?? '') ? 'kimi' : /gpt|o[134]-/i.test(model ?? '') ? 'codex' : provider
  return <span role="img" aria-label={labels[key] ?? provider} className={'provider-logo provider-' + key} style={{ '--provider-logo': 'url("' + (icons[key] ?? openai) + '")', width: size, height: size } as CSSProperties} />
}
