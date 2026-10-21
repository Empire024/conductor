import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installMainErrorLog } from './main-error-log'

describe('main-process error log', () => {
  it('records uncaught exceptions and rejections instead of leaving them to a modal box', () => {
    const directory = mkdtempSync(join(tmpdir(), 'main-error-log-'))
    try {
      const target = new EventEmitter()
      const path = join(directory, 'nested', 'main-errors.log')
      installMainErrorLog(path, target as unknown as NodeJS.Process)
      // A listener of our own is what keeps Electron's blocking error box away.
      expect(target.listenerCount('uncaughtException')).toBe(1)
      target.emit('uncaughtException', new Error('prune failed'))
      target.emit('unhandledRejection', 'socket closed')
      const log = readFileSync(path, 'utf8')
      expect(log).toMatch(/\[uncaughtException\] Error: prune failed/)
      expect(log).toMatch(/\[unhandledRejection\] socket closed/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
