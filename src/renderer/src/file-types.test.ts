import { describe, expect, it } from 'vitest'
import {
  Coffee, Database, File, FileArchive, FileCode2, FileCog, FileJson, FileLock2,
  FileTerminal, FileText, Image, Palette, Settings2
} from 'lucide-react'
import { DEFAULT_FILE_STYLE, fileTypeColorClass, fileTypeIcon, fileTypeStyle } from './file-types'

describe('fileTypeStyle (VS Code-like file icon/color mapping)', () => {
  it('recognizes the required web and script languages by extension', () => {
    expect(fileTypeStyle('src/App.tsx').icon).toBe(FileCode2)
    expect(fileTypeStyle('src/App.tsx').hue).toBe('cyan')
    expect(fileTypeStyle('src/index.ts').hue).toBe('blue')
    expect(fileTypeStyle('scripts/build.mjs').icon).toBe(FileCode2)
    expect(fileTypeStyle('scripts/build.cjs').hue).toBe('yellow')
    expect(fileTypeStyle('main.js').hue).toBe('yellow')
    expect(fileTypeStyle('component.jsx').hue).toBe('yellow')
    expect(fileTypeStyle('setup.py').hue).toBe('yellow')
    expect(fileTypeStyle('server.go').hue).toBe('cyan')
    expect(fileTypeStyle('main.rs').hue).toBe('orange')
    expect(fileTypeStyle('Main.java').icon).toBe(Coffee)
    expect(fileTypeStyle('schema.sql').icon).toBe(Database)
  })
  it('recognizes data, style and markup extensions', () => {
    expect(fileTypeStyle('package.json').icon).toBe(FileJson)
    expect(fileTypeStyle('tsconfig.jsonc').icon).toBe(FileJson)
    expect(fileTypeStyle('theme.css').icon).toBe(Palette)
    expect(fileTypeStyle('theme.scss').hue).toBe('pink')
    expect(fileTypeStyle('index.html').hue).toBe('orange')
    expect(fileTypeStyle('README.md').icon).toBe(FileText)
    expect(fileTypeStyle('doc.mdx').hue).toBe('slate')
    expect(fileTypeStyle('pipeline.yml').icon).toBe(FileCog)
    expect(fileTypeStyle('pipeline.yaml').hue).toBe('red')
    expect(fileTypeStyle('Cargo.toml').icon).toBe(FileCog)
    expect(fileTypeStyle('diagram.svg').icon).toBe(Image)
    expect(fileTypeStyle('photo.PNG').icon).toBe(Image)
  })
  it('recognizes shell and PowerShell scripts distinctly', () => {
    expect(fileTypeStyle('deploy.sh').hue).toBe('green')
    expect(fileTypeStyle('deploy.bash').icon).toBe(FileTerminal)
    expect(fileTypeStyle('setup.ps1').hue).toBe('cyan')
    expect(fileTypeStyle('setup.sh').hue).not.toBe(fileTypeStyle('setup.ps1').hue)
  })
  it('treats known lock files as a distinct locked style, even with a recognized extension', () => {
    expect(fileTypeStyle('package-lock.json').icon).toBe(FileLock2)
    expect(fileTypeStyle('pnpm-lock.yaml').icon).toBe(FileLock2)
    expect(fileTypeStyle('Cargo.lock').icon).toBe(FileLock2)
    expect(fileTypeStyle('sub/package-lock.json').icon).toBe(FileLock2)
  })
  it('treats extension-less dotfiles as configuration, but colors a dotfile with a known extension by that extension', () => {
    expect(fileTypeStyle('.gitignore').icon).toBe(Settings2)
    expect(fileTypeStyle('.env').icon).toBe(Settings2)
    expect(fileTypeStyle('.editorconfig').icon).toBe(Settings2)
    expect(fileTypeStyle('.eslintrc.json').icon).toBe(FileJson)
  })
  it('groups archives together and falls back to a sensible default for anything else', () => {
    expect(fileTypeStyle('bundle.zip').icon).toBe(FileArchive)
    expect(fileTypeStyle('bundle.tar.gz').icon).toBe(FileArchive)
    expect(fileTypeStyle('archive.7z').icon).toBe(FileArchive)
    expect(fileTypeStyle('unknown.xyz')).toEqual(DEFAULT_FILE_STYLE)
    expect(fileTypeStyle('unknown.xyz').icon).toBe(File)
  })
  it('normalizes Windows path separators and mixed-case extensions', () => {
    expect(fileTypeStyle('C:\\work\\App.TSX').hue).toBe('cyan')
    expect(fileTypeStyle('src\\styles\\Theme.SCSS').hue).toBe('pink')
  })
  it('exposes a stable className per hue for the shared CSS module', () => {
    expect(fileTypeColorClass('main.ts')).toBe('file-type-blue')
    expect(fileTypeColorClass('main.js')).toBe('file-type-yellow')
    expect(fileTypeIcon('main.ts')).toBe(fileTypeStyle('main.ts').icon)
  })
})
