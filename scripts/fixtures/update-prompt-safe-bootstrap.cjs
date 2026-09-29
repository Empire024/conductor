// Parked smoke boundary: real discovery and manager, synthetic download, no installer.
const path = require('node:path')
const fs = require('node:fs')
if (!process.env.CONDUCTOR_TEST_USER_DATA) throw new Error('A disposable parked profile is required')
const updater = require(path.resolve('node_modules/electron-updater/out/NsisUpdater.js'))
const Native = updater.NsisUpdater
global.__safeUpdate = { installs: 0 }
updater.NsisUpdater = class extends Native {
  async downloadUpdate() { const info = JSON.parse(fs.readFileSync(path.join(process.env.CONDUCTOR_TEST_USER_DATA, 'local-updates', 'conductor-local-build.json'), 'utf8')); this.emit('update-downloaded', { version: info.version }); return [] }
  addQuitHandler() { this.autoInstallOnAppQuit = false }
  quitAndInstall() { global.__safeUpdate.installs++; throw new Error('Smoke forbids installing') }
}
require(path.resolve('out/main/index.js'))
