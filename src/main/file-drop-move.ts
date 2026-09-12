import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const COPY_CHUNK_BYTES = 1024 * 1024

class CrossVolumeMoveError extends Error {}

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
  : left === right
const sameIdentity = (left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean => left.dev === right.dev && left.ino === right.ino
const sameSourceVersion = (left: Stats, right: Stats): boolean => sameIdentity(left, right)
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs

async function unlinkOwned(path: string, expected: Pick<Stats, 'dev' | 'ino'>): Promise<boolean> {
  let current: Stats
  try { current = await lstat(path) }
  catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, expected)) return false
  await unlink(path)
  return true
}

async function hashHandle(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const digest = createHash('sha256')
  let position = 0
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, size - position))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead <= 0) throw new Error('The dropped file ended before its expected size')
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest('hex')
}

async function copyHandle(source: Awaited<ReturnType<typeof open>>, target: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const digest = createHash('sha256')
  let position = 0
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, size - position))
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
    if (bytesRead <= 0) throw new Error('The dropped file ended before its expected size')
    digest.update(buffer.subarray(0, bytesRead))
    let written = 0
    while (written < bytesRead) {
      const result = await target.write(buffer, written, bytesRead - written, position + written)
      if (result.bytesWritten <= 0) throw new Error('The staged move stopped before all bytes were written')
      written += result.bytesWritten
    }
    position += bytesRead
  }
  return digest.digest('hex')
}

async function stagedCrossVolumeMove(source: string, target: string, sourceBefore: Stats): Promise<void> {
  const stage = join(dirname(target), `.conductor-move-${randomUUID()}.tmp`)
  let stageIdentity: Stats | undefined
  let targetPublished = false
  const sourceHandle = await open(source, 'r')
  let stageHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const openedSource = await sourceHandle.stat()
    if (!openedSource.isFile() || !sameSourceVersion(openedSource, sourceBefore)) {
      throw new Error('The dropped file changed before it could be copied; the original was retained')
    }
    stageHandle = await open(stage, 'wx+', sourceBefore.mode & 0o777)
    stageIdentity = await stageHandle.stat()
    const copiedHash = await copyHandle(sourceHandle, stageHandle, sourceBefore.size)
    await stageHandle.sync()
    const [sourceAfterCopy, stageAfterCopy, sourceHash, stagedHash] = await Promise.all([
      sourceHandle.stat(),
      stageHandle.stat(),
      hashHandle(sourceHandle, sourceBefore.size),
      hashHandle(stageHandle, sourceBefore.size)
    ])
    if (!sameSourceVersion(sourceAfterCopy, sourceBefore)
      || !sameIdentity(stageAfterCopy, stageIdentity)
      || stageAfterCopy.size !== sourceBefore.size
      || copiedHash !== sourceHash
      || copiedHash !== stagedHash) {
      throw new Error('The dropped file changed or its staged copy could not be verified; the original was retained')
    }
    await stageHandle.close()
    stageHandle = undefined
    try { await link(stage, target) }
    catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`An item named ${basename(source)} already exists`)
      throw reason
    }
    targetPublished = true
    const [sourceAtPublish, targetAtPublish] = await Promise.all([lstat(source), lstat(target)])
    if (!sameSourceVersion(sourceAtPublish, sourceBefore)
      || !targetAtPublish.isFile()
      || targetAtPublish.isSymbolicLink()
      || !sameIdentity(targetAtPublish, stageIdentity)
      || targetAtPublish.size !== sourceBefore.size) {
      throw new Error('The source or destination changed while the move was being published; the original was retained')
    }
    await unlinkOwned(stage, stageIdentity)
    const targetBeforeDelete = await lstat(target)
    const sourceBeforeDelete = await lstat(source)
    if (!sameSourceVersion(sourceBeforeDelete, sourceBefore)
      || !targetBeforeDelete.isFile()
      || targetBeforeDelete.isSymbolicLink()
      || !sameIdentity(targetBeforeDelete, stageIdentity)) {
      throw new Error('The source or destination changed before the move completed; the original was retained')
    }
    await unlink(source)
  } catch (reason) {
    if (stageHandle) {
      try { await stageHandle.close() } catch { /* cleanup below still validates ownership */ }
      stageHandle = undefined
    }
    let rollbackFailed = false
    if (targetPublished && stageIdentity) {
      try { await unlinkOwned(target, stageIdentity) }
      catch { rollbackFailed = true }
    }
    if (stageIdentity) {
      try { await unlinkOwned(stage, stageIdentity) }
      catch { rollbackFailed = true }
    }
    if (rollbackFailed) throw new Error('The staged move failed and rollback of an operation-owned file also failed. The original source was retained.')
    throw reason
  } finally {
    try { await sourceHandle.close() } catch { /* the move result is already determined */ }
  }
}

