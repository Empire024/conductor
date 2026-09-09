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

/** How a file tab should open a path when nobody asked for a specific view.
 * Unlike the explorer, this never shells out and never falls back to text: an
 * unrecognised file lands on the preview pane, which offers the default app and
 * a deliberate "open as text" for the cases where a text read is really wanted. */
export const defaultFileViewMode = (path: string): ExplorerOpenMode => {
  const kind = classifyExplorerFile(path)
  return kind === 'text' || kind === 'markdown' ? 'editor' : 'preview'
}

/** What a left click in the explorer opens. Markdown reads better than it
 * edits here, and an unknown type lands on the preview's description of it
 * rather than being launched by the shell from a single click. */
export const defaultExplorerOpenMode = (path: string): ExplorerOpenMode =>
  classifyExplorerFile(path) === 'text' ? 'editor' : 'preview'
