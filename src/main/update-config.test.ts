import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GITHUB_UPDATE_OWNER,
  DEFAULT_GITHUB_UPDATE_REPO,
  normalizeUpdateFeedUrl,
  resolveUpdateProvider
} from './update-config'

describe('update feed configuration', () => {
  it('normalizes an HTTPS release directory', () => {
    expect(normalizeUpdateFeedUrl(' https://updates.example.com/conductor '))
      .toBe('https://updates.example.com/conductor/')
  })

  it('allows loopback HTTP for local release testing', () => {
    expect(normalizeUpdateFeedUrl('http://127.0.0.1:8080/releases'))
      .toBe('http://127.0.0.1:8080/releases/')
  })

  it('rejects insecure remote and credential-bearing feeds', () => {
    expect(() => normalizeUpdateFeedUrl('http://updates.example.com')).toThrow('HTTPS')
    expect(() => normalizeUpdateFeedUrl('https://user:secret@updates.example.com')).toThrow('credentials')
  })

  it('keeps an empty custom feed for the built-in GitHub source', () => {
    expect(normalizeUpdateFeedUrl('  ')).toBe('')
  })

  it('uses Conductor GitHub Releases by default', () => {
    expect(resolveUpdateProvider('')).toEqual({
      provider: 'github',
      owner: DEFAULT_GITHUB_UPDATE_OWNER,
      repo: DEFAULT_GITHUB_UPDATE_REPO,
      releaseType: 'release'
    })
  })

  it('keeps an HTTPS feed as an explicit development override', () => {
    expect(resolveUpdateProvider('https://updates.example.com/conductor')).toEqual({
      provider: 'generic',
      url: 'https://updates.example.com/conductor/'
    })
  })
})
