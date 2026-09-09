import type { LucideIcon } from 'lucide-react'
import './file-types.css'
import {
  Coffee,
  Database,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileJson,
  FileLock2,
  FileTerminal,
  FileText,
  Image,
  Palette,
  Settings2
} from 'lucide-react'

/** One VS Code Seti-ish hue per family of file type. Each hue has a dark- and light-theme
 *  value declared in file-types.css, tuned separately so the color reads clearly against
 *  both surfaces rather than assuming one contrast ratio works for both. */
export type FileTypeHue =
  | 'blue' | 'yellow' | 'gold' | 'orange' | 'red' | 'pink' | 'purple'
  | 'green' | 'teal' | 'cyan' | 'slate' | 'gray'

export interface FileTypeStyle {
  icon: LucideIcon
  hue: FileTypeHue
  /** Apply to the icon element, e.g. <Icon className={style.colorClass} />. */
  colorClass: string
}

const style = (icon: LucideIcon, hue: FileTypeHue): FileTypeStyle => ({ icon, hue, colorClass: `file-type-${hue}` })

// Extensions are grouped by rendered style, not one entry per extension, so a new
// language just joins an existing group instead of restating icon/color choices.
const EXTENSION_GROUPS: [FileTypeStyle, string[]][] = [
  [style(FileCode2, 'blue'), ['ts', 'c']],
  [style(FileCode2, 'cyan'), ['tsx', 'go']],
  [style(FileCode2, 'yellow'), ['js', 'jsx', 'mjs', 'cjs', 'py']],
  [style(FileJson, 'gold'), ['json', 'jsonc']],
  [style(Palette, 'blue'), ['css']],
  [style(Palette, 'pink'), ['scss', 'sass', 'less']],
  [style(FileCode2, 'orange'), ['html', 'htm', 'xml', 'rs']],
  [style(FileText, 'slate'), ['md', 'mdx', 'markdown']],
  [style(FileCog, 'red'), ['yml', 'yaml']],
  [style(FileCog, 'orange'), ['toml', 'ini', 'cfg', 'conf']],
  [style(FileTerminal, 'cyan'), ['ps1', 'psm1', 'psd1']],
  [style(FileTerminal, 'green'), ['sh', 'bash', 'zsh']],
  [style(FileCode2, 'red'), ['rb']],
  [style(FileCode2, 'teal'), ['cs']],
  [style(FileCode2, 'pink'), ['cpp', 'cc', 'cxx', 'hpp', 'hh']],
  [style(Coffee, 'teal'), ['java']],
  [style(Database, 'blue'), ['sql']],
  [style(Image, 'purple'), ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'apng']],
  [style(FileArchive, 'gray'), ['zip', '7z', 'tar', 'gz', 'rar', 'bz2']],
  [style(FileText, 'gray'), ['txt', 'log', 'csv']]
]

const EXTENSION_STYLES = new Map<string, FileTypeStyle>()
for (const [entryStyle, extensions] of EXTENSION_GROUPS) {
  for (const extension of extensions) EXTENSION_STYLES.set(extension, entryStyle)
}

const LOCK_STYLE = style(FileLock2, 'gray')
const LOCK_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'composer.lock', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'pdm.lock'
])

const DOTFILE_STYLE = style(Settings2, 'gray')
export const DEFAULT_FILE_STYLE = style(File, 'gray')

const baseName = (path: string): string => path.replaceAll('\\', '/').split('/').pop() || path

/** Maps any filename or path to the icon/color it should render with everywhere in the
 *  app — explorer, file tabs, the Ctrl+E picker, and agent file links. Keep this the single
 *  source of truth for that mapping rather than adding another per-surface lookup table. */
export function fileTypeStyle(path: string): FileTypeStyle {
  const name = baseName(path)
  const lower = name.toLowerCase()
  if (LOCK_NAMES.has(lower) || lower.endsWith('.lock')) return LOCK_STYLE
  const dot = name.lastIndexOf('.')
  const isDotfile = name.startsWith('.')
  if (dot <= 0) return isDotfile ? DOTFILE_STYLE : DEFAULT_FILE_STYLE
  const extension = lower.slice(dot + 1)
  const known = EXTENSION_STYLES.get(extension)
  if (known) return known
  return isDotfile ? DOTFILE_STYLE : DEFAULT_FILE_STYLE
}

export function fileTypeIcon(path: string): LucideIcon {
  return fileTypeStyle(path).icon
}

export function fileTypeColorClass(path: string): string {
  return fileTypeStyle(path).colorClass
}
