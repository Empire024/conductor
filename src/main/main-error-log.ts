import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Electron's own answer to an uncaught main-process exception is a modal "A JavaScript error
 * occurred in the main process" box, and on Windows that box blocks the main thread until someone
 * clicks OK: app control stops answering, the window stops painting, and an unattended Conductor
 * waits for an owner who may not be at the machine (2026-10-21). Any listener of our own replaces
 * that box, so the installed app records the error here and keeps running, exactly as it would
 * after the box was dismissed.
 */
export function installMainErrorLog(path: string, target: Pick<NodeJS.Process, 'on'> = process): void {
  const record = (kind: string, detail: string): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${new Date().toISOString()} [${kind}] ${detail}\n`)
    } catch { /* logging never blocks anything */ }
    // Nothing is written to stdout here: a closed pipe would raise another error into this handler.
  }
  target.on('uncaughtException', error => record('uncaughtException', error.stack ?? error.message))
  target.on('unhandledRejection', reason => record('unhandledRejection', reason instanceof Error ? reason.stack ?? reason.message : String(reason)))
}
