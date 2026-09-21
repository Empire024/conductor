import { deflateSync } from 'node:zlib'

/**
 * The phone app's home-screen icon, drawn rather than shipped: iOS wants a PNG for the Home Screen
 * and the manifest wants two more sizes, and three raster assets to keep in the package are three
 * things that can go missing from a build. A rounded dark tile with the accent arc takes a few
 * hundred bytes of code and cannot.
 */

const BACKGROUND: [number, number, number] = [0x15, 0x1a, 0x20]
const ACCENT: [number, number, number] = [0xd6, 0xff, 0x73]

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

const cache = new Map<number, Buffer>()

/** An RGBA PNG of `size` pixels a side. Sizes are bounded because a page could ask for any. */
export function renderPhoneIcon(size: number): Buffer {
  const cached = cache.get(size)
  if (cached) return cached
  const rows: Buffer[] = []
  const center = size / 2
  const radius = size * 0.22
  const outer = size * 0.34, inner = size * 0.22
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5, py = y + 0.5
      // Rounded-square tile: inside when within the corner radius of the inset rectangle.
      const dx = Math.max(0, Math.abs(px - center) - (center - radius)), dy = Math.max(0, Math.abs(py - center) - (center - radius))
      const insideTile = dx * dx + dy * dy <= radius * radius
      let color: [number, number, number] | null = insideTile ? BACKGROUND : null
      if (insideTile) {
        const distance = Math.hypot(px - center, py - center)
        const angle = Math.atan2(py - center, px - center)
        // A "C": the ring minus a gap on its right, which is where a conductor's baton would point.
        if (distance >= inner && distance <= outer && Math.abs(angle) > Math.PI / 4) color = ACCENT
      }
      const offset = 1 + x * 4
      if (color) { row[offset] = color[0]; row[offset + 1] = color[1]; row[offset + 2] = color[2]; row[offset + 3] = 255 }
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
  cache.set(size, png)
  return png
}

export const PHONE_ICON_SIZES = [180, 192, 512] as const
