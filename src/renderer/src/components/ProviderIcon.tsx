import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bird, Cpu, Orbit, Shell, Sparkles } from 'lucide-react'
import openai from '../assets/providers/openai.svg'
import claude from '../assets/providers/claude.svg'
import gemini from '../assets/providers/gemini.svg'
import qwen from '../assets/providers/qwen.svg'
import kimi from '../assets/providers/kimi.svg'
import grok from '../assets/providers/grok.svg'
import {
  LOCAL_DOLPHIN_X1_8B,
  LOCAL_ORNITH_9B,
  LOCAL_QWEN_35B,
  LOCAL_QWEN_9B
} from '../../../shared/local-models'

const icons: Record<string, string> = { codex: openai, openai, claude, gemini, qwen, kimi, grok }
const labels: Record<string, string> = { codex: 'OpenAI', openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen', kimi: 'Kimi', grok: 'Grok', local: 'Local' }

/** Each locally served model gets its own glyph so a busy sidebar can tell them apart at a
 *  glance rather than all wearing the same Qwen mark. A local model outside this map (a build
 *  not shipped yet) still falls back to the generic Cpu glyph instead of borrowing another
 *  model's identity. Keyed by the ids in shared/local-models.ts. */
export const LOCAL_MODEL_GLYPHS: Record<string, { icon: LucideIcon; label: string }> = {
  [LOCAL_ORNITH_9B]: { icon: Bird, label: 'Ornith 1.5' },
  [LOCAL_QWEN_9B]: { icon: Orbit, label: 'Qwen 3.5' },
  [LOCAL_QWEN_35B]: { icon: Sparkles, label: 'Qwen 3.6' },
  [LOCAL_DOLPHIN_X1_8B]: { icon: Shell, label: 'Dolphin X1' }
}

/** Falls back to the generic Cpu glyph for any local model this map does not recognize yet,
 *  rather than borrowing another model's identity. */
export function localModelGlyph(model?: string): { icon: LucideIcon; label: string } {
  return LOCAL_MODEL_GLYPHS[model ?? ''] ?? { icon: Cpu, label: 'Local' }
}

export function ProviderIcon({ provider = 'codex', model, size = 16 }: { provider?: string; model?: string; size?: number }): React.JSX.Element {
  if (provider === 'local') {
    const { icon: Icon, label } = localModelGlyph(model)
    return <Icon role="img" aria-label={label} className="provider-logo-icon provider-local" width={size} height={size} strokeWidth={1.8} />
  }
  const key = /claude|opus|sonnet|haiku|fable/i.test(model ?? '') ? 'claude' : /gemini/i.test(model ?? '') ? 'gemini' : /qwen/i.test(model ?? '') ? 'qwen' : /kimi/i.test(model ?? '') ? 'kimi' : /grok/i.test(model ?? '') ? 'grok' : /gpt|o[134]-/i.test(model ?? '') ? 'codex' : provider
  return <span role="img" aria-label={labels[key] ?? provider} className={'provider-logo provider-' + key} style={{ '--provider-logo': 'url("' + (icons[key] ?? openai) + '")', width: size, height: size } as CSSProperties} />
}
