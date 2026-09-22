import { spawn } from 'node:child_process'

/**
 * The token the owner's own Git already uses for github.com, read through `git credential fill`
 * with every prompt switched off. Release polling uses it only to lift the 60-requests-an-hour
 * anonymous API limit, and only against api.github.com; without one, polling runs anonymously.
 */
export function gitHubCredential(cwd: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise(resolve => {
    let output = '', settled = false
    const finish = (token: string | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(token) } }
    const child = spawn('git', ['credential', 'fill'], {
      cwd, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' }
    })
    const timer = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 16_384) { child.kill(); finish(null) } })
    child.on('error', () => finish(null))
    child.on('close', code => finish(code === 0 ? /^password=(.+)$/m.exec(output)?.[1]?.trim() || null : null))
    child.stdin.end('protocol=https\nhost=github.com\n\n')
  })
}
