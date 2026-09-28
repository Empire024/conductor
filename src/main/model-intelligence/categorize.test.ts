import { describe, expect, it } from 'vitest'
import { categorize, categoryOf } from './categorize'

describe('categorize', () => {
  it.each([
    ['fix the failing test', 'debugging'],
    ['rename variable foo to bar', 'simple-coding'],
    ['design the architecture for the sync service', 'architecture'],
    ['research and compare sources on WebGPU support', 'research'],
    ['summarize this thread', 'summarization'],
    ['review the diff before merge', 'review'],
    ['implement a lock-free queue', 'difficult-coding'],
    ['restyle the settings modal with tailwind', 'frontend'],
    ['return only JSON matching the schema', 'structured-output'],
    ['refactor logging across the whole codebase', 'large-repo'],
    ['hello there', 'general'],
  ] as const)('%s → %s', (prompt, category) => { expect(categoryOf({ prompt })).toBe(category) })

  it('uses tools, attachments and context size', () => {
    expect(categoryOf({ prompt: 'check the signup flow', tools: ['browser_navigate', 'browser_click'] })).toBe('browser-use')
    expect(categoryOf({ prompt: 'what is wrong here', attachments: [{ kind: 'image', name: 'shot.png' }] })).toBe('vision')
    expect(categoryOf({ prompt: 'look at this screenshot' })).toBe('vision')
    expect(categoryOf({ prompt: 'fix the bug', contextTokens: 250_000 })).toBe('long-context')
  })
  it('scores complexity and risk, keeps tools and bounds the summary', () => {
    expect(categorize({ prompt: 'rename variable x' })).toMatchObject({ category: 'simple-coding', complexity: 1, risk: 'low' })
    expect(categorize({ prompt: 'fix the intermittent race in the scheduler' })).toMatchObject({ category: 'debugging', complexity: 4, risk: 'medium' })
    expect(categorize({ prompt: 'deploy the fix to production' }).risk).toBe('high')
    // Talking about a release is not cutting one.
    expect(categorize({ prompt: 'Summarize the release notes into a short recap' }).risk).toBe('low')
    expect(categorize({ prompt: 'cut a new release and tag it' }).risk).toBe('high')
    const features = categorize({ prompt: 'x '.repeat(400) + 'implement it', tools: ['Bash', 'Bash', 'Edit'], contextTokens: 1200, projectId: 'p1' })
    expect(features.toolsRequired).toEqual(['Bash', 'Edit'])
    expect(features.contextTokens).toBe(1200); expect(features.projectId).toBe('p1')
    expect(features.summary!.length).toBeLessThanOrEqual(300)
    expect(categorize({ prompt: '' })).toMatchObject({ category: 'general', contextTokens: null })
    expect(categorize({ prompt: '' }).summary).toBeUndefined()
  })
  it('is deterministic', () => {
    const input = { prompt: 'debug the crash in the parser', tools: ['Read'] }
    expect(categorize(input)).toEqual(categorize(input))
  })
})
