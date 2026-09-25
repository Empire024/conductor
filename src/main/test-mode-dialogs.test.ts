import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, showMessageBoxMock, showSaveDialogMock, showOpenDialogMock } = vi.hoisted(() => ({
  state: { isPackaged: false, userData: 'C:\\test-user-data' } as { isPackaged: boolean; userData: string },
  showMessageBoxMock: vi.fn(async () => ({ response: 9, checkboxChecked: false })),
  showSaveDialogMock: vi.fn(async () => ({ canceled: false, filePath: 'C:\\real.txt' })),
  showOpenDialogMock: vi.fn(async () => ({ canceled: false, filePaths: ['C:\\real.txt'] }))
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return state.isPackaged }, getPath: () => state.userData },
  dialog: { showMessageBox: showMessageBoxMock, showSaveDialog: showSaveDialogMock, showOpenDialog: showOpenDialogMock }
}))
vi.mock('node:fs', () => ({ appendFileSync: vi.fn() }))

import { guardingDialogs, showMessageBox, showOpenDialog, showSaveDialog } from './test-mode-dialogs'

const originalEnv = { ...process.env }
beforeEach(() => {
  state.isPackaged = false
  delete process.env.CONDUCTOR_TEST_USER_DATA
  delete process.env.CONDUCTOR_TEST_DIALOGS
  vi.clearAllMocks()
})
afterEach(() => { process.env = { ...originalEnv } })

describe('guardingDialogs', () => {
  it('is false with no test profile', () => {
    expect(guardingDialogs()).toBe(false)
  })

  it('is true in a test profile', () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    expect(guardingDialogs()).toBe(true)
  })

  it('is false when a smoke opts back into the real dialog', () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    process.env.CONDUCTOR_TEST_DIALOGS = '1'
    expect(guardingDialogs()).toBe(false)
  })

  it('is false once packaged, even with the env var set', () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    state.isPackaged = true
    expect(guardingDialogs()).toBe(false)
  })
})

describe('showMessageBox', () => {
  it('shows the real dialog outside test mode', async () => {
    const result = await showMessageBox(null, { message: 'hi', buttons: ['OK'] })
    expect(result.response).toBe(9)
    expect(showMessageBoxMock).toHaveBeenCalled()
  })

  it('answers headlessly with an explicit testResponse in test mode', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    const result = await showMessageBox(null, { message: 'Work is still running', buttons: ['Keep running', 'Stop', 'Cancel'], defaultId: 0, cancelId: 2 }, 1)
    expect(result).toEqual({ response: 1, checkboxChecked: false })
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('falls back to cancelId over defaultId when no testResponse is given', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    const result = await showMessageBox(null, { message: 'Save changes?', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2 })
    expect(result.response).toBe(2)
  })

  it('falls back to defaultId when there is no cancelId', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    const result = await showMessageBox(null, { message: 'OK?', buttons: ['OK'], defaultId: 0 })
    expect(result.response).toBe(0)
  })

  it('takes the real dialog again with CONDUCTOR_TEST_DIALOGS=1', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    process.env.CONDUCTOR_TEST_DIALOGS = '1'
    const result = await showMessageBox(null, { message: 'hi' })
    expect(result.response).toBe(9)
    expect(showMessageBoxMock).toHaveBeenCalled()
  })

  it('holds a self-closing dialog open with CONDUCTOR_TEST_DIALOGS=hold, never showing the real one', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    process.env.CONDUCTOR_TEST_DIALOGS = 'hold'
    const abort = new AbortController()
    let settled = false
    const pending = showMessageBox(null, { message: 'Work is still running', buttons: ['Stop', 'Cancel'], cancelId: 1, signal: abort.signal }, 0).then(result => { settled = true; return result })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    abort.abort()
    expect((await pending).response).toBe(1)
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('still answers a dialog without an abort signal at once under hold', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    process.env.CONDUCTOR_TEST_DIALOGS = 'hold'
    expect((await showMessageBox(null, { message: 'hi', cancelId: 2 })).response).toBe(2)
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })
})

describe('showSaveDialog / showOpenDialog', () => {
  it('showSaveDialog answers canceled in test mode', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    const result = await showSaveDialog(null, { title: 'Save' })
    expect(result).toEqual({ canceled: true, filePath: '' })
    expect(showSaveDialogMock).not.toHaveBeenCalled()
  })

  it('showOpenDialog answers canceled in test mode', async () => {
    process.env.CONDUCTOR_TEST_USER_DATA = 'C:\\profile'
    const result = await showOpenDialog(null, { title: 'Open' })
    expect(result).toEqual({ canceled: true, filePaths: [] })
    expect(showOpenDialogMock).not.toHaveBeenCalled()
  })

  it('showOpenDialog uses the real dialog outside test mode', async () => {
    const result = await showOpenDialog(null, { title: 'Open' })
    expect(result.canceled).toBe(false)
    expect(showOpenDialogMock).toHaveBeenCalled()
  })
})
