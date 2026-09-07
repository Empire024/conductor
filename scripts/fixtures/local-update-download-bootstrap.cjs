// Manual download-only QA boundary. Never used by a packaged app.
const path = require('node:path'); const { app } = require('electron')
const base = process.env.CONDUCTOR_DOWNLOAD_QA_ROOT
if (!base) throw new Error('Isolated QA root required')
app.getVersion = () => '0.1.4' // Only installed-version metadata is simulated.
const adapter = require(path.resolve('node_modules/electron-updater/out/ElectronAppAdapter.js'))
Object.defineProperty(adapter.ElectronAppAdapter.prototype, 'baseCachePath', { get: () => path.join(base, 'cache') })
const module_ = require(path.resolve('node_modules/electron-updater/out/NsisUpdater.js'))
const Native = module_.NsisUpdater
global.__downloadQA = { instances: [], installAttempts: 0 }
module_.NsisUpdater = class DownloadOnlyUpdater extends Native {
  constructor(options) { super(options); this.updateConfigPath = path.join(base, 'app-update.yml'); this.setFeedURL(options); global.__downloadQA.instances.push(this) }
  addQuitHandler() { this.autoInstallOnAppQuit = false }
  install() { global.__downloadQA.installAttempts++; throw new Error('QA forbids installation') }
  quitAndInstall() { global.__downloadQA.installAttempts++; throw new Error('QA forbids installation') }
}
require(path.resolve('out/main/index.js'))
