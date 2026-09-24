import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.argv[2] || 9341)
const preparedFile = join(tmpdir(), `conductor-smoke-recovery-${port}.json`)
const mode = process.argv[3] || 'verify'
const marker = '// conductor crash recovery draft'
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

let targets
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    if (targets?.length) break
  } catch {
    await delay(250)
  }
}
const target = targets?.find((item) => item.type === 'page' && item.title === 'Conductor' && !item.url.includes('detached='))
if (!target) throw new Error('Conductor renderer was not available')
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
})
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = ++sequence
  pending.set(id, { resolve: resolveCall, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
await call('Runtime.enable')
await call('Page.enable')
await delay(1000)

if (mode === 'prepare') {
  const beforePrepare = await evaluate(`({ sessions: document.querySelectorAll('.session-tab').length, active: Boolean(document.querySelector('.session-tab.active')), text: document.querySelector('.session-tabs')?.innerText })`)
  console.log(JSON.stringify({ beforePrepare }))
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113, nativeVirtualKeyCode: 113 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113, nativeVirtualKeyCode: 113 })
  await delay(100)
  await evaluate(`(() => {
    const input = document.querySelector('.session-tab.active .session-tab-rename')
    if (!input) throw new Error('Workspace rename input was not available')
    input.focus()
    input.select()
  })()`)
  await call('Input.insertText', { text: 'Renamed workspace' })
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await delay(250)
  // Project files open in the workspace document beside the panes, not as pane tabs.
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.workspace-document .file-tab [role="tab"]')].find((item) => item.textContent.includes('package.json'))
    if (!tab) throw new Error('package.json file tab is missing')
    tab.click()
  })()`)
  await delay(500)
  await evaluate(`(() => {
    const input = document.querySelector('.workspace-document .file-tab-content:not([hidden]) .monaco-editor textarea.inputarea')
    if (!input) throw new Error('Monaco input was not available')
    input.focus()
  })()`)
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 })
  await call('Input.insertText', { text: `\n${marker}` })
  await delay(500)
  const prepared = await evaluate(`({
    project: document.querySelector('.project-row.active .ellipsis')?.textContent,
    workspace: document.querySelector('.session-tab.active')?.textContent,
    groups: document.querySelectorAll('.pane-group').length,
    recovered: Boolean(document.querySelector('.workspace-document .file-tab-content:not([hidden]) .code-toolbar button.dirty'))
  })`)
  if (!prepared.recovered) throw new Error('Editor did not become dirty before crash')
  if (!prepared.project) throw new Error('No active project before crash')
  // verify runs in a fresh process after the hard kill; it compares against what was prepared here.
  await writeFile(preparedFile, JSON.stringify(prepared))
  console.log(JSON.stringify({ mode, ...prepared }, null, 2))
} else {
  const prepared = JSON.parse(await readFile(preparedFile, 'utf8'))
  const restored = await evaluate(`(() => {
    const packageTab = [...document.querySelectorAll('.workspace-document .file-tab [role="tab"]')].find((item) => item.textContent.includes('package.json'))
    packageTab?.click()
    return {
      project: document.querySelector('.project-row.active .ellipsis')?.textContent,
      workspace: document.querySelector('.session-tab.active')?.textContent,
      groups: document.querySelectorAll('.pane-group').length,
      tabs: [...document.querySelectorAll('.pane-tab')].map((item) => item.textContent.trim()),
      activeTab: document.querySelector('.pane-tab.active')?.textContent.trim()
    }
  })()`)
  await delay(750)
  restored.draftBadge = await evaluate(`Boolean(document.querySelector('.workspace-document .file-tab-content:not([hidden]) .code-recovered'))`)
  restored.editorText = await evaluate(`document.querySelector('.workspace-document .file-tab-content:not([hidden]) .monaco-editor .view-lines')?.textContent ?? ''`)
  // Monaco renders spaces as non-breaking spaces in .view-lines.
  restored.markerVisible = restored.editorText.replace(/ /g, ' ').includes(marker)
  // The seed (smoke-ui --preserve) names the project 'Smoke Managed' only under a managed projects
  // root; under the harness's own root it is 'Workspace smoke'. Either way it must be the one prepared.
  if (restored.project !== prepared.project) throw new Error(`Wrong restored project: ${restored.project}, prepared ${prepared.project}`)
  if (!restored.workspace?.includes('Renamed workspace')) throw new Error(`Wrong restored workspace: ${restored.workspace}`)
  if (restored.groups < 2) throw new Error(`Only ${restored.groups} pane group(s) were restored`)
  if (!restored.tabs.some((tab) => tab.includes('Codex')) || !restored.tabs.some((tab) => tab.includes('PowerShell'))) {
    throw new Error('Agent/terminal tabs were not restored')
  }
  console.log(JSON.stringify({ mode, ...restored }, null, 2))
  if (!restored.draftBadge) throw new Error('Unsaved editor draft was not restored')
  if (!restored.markerVisible) throw new Error('The restored draft does not contain the text typed before the crash')
}
socket.close()