async function linkThenUnlink(source: string, target: string, sourceBefore: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const name = basename(source)
  try { await link(source, target) }
  catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(`An item named ${name} already exists`)
    if (code === 'EXDEV') throw new CrossVolumeMoveError()
    throw reason
  }
  try {
    const [sourceAfter, targetAfter] = await Promise.all([lstat(source), lstat(target)])
    if (!sourceAfter.isFile() || sourceAfter.isSymbolicLink() || !targetAfter.isFile() || targetAfter.isSymbolicLink() || sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino || targetAfter.dev !== sourceBefore.dev || targetAfter.ino !== sourceBefore.ino) {
      throw new Error('The dropped file changed while it was being moved; the original was retained')
    }
    await unlink(source)
  } catch (reason) {
    // A concurrent writer may have replaced the destination after link(). Never unlink by path
    // alone: only remove it when it still names the exact source inode this operation linked.
    let current: Awaited<ReturnType<typeof lstat>> | undefined
    try { current = await lstat(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The move failed and destination ownership could not be verified. The original file was retained.')
    }
    if (current && current.isFile() && !current.isSymbolicLink() && current.dev === sourceBefore.dev && current.ino === sourceBefore.ino) {
      try { await unlink(target) }
      catch { throw new Error('The source could not be removed and rollback of its verified destination link also failed. Both paths may still reference the same intact file.') }
    }
    throw reason
  }
}

/** Moves one OS-dropped regular file into an existing project directory without overwriting. A
 * same-volume move uses a collision-atomic hard link. A cross-volume move uses an exclusive staged
 * copy, verifies both endpoints byte-for-byte, atomically publishes the destination, and only then
 * removes the still-identical source. Any incomplete or conflicting transaction retains source. */
export async function moveExternalDropIntoProject(projectRoot: string, sourcePath: string, requestedDirectory: string): Promise<{ path: string; name: string }> {
  if (!isAbsolute(sourcePath) || !sourcePath.trim()) throw new Error('External drops require one absolute source path')
  const lexicalSource = resolve(sourcePath)
  const [realRoot, realSource] = await Promise.all([realpath(projectRoot), realpath(lexicalSource)])
  if (!samePath(lexicalSource, realSource)) throw new Error('Symbolic-link file drops are not moved')
  if (inside(realRoot, realSource)) throw new Error('Use the project file drag action for files already inside this project')
  const sourceBefore = await lstat(realSource)
  if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) throw new Error('Only regular files can be dropped into the project')

  const lexicalDestination = resolve(projectRoot, requestedDirectory)
  if (!inside(resolve(projectRoot), lexicalDestination)) throw new Error('Destination is outside the project')
  const realDestination = await realpath(lexicalDestination)
  if (!inside(realRoot, realDestination) || !(await lstat(realDestination)).isDirectory()) throw new Error('Choose an existing project folder')
  const name = basename(realSource)
  const target = join(realDestination, name)
  if (samePath(realSource, target)) return { path: target, name }

  try { await linkThenUnlink(realSource, target, sourceBefore) }
  catch (reason) {
    if (!(reason instanceof CrossVolumeMoveError)) throw reason
    await stagedCrossVolumeMove(realSource, target, sourceBefore)
  }
  return { path: target, name }
}

/** Collision-safe move for a regular file dragged from one Explorer location to another. The
 * lexical route and its canonical target must both stay in the same project; intermediate
 * symlinks cannot redirect the operation. */
export async function moveProjectDropWithinProject(projectRoot: string, requestedSource: string, requestedDirectory: string): Promise<{ path: string; name: string }> {
  const lexicalRoot = resolve(projectRoot)
  const lexicalSource = resolve(lexicalRoot, requestedSource)
  const lexicalDestination = resolve(lexicalRoot, requestedDirectory)
  if (!inside(lexicalRoot, lexicalSource) || !inside(lexicalRoot, lexicalDestination)) throw new Error('Source and destination must stay inside the project')
  const [realRoot, realSource, realDestination] = await Promise.all([realpath(lexicalRoot), realpath(lexicalSource), realpath(lexicalDestination)])
  const expectedSource = resolve(realRoot, relative(lexicalRoot, lexicalSource))
  const expectedDestination = resolve(realRoot, relative(lexicalRoot, lexicalDestination))
  if (!samePath(realSource, expectedSource) || !samePath(realDestination, expectedDestination)) throw new Error('Symbolic-link file moves are not allowed')
  if (!inside(realRoot, realSource) || !inside(realRoot, realDestination)) throw new Error('Source and destination must stay inside the project')
  const [sourceBefore, destinationBefore] = await Promise.all([lstat(realSource), lstat(realDestination)])
  if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) throw new Error('Only regular files use the file-drop move')
  if (!destinationBefore.isDirectory() || destinationBefore.isSymbolicLink()) throw new Error('Choose an existing project folder')
  const name = basename(realSource)
  const target = join(realDestination, name)
  if (samePath(realSource, target)) return { path: target, name }
  await linkThenUnlink(realSource, target, sourceBefore)
  return { path: target, name }
}
