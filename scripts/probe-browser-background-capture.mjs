// Probe: the project browser's background capture exactly as the installed app meets it.
//
// Every Playwright smoke drives Electron over the DevTools protocol, and that alone gives a hidden
// guest a compositor surface, so smoke-browser-watch-media cannot see the installed app's failure
// (videos wizard, 2026-10-20, on c597c04: "Current display surface not available for capture" for a
// browser only MCP had ever driven). This probe runs the real BrowserViews (src/main/browser-views.ts,
// bundled with esbuild) in a plain Electron process with no DevTools client: a project guest created
// by MCP access lives in its hidden parking host and was never painted in a shown window. It checks
// that a plain capturePage of that guest fails (the reproduction), then that browser_screenshot's
// view.screenshot() and view.videoFrames() succeed. No window is shown: the only host is the hidden,
// non-focusable parking window at -32000,-32000.
//
//   node scripts/probe-browser-background-capture.mjs          (exit 0 = reproduced and fixed)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'conductor-capture-probe-'))
const bundle = join(work, 'browser-views.cjs')
const built = spawnSync(process.execPath, [resolve('node_modules/esbuild/bin/esbuild'), resolve('src/main/browser-views.ts'), '--bundle', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${bundle}`], { encoding: 'utf8' })
if (built.status !== 0) { console.error(built.stderr); process.exit(2) }

const main = join(work, 'main.cjs')
writeFileSync(main, `
const { app } = require('electron')
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const { BrowserViews } = require(${JSON.stringify(bundle)})
const video = fs.readFileSync(${JSON.stringify(resolve('scripts/fixtures/browser-media/tiny.webm'))})
const project = ${JSON.stringify(join(work, 'project'))}
fs.mkdirSync(project, { recursive: true })
const result = {}
const done = code => { fs.writeFileSync(${JSON.stringify(join(work, 'result.json'))}, JSON.stringify(result, null, 2)); app.exit(code) }
setTimeout(() => { result.error = 'probe timed out'; done(3) }, 90000)
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/tiny.webm') { response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length, 'Accept-Ranges': 'bytes' }); response.end(video); return }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<body style="margin:0;background:#fff"><h1>Unprimed capture</h1><video id="clip" src="/tiny.webm" preload="auto" style="width:480px;height:270px"></video></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const views = new BrowserViews({ tabs: () => [], openBrowserTab: async () => {}, rendererPath: '', projectRoot: () => project })
  const scope = { projectId: 'probe-project', sessionId: 'probe-workspace', agentSessionId: 'probe-agent' }
  try {
    const view = await views.view(scope)
    await view.navigate('http://127.0.0.1:' + server.address().port + '/')
    const { webContents } = require('electron')
    const guest = webContents.getAllWebContents().find(contents => contents.getURL().includes('127.0.0.1'))
    try { const image = await guest.capturePage(); result.plainCapture = image.isEmpty() ? 'empty' : image.getSize().width + 'x' + image.getSize().height }
    catch (error) { result.plainCapture = 'refused: ' + error.message }
    result.debuggerAttachedBefore = guest.debugger.isAttached()
    const shot = await view.screenshot()
    result.screenshot = { width: shot.width, height: shot.height, base64: shot.data.length }
    result.debuggerAttachedAfter = guest.debugger.isAttached()
    const frames = await view.videoFrames({ selector: '#clip', fps: 1, maxFrames: 3, start: 0.5, end: 2.5, scale: 1, format: 'png', mode: 'auto', audio: false })
    result.frames = frames.frames.map(frame => {
      const image = require('electron').nativeImage.createFromPath(frame.path), size = image.getSize(), bitmap = image.toBitmap()
      const at = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4
      return { time: frame.time, width: size.width, height: size.height, r: bitmap[at + 2], g: bitmap[at + 1], b: bitmap[at] }
    })
    result.mode = frames.mode
    result.windows = require('electron').BrowserWindow.getAllWindows().map(window => ({ shown: window.isVisible(), focusable: window.isFocusable(), bounds: window.getBounds() }))
    views.dispose(); server.close(); done(0)
  } catch (error) { result.error = error.stack || String(error); done(1) }
})
`)
const electron = require('electron')
// Any value of ELECTRON_RUN_AS_NODE, even an empty one, would start Node instead of Electron.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const run = spawnSync(electron, [main], { encoding: 'utf8', timeout: 120_000, env })
let result
try { result = JSON.parse(readFileSync(join(work, 'result.json'), 'utf8')) } catch { console.error(run.stderr || run.stdout); process.exit(2) }
console.log(JSON.stringify(result, null, 2))
const colour = ({ r, g, b }) => r > 150 && g < 100 && b < 100 ? 'red' : g > 150 && r < 100 && b < 100 ? 'green' : b > 150 && r < 100 && g < 100 ? 'blue' : 'other'
const reproduced = typeof result.plainCapture === 'string' && !/^\d+x\d+$/.test(result.plainCapture)
const fixed = !result.error && result.screenshot?.base64 > 1000 && result.screenshot.width > 0
  && result.frames?.map(colour).join(',') === 'red,green,blue'
  && result.windows?.every(window => !window.shown && !window.focusable && window.bounds.x < -10_000)
  && result.debuggerAttachedAfter === false
console.log(`reproduced (plain capturePage fails): ${reproduced}; fixed (screenshot + red/green/blue frames, nothing shown): ${fixed}`)
process.exit(reproduced && fixed ? 0 : 1)
