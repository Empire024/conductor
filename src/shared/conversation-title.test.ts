import { describe, expect, it } from 'vitest'
import { deriveConversationTitle } from './conversation-title'

describe('deriveConversationTitle', () => {
  it('truncates a long prompt at a word boundary with an ellipsis', () => {
    const prompt = 'Please refactor the authentication module to use the new session token format across every API route'
    expect(deriveConversationTitle(prompt)).toBe('Please refactor the authentication…')
  })

  it('collapses newlines and tabs into single spaces', () => {
    expect(deriveConversationTitle('Fix the bug\nin the login flow')).toBe('Fix the bug in the login flow')
  })

  it('collapses whitespace and still truncates when the collapsed text is long', () => {
    const prompt = 'Fix the login bug\n\nit happens whenever\tthe session expires mid-request'
    expect(deriveConversationTitle(prompt)).toBe('Fix the login bug it happens whenever…')
  })

  it('drops a leading slash-command token and titles from what follows it', () => {
    const prompt = '/review please check the auth module for security issues in the token refresh path'
    expect(deriveConversationTitle(prompt)).toBe('please check the auth module for…')
  })

  it('falls back to the bare command when nothing follows it', () => {
    expect(deriveConversationTitle('/clear')).toBe('/clear')
  })

  it('returns a very short prompt unchanged', () => {
    expect(deriveConversationTitle('hi')).toBe('hi')
  })

  it('returns empty for a prompt that is only whitespace (e.g. an attachment-only send)', () => {
    expect(deriveConversationTitle('   \n\t  ')).toBe('')
  })

  it('returns empty for a genuinely empty prompt', () => {
    expect(deriveConversationTitle('')).toBe('')
  })
})
