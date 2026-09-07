export const DEFAULT_GITHUB_UPDATE_OWNER = 'Empire024'
export const DEFAULT_GITHUB_UPDATE_REPO = 'conductor'
export const DEFAULT_GITHUB_UPDATE_URL = `https://github.com/${DEFAULT_GITHUB_UPDATE_OWNER}/${DEFAULT_GITHUB_UPDATE_REPO}/releases`

export const normalizeUpdateFeedUrl = (requested: string): string => {
  const value = requested.trim()
  if (!value) return ''

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid update feed URL')
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('The update feed must use HTTPS')
  }
  if (url.username || url.password) throw new Error('The update feed cannot contain credentials')
  if (url.search || url.hash) throw new Error('The update feed cannot contain a query or fragment')

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.toString()
}

export type ConductorUpdateProvider =
  | { provider: 'generic'; url: string; useMultipleRangeRequest?: boolean }
  | { provider: 'github'; owner: string; repo: string; releaseType: 'release' }

export const resolveUpdateProvider = (requestedUrl: string): ConductorUpdateProvider => {
  const feedUrl = normalizeUpdateFeedUrl(requestedUrl)
  return feedUrl
    ? { provider: 'generic', url: feedUrl }
    : {
        provider: 'github',
        owner: DEFAULT_GITHUB_UPDATE_OWNER,
        repo: DEFAULT_GITHUB_UPDATE_REPO,
        releaseType: 'release'
      }
}
