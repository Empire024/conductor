// Generates build/icon.icns (the macOS app icon) from build/icon.svg, the icon every platform uses.
// Run: `npx electron scripts/make-mac-icon.cjs`. Electron rasterizes the SVG in an offscreen,
// never-shown window, so nothing is drawn on anyone's screen and no image library is needed.
// The artwork is inset to Apple's 824 px grid on a 1024 px canvas (the SVG's rounded tile spans
// 936 px), and each size is stored as PNG under its icns type code.
'use strict'
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const SOURCE = join(ROOT, 'build', 'icon.svg')
const TARGET = join(ROOT, 'build', 'icon.icns')
const CANVAS = 1024
const TILE_IN_SVG = 936
const TILE_ON_MAC = 824

/** icns entry types holding PNG data, by pixel size (the @2x types share a size with the next one up). */
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['icp6', 64], ['ic12', 64], ['ic07', 128],
  ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024]
]

/** Packs PNG buffers into an icns file: 'icns' + total length, then type + length + data per entry. */
function packIcns(entries) {
  const chunks = entries.map(([type, png]) => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

module.exports = { ICNS_TYPES, packIcns }

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const drawn = Math.round(CANVAS * TILE_ON_MAC / TILE_IN_SVG)
    const offset = Math.round((CANVAS - drawn) / 2)
    const svg = readFileSync(SOURCE).toString('base64')
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
      <img id="icon" src="data:image/svg+xml;base64,${svg}" style="position:absolute;left:${offset}px;top:${offset}px;width:${drawn}px;height:${drawn}px"></body></html>`
    const window = new BrowserWindow({ show: false, width: CANVAS, height: CANVAS, transparent: true, frame: false, backgroundColor: '#00000000', useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } })
    await window.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
    await window.webContents.executeJavaScript('document.getElementById("icon").decode()')
    await new Promise(resolve => setTimeout(resolve, 300))
    const full = await window.webContents.capturePage({ x: 0, y: 0, width: CANVAS, height: CANVAS })
    if (full.getSize().width !== CANVAS) throw new Error(`Captured ${JSON.stringify(full.getSize())}, expected ${CANVAS} px`)
    const pngs = new Map()
    const png = size => {
      if (!pngs.has(size)) pngs.set(size, (size === CANVAS ? full : full.resize({ width: size, height: size, quality: 'best' })).toPNG())
      return pngs.get(size)
    }
    writeFileSync(TARGET, packIcns(ICNS_TYPES.map(([type, size]) => [type, png(size)])))
    console.log(`Wrote ${TARGET} (${ICNS_TYPES.length} entries)`)
    app.exit(0)
  }).catch(error => { console.error(error); app.exit(1) })
}
