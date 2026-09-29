import { describe, expect, it } from 'vitest'
import type { ModelUpgradeOffer } from '../../shared/model-upgrades'
import { CODEX_VERIFIED_RUNTIMES } from '../providers/codex'
import { CLAUDE_COMPATIBILITY } from '../providers/claude'
import { conductorSupports, fixerBrief } from './app-wiring'

describe('model upgrade wiring', () => {
  it('matches the adapters\' own connect gates', () => {
    for (const runtime of CODEX_VERIFIED_RUNTIMES) expect(conductorSupports('codex', runtime)).toBe(true)
    expect(conductorSupports('codex', '0.999.0')).toBe(false)
    expect(conductorSupports('claude', CLAUDE_COMPATIBILITY)).toBe(true)
    expect(conductorSupports('claude', `${Number(CLAUDE_COMPATIBILITY.split('.')[0]) + 1}.0.0`)).toBe(false)
  })

  it('briefs the fixer with the documented rebaseline, the scratch CLI and how to report', () => {
    const offer = { id: 'codex:gpt-7-astra', provider: 'codex', label: 'GPT-7-Astra', cli: { from: '0.159.1', to: '0.163.0', executable: 'C:/scratch/codex.exe' } } as ModelUpgradeOffer
    const brief = fixerBrief(offer, offer.cli!.executable)
    expect(brief).toContain('C:/scratch/codex.exe')
    expect(brief).toContain('never install or upgrade the global CLI')
    expect(brief).toContain('scripts/generate-codex-protocol.mjs to 0.163.0')
    expect(brief).toContain('models.upgrades.prepared({id:"codex:gpt-7-astra", commit:"<sha>"})')
    expect(brief).toContain('blocked:')
    expect(brief).toContain('never publish')
  })
})
