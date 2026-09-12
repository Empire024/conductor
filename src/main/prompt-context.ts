import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ContextAttachment } from '../shared/structured-agent'
import { workspacePath } from './agent-artifacts'
import { looksBinary } from './text-files'
import { importPromptImage } from './prompt-images'

const TEXT_CONTEXT_LIMIT = 128_000
const IMPORT_LIMIT = 100 * 1024 * 1024
const SNIFF_LIMIT = 8192
const nativeImageExtension = /\.(png|jpe?g|gif|webp)$/i
const knownMime: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.zip': 'application/zip'
}

const safeAttachmentName = (name: unknown): string => typeof name === 'string'
  ? name.replace(/[\\/\r\n\0]/g, '_').slice(0, 160) || 'Dropped file'
  : 'Dropped file'

const mimeFor = (name: string, reported?: unknown): string =>
  typeof reported === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(reported)
    ? reported.toLowerCase()
    : knownMime[extname(name).toLowerCase()] ?? 'application/octet-stream'

async function immutableDirectory(cwd: string): Promise<string> {
  for (const part of ['.conductor', '.conductor/prompt-files']) {
    const directory = await workspacePath(cwd, part, true)
    await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    // workspacePath returns the canonical target, so inspect the lexical entry separately: an
    // in-project symlink must not redirect the private import directory even if its target is in-bounds.
    const info = await lstat(resolve(cwd, part))
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The file attachment folder is redirected')
  }
  const ignore = await workspacePath(cwd, '.conductor/prompt-files/.gitignore', true)
  await writeFile(ignore, '*\n!.gitignore\n', { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  return workspacePath(cwd, '.conductor/prompt-files', true)
}

/** Classify a file already inside the project. Binary bytes are never decoded; the agent gets a
 * verified path and metadata so it can choose an appropriate tool itself. */
export async function projectPromptAttachment(cwd: string, requested: string): Promise<ContextAttachment> {
  const path = await workspacePath(cwd, requested)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Choose a regular project file')
  const name = relative(await workspacePath(cwd, '.'), path).replaceAll('\\', '/')
  if (nativeImageExtension.test(name)) return { id: randomUUID(), kind: 'image', name, path: name, size: stat.size, mimeType: mimeFor(name) }
  const descriptor = await open(path, 'r')
  try {
    const opened = await descriptor.stat()
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('The project file changed while it was being attached')
    let sample: Buffer
    sample = Buffer.alloc(Math.min(stat.size, SNIFF_LIMIT))
    if (sample.length) sample = sample.subarray(0, (await descriptor.read(sample, 0, sample.length, 0)).bytesRead)
    if (looksBinary(sample)) return { id: randomUUID(), kind: 'media', name, path: name, size: stat.size, mimeType: mimeFor(name) }
    if (stat.size > TEXT_CONTEXT_LIMIT) throw new Error(`${basename(name)} is too large to attach as text. Select a relevant range in the editor.`)
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat()
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.byteLength !== opened.size) throw new Error('The project file changed while it was being attached')
    return { id: randomUUID(), kind: 'file', name, path: name, content: bytes.toString('utf8'), size: stat.size, mimeType: 'text/plain' }
  } finally { await descriptor.close() }
}

/** Import bytes dropped from outside the project. Text stays in the draft; opaque media is copied
 * exactly once to an ignored immutable workspace path, with exclusive creation and no overwrite. */
export async function importPromptAttachment(cwd: string, nameValue: unknown, mimeType: unknown, input: unknown): Promise<ContextAttachment> {
  if (!(input instanceof Uint8Array)) throw new Error('Choose a file no larger than 100 MB')
  assertPromptImportSize(input.byteLength)
  const name = safeAttachmentName(nameValue)
  if (nativeImageExtension.test(name)) return importPromptImage(cwd, name, input)
  const bytes = Buffer.from(input)
  const mime = mimeFor(name, mimeType)
  if (!looksBinary(bytes.subarray(0, SNIFF_LIMIT))) {
    if (bytes.byteLength > TEXT_CONTEXT_LIMIT) throw new Error(`${name} is too large to attach as text. Select a relevant range in the editor.`)
    return { id: randomUUID(), kind: 'file', name, content: bytes.toString('utf8'), size: bytes.byteLength, mimeType: mime.startsWith('text/') ? mime : 'text/plain' }
  }
  const directory = await immutableDirectory(cwd)
  const id = randomUUID()
  const targetName = `${id}-${name}`
  const target = await workspacePath(directory, targetName, true)
  await writeFile(target, bytes, { flag: 'wx' })
  return { id, kind: 'media', name, path: `.conductor/prompt-files/${targetName}`, size: bytes.byteLength, mimeType: mime }
}

const within = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Resolve an OS File drop in main rather than trusting a renderer-supplied name or byte stream.
 * Project files remain direct context; external files are snapshotted into the draft/import area.
 * Symlinks and files that change identity while read are refused. */
export async function importPromptAttachmentPath(cwd: string, sourcePath: string, nameValue?: unknown, mimeType?: unknown): Promise<ContextAttachment> {
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || sourcePath.length > 32_768 || sourcePath.includes('\0')) throw new Error('The dropped file path is invalid')
  const lexical = resolve(sourcePath)
  const [root, source] = await Promise.all([workspacePath(cwd, '.'), realpath(lexical)])
  if ((process.platform === 'win32' ? lexical.toLocaleLowerCase() !== source.toLocaleLowerCase() : lexical !== source)) throw new Error('Symbolic-link file drops are not attached')
  if (within(root, source)) return projectPromptAttachment(cwd, relative(root, source))
  const descriptor = await open(source, 'r')
  try {
    const before = await descriptor.stat()
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file')
    assertPromptImportSize(before.size)
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== before.size) throw new Error('The dropped file changed while it was being attached')
    return importPromptAttachment(cwd, nameValue ?? basename(source), mimeType, bytes)
  } finally { await descriptor.close() }
}

export const promptContextLimits = { textBytes: TEXT_CONTEXT_LIMIT, importBytes: IMPORT_LIMIT }
export function assertPromptImportSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > IMPORT_LIMIT) throw new Error('Choose a file no larger than 100 MB')
}
