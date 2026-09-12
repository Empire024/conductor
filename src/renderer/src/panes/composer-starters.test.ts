import { describe, expect, it } from 'vitest'
import { BUILT_IN_STARTERS, composerStarterChoices, prepareComposerDraft } from './composer-starters'

describe('composer starter and skill selector', () => {
  it('ships a provider-neutral grill-me workflow that interviews without acting', () => {
    const grill = BUILT_IN_STARTERS.find(choice => choice.id === 'grill-me')!
    expect(grill.draft).toContain('one incisive question at a time')
    expect(grill.draft).toContain('Do not start implementing')
    expect(grill.draft).toContain('smallest useful next experiment')
  })

  it('reuses native Codex skill and Claude command discovery as draft-only choices', () => {
    const discovery = {
      initialize: { commands: [{ name: 'review', description: 'Review changes' }] },
      skills: { payload: { data: [{ skills: [{ name: 'security-audit', description: 'Audit boundaries' }] }] } }
    }
    const configured = composerStarterChoices(undefined, discovery).filter(choice => choice.kind !== 'starter')
    expect(configured).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '/review', draft: '/review ', kind: 'configured-command' }),
      expect.objectContaining({ label: '$security-audit', draft: '$security-audit ', kind: 'configured-skill' })
    ]))
  })

  it('prepares without erasing an existing draft or introducing execution metadata', () => {
    const choice = BUILT_IN_STARTERS[1]!
    expect(prepareComposerDraft('', choice)).toBe(choice.draft)
    expect(prepareComposerDraft('Keep my context  ', choice)).toBe(`Keep my context\n\n${choice.draft}`)
    expect(Object.keys(choice).sort()).toEqual(['description', 'draft', 'id', 'kind', 'label'])
  })
})
