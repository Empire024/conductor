/** Proof fixture for feature-list.md's smoke-instances-never-leak, not a regression test on its
 *  own: launches a real parked Electron instance and then hangs forever, simulating the overnight
 *  smokes that never finished. Driven from outside (see docs/smoke-instances-never-leak-proof.md)
 *  by killing this script's smoke-lock wrapper and checking the app dies with it anyway. */
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.env.CONDUCTOR_LEAK_PROOF_ROOT ?? await mkdtemp(join(tmpdir(), 'conductor-leak-proof-'))
const userData = join(root, 'profile')
await mkdir(userData, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: userData, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
await page.waitForSelector('.pane-workspace, .empty-pane-workspace, .app-shell', { timeout: 20000 }).catch(() => {})
await writeFile(join(root, 'ready.txt'), userData)
console.log(`[leak-proof] ready, userData=${userData}`)

// Never resolves by itself: only an outside kill (or the app's own watchdog taking the app down)
// ends this run, the way a hung overnight smoke was found hours later.
await new Promise(() => {})
