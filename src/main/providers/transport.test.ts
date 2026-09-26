import { getPriority, setPriority, tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BACKGROUND_PRIORITY } from '../background-priority'
import type { Json } from '../../shared/structured-agent'
import { JsonLineTransport, setRuntimeHost } from './transport'

describe('provider transport', () => {
  it('starts an agent CLI below normal priority, so the tools it runs yield to the owner\'s window', async () => {
    setRuntimeHost(null)
    // A delivery's test run may itself be below normal: start from normal, so the CLI cannot
    // just have inherited it.
    const own = getPriority()
    try { setPriority(0) } catch { /* not allowed here: the check below still holds */ }
    try {
      const reported = await new Promise<Json>((resolve, reject) => {
        const transport = new JsonLineTransport({
          executable: process.execPath,
          args: ['-e', "setTimeout(() => process.stdout.write(JSON.stringify({ priority: require('node:os').getPriority() }) + '\\n'), 200); setTimeout(() => {}, 5000)"],
          cwd: tmpdir(),
          onMessage: message => { resolve(message); transport.close() },
          onError: reject
        })
        transport.start()
      })
      expect((reported as { priority: number }).priority).toBeGreaterThanOrEqual(BACKGROUND_PRIORITY)
    } finally { try { setPriority(own) } catch { /* left as it was */ } }
  })
})
