import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export async function readClaudeTaskOutput(path: string, taskId: string, sessionId?: string): Promise<{ output?: string; outputTruncated?: boolean; outputError?: string }> {
  try {
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(taskId) || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Task identity unavailable')
    const root = await realpath(resolve(tmpdir(), 'claude'))
    const file = await realpath(path), part = relative(root, file)
    if (isAbsolute(part) || part === '..' || part.startsWith('..' + sep) || basename(file) !== taskId + '.output' || !part.split(sep).join('/').endsWith('/' + sessionId + '/tasks/' + taskId + '.output')) throw new Error('Output path does not belong to this Claude task')
    const handle = await open(file, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('Task output is not a file')
      const length = Math.min(stat.size, 32000), bytes = Buffer.alloc(length)
      const result = await handle.read(bytes, 0, length, Math.max(0, stat.size - length))
      if (bytes.subarray(0, result.bytesRead).includes(0)) throw new Error('Task output is binary')
      return { output: bytes.subarray(0, result.bytesRead).toString('utf8'), outputTruncated: stat.size > length }
    } finally { await handle.close() }
  } catch (error) {
    return { outputError: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Task output file is no longer available.' : error instanceof Error ? error.message : 'Task output unavailable' }
  }
}
