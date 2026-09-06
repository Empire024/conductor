export type WorkspaceSidebarMode = 'workspace' | 'explorer' | 'browser'
export type ExplorerOpenMode = 'editor' | 'preview'
export type ExplorerFileKind = 'markdown' | 'image' | 'media' | 'pdf' | 'text' | 'external'

const extensionOf = (path: string): string => path.split('.').pop()?.toLowerCase() ?? ''

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])
const IMAGE_EXTENSIONS = new Set(['apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const MEDIA_EXTENSIONS = new Set(['m4a', 'mov', 'mp3', 'mp4', 'ogg', 'wav', 'webm'])
const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'env', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'jsx',
  'json', 'jsonc', 'log', 'lua', 'mjs', 'php', 'properties', 'ps1', 'py', 'rb', 'rs', 'scss', 'sh',
  'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml'
])

export const classifyExplorerFile = (path: string): ExplorerFileKind => {
  const extension = extensionOf(path)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (MEDIA_EXTENSIONS.has(extension)) return 'media'
  if (extension === 'pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(extension) || !path.split('/').pop()?.includes('.')) return 'text'
  return 'external'
}

export const defaultExplorerOpenMode = (path: string): ExplorerOpenMode | null => {
  const kind = classifyExplorerFile(path)
  if (kind === 'markdown' || kind === 'image' || kind === 'media' || kind === 'pdf') return 'preview'
  if (kind === 'text') return 'editor'
  return null
}
