const port = Number(process.argv[2] || 9341)
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
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.pane-tab')].find((item) => item.textContent.includes('package.json'))
    if (!tab) throw new Error('package.json editor tab is missing')
    tab.click()
  })()`)
  await delay(500)
  await evaluate(`(() => {
    const input = document.querySelector('.monaco-editor textarea.inputarea')
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
    recovered: Boolean(document.querySelector('.code-toolbar button.dirty'))
  })`)
  if (!prepared.recovered) throw new Error('Editor did not become dirty before crash')
  console.log(JSON.stringify({ mode, ...prepared }, null, 2))
} else {
  const restored = await evaluate(`(() => {
    const packageTab = [...document.querySelectorAll('.pane-tab')].find((item) => item.textContent.includes('package.json'))
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
  restored.draftBadge = await evaluate(`Boolean(document.querySelector('.code-recovered'))`)
  restored.editorText = await evaluate(`document.querySelector('.monaco-editor .view-lines')?.textContent ?? ''`)
  restored.markerVisible = restored.editorText.includes(marker)
  if (restored.project !== 'Smoke Managed') throw new Error(`Wrong restored project: ${restored.project}`)
  if (!restored.workspace?.includes('Renamed workspace')) throw new Error(`Wrong restored workspace: ${restored.workspace}`)
  if (restored.groups < 2) throw new Error(`Only ${restored.groups} pane group(s) were restored`)
  if (!restored.tabs.some((tab) => tab.includes('Codex')) || !restored.tabs.some((tab) => tab.includes('PowerShell'))) {
    throw new Error('Agent/terminal tabs were not restored')
  }
  console.log(JSON.stringify({ mode, ...restored }, null, 2))
  if (!restored.draftBadge) throw new Error('Unsaved editor draft was not restored')
}
socket.close()
