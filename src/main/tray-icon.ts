import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/**
 * The tray icon, drawn here rather than shipped as a file.
 *
 * The tray exists so that a machine hosting its other computer can keep running with no window,
 * and it needs a raster image - Electron's tray cannot show the SVG the app already ships. Shipping
 * a PNG would mean one more asset to keep inside the package on every platform; a 16x16 rounded
 * square in the app's accent takes fewer bytes to draw than to bundle, and cannot go missing.
 */

const SIZE = 16
const ACCENT: [number, number, number] = [0x6c, 0xa0, 0xf6]

let crcTable: Uint32Array | null = null
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A PNG of the icon: RGBA, one filter byte per row, no interlace. */
export function trayIconPng(): Buffer {
  const rows: Buffer[] = []
  const radius = 4
  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4)
    for (let x = 0; x < SIZE; x += 1) {
      // Inside the rounded square when within the box and, at the corners, within the corner circle.
      const cx = x < radius ? radius - 0.5 : x >= SIZE - radius ? SIZE - radius - 0.5 : x
      const cy = y < radius ? radius - 0.5 : y >= SIZE - radius ? SIZE - radius - 0.5 : y
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
      const offset = 1 + x * 4
      row[offset] = ACCENT[0]; row[offset + 1] = ACCENT[1]; row[offset + 2] = ACCENT[2]
      row[offset + 3] = inside ? 0xff : 0x00
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8   // bit depth
  header[9] = 6   // colour type: RGBA
  header[10] = 0; header[11] = 0; header[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Writes the icon where the tray can load it from, once per install, and returns that path. */
export function ensureTrayIconFile(directory: string): string {
  const path = join(directory, 'tray-icon.png')
  if (!existsSync(path)) writeFileSync(path, trayIconPng())
  return path
}
