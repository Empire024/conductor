import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'

describe('the workspace database log across a restart (FX33)', () => {
  let directory: string
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('leaves the next launch an empty write-ahead log even while another store still has the file open', () => {
    directory = mkdtempSync(join(tmpdir(), 'conductor-wal-'))
    const path = join(directory, 'conductor.db')
    const database = new ConductorDatabase(path)
    // Another store's connection (orchestration, schedules, durable jobs) that is still open.
    const other = new DatabaseSync(path)
    other.prepare('SELECT count(*) FROM settings').get()
    const body = 'x'.repeat(4000)
    for (let index = 0; index < 3000; index++) database.setSetting(`fx33-ballast-${index}`, body)
    expect(statSync(path + '-wal').size).toBeGreaterThan(1024 * 1024)

    database.close()
    // Not the last connection, so SQLite would leave the log for the next launch to recover.
    expect(existsSync(path + '-wal') ? statSync(path + '-wal').size : 0).toBe(0)
    other.close()

    const next = new ConductorDatabase(path)
    expect(next.getSetting('fx33-ballast-2999')).toBe(body)
    next.close()
  })
})
