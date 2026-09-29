import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { workspacePath } from './agent-artifacts'
import { PASTED_TEXT_MAX_CHARS, PASTED_TEXT_PREFIX } from '../shared/pasted-text'

/**
 * A pasted-text chip opens as a file (feature-list 21b9a1d6): the text is written to
 * `.conductor/pasted-text/<attachment id>.txt`, which ignores itself in git as
 * `.conductor/prompt-images` does, and shown in the document strip's read-only preview. The
 * strip keeps the path across a reload, and a sent message's text is kept as a private output
 * artifact of its conversation (StructuredSessions.sentAttachments), so the file is written again
 * from that artifact whenever the chip is clicked.
 */
export const PASTED_TEXT_DIRECTORY = '.conductor/pasted-text'

/** The project-relative file a pasted-text attachment opens as. */
export function pastedTextFilePath(attachmentId: string): string {
  const id = attachmentId.startsWith(PASTED_TEXT_PREFIX) ? attachmentId.slice(PASTED_TEXT_PREFIX.length) : ''
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('That is not a pasted text attachment')
  return `${PASTED_TEXT_DIRECTORY}/${id}.txt`
}

/** Writes the pasted text to its file (again, if it is missing or differs) and returns the path. */
export async function materializePastedText(cwd: string, attachmentId: string, content: unknown): Promise<string> {
  if (typeof content !== 'string') throw new Error('The pasted text is no longer available')
  if (content.length > PASTED_TEXT_MAX_CHARS) throw new Error(`Pasted text holds up to ${PASTED_TEXT_MAX_CHARS.toLocaleString('en-US')} characters`)
  const path = pastedTextFilePath(attachmentId)
  // Validate each ancestor separately; never follow a user-created junction out of the project.
  for (const part of ['.conductor', PASTED_TEXT_DIRECTORY]) {
    const directory = await workspacePath(cwd, part, true)
    await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The pasted text folder is redirected')
  }
  await writeFile(await workspacePath(cwd, PASTED_TEXT_DIRECTORY + '/.gitignore', true), '*\n!.gitignore\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const target = await workspacePath(cwd, path, true)
  if (await readFile(target, 'utf8').catch(() => null) !== content) await writeFile(target, content)
  return path
}
