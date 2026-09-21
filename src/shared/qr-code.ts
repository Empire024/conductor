/**
 * A QR encoder for the pairing URL the phone-access panel shows.
 *
 * Written out here rather than pulled from a package because both the main process and the
 * renderer want it, and all either one needs is a boolean matrix — the rest of what a QR package
 * ships (canvas, terminal, PNG writers, decoders) would be dead weight in an Electron bundle for
 * about the amount of code below. Byte mode only: a pairing URL carries a mixed-case host, a port
 * and a fragment, so the denser alphanumeric mode would not apply to it anyway.
 *
 * Nothing here touches Buffer, TextEncoder or the DOM, so the same module runs on both sides.
 *
 * Section numbers in the comments are ISO/IEC 18004, cited where a constant would otherwise look
 * arbitrary and a future reader would have no way to check it.
 */

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H'

export interface QrMatrix {
  version: number
  size: number
  /** modules[row][col], true = dark. Row 0 is the top, column 0 the left. */
  modules: boolean[][]
}

/**
 * Error correction codewords per block, and block count, indexed [level][version]. Index 0 is a
 * hole so a version reads directly as an index. These two tables are the whole of table 9 in the
 * spec; every other capacity in this file is derived from them, which is why they are worth
 * transcribing in full rather than computing partial cases.
 */
const EC_CODEWORDS_PER_BLOCK: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
}

const EC_BLOCKS: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
}

/** Two bits each, and deliberately not in L < M < Q < H order: this is the spec's table 12. */
const FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 }

const MIN_VERSION = 1
const MAX_VERSION = 40

/**
 * Modules a symbol has left for data once the finder, timing, alignment and version areas are
 * taken out (formula from annex D). Counting them beats another 40-row table, and it is the only
 * place the alignment pattern count feeds into capacity.
 */
const rawDataModules = (version: number): number => {
  let modules = (16 * version + 128) * version + 64
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2
    modules -= (25 * alignments - 10) * alignments - 55
    // Versions 7 and up spend two 6x3 blocks on the version information.
    if (version >= 7) modules -= 36
  }
  return modules
}

const totalCodewords = (version: number): number => Math.floor(rawDataModules(version) / 8)

const dataCodewordCount = (version: number, level: QrErrorCorrection): number =>
  totalCodewords(version) - EC_CODEWORDS_PER_BLOCK[level][version]! * EC_BLOCKS[level][version]!

/** Byte mode's character count field: 8 bits up to version 9, 16 bits above it (table 3). */
const charCountBits = (version: number): number => (version < 10 ? 8 : 16)

/** Mode indicator (4 bits) plus the count field, which is the fixed cost before any payload. */
const headerBits = (version: number): number => 4 + charCountBits(version)

/**
 * UTF-8 by hand. TextEncoder exists in both hosts, but it returns a Uint8Array over a typed array
 * whose availability the renderer bundle would have to assume, and this is a dozen lines.
 */
const utf8Bytes = (text: string): number[] => {
  const bytes: number[] = []
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return bytes
}

/** Multiplication in GF(2^8) modulo the QR field polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d). */
const gfMultiply = (a: number, b: number): number => {
  let product = 0
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((b >>> bit) & 1) * a
  }
  return product & 0xff
}

/**
 * The Reed-Solomon generator polynomial of the given degree, coefficients in descending order with
 * the implicit leading 1 left off. Built by multiplying out (x - a^0)(x - a^1)... rather than
 * stored, because there are 13 distinct degrees in use and the loop is shorter than the table.
 */
const reedSolomonDivisor = (degree: number): number[] => {
  const divisor = new Array<number>(degree).fill(0)
  divisor[degree - 1] = 1
  let root = 1
  for (let step = 0; step < degree; step++) {
    for (let index = 0; index < degree; index++) {
      divisor[index] = gfMultiply(divisor[index]!, root)
      if (index + 1 < degree) divisor[index] = divisor[index]! ^ divisor[index + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return divisor
}

/** The error correction codewords for one block: the remainder of the data divided by the above. */
const reedSolomonRemainder = (data: number[], ecCount: number): number[] => {
  const divisor = reedSolomonDivisor(ecCount)
  const remainder = new Array<number>(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!
    remainder.push(0)
    for (let index = 0; index < ecCount; index++) remainder[index] = remainder[index]! ^ gfMultiply(divisor[index]!, factor)
  }
  return remainder
}

/** Smallest version that still holds the payload at this level, or null when even 40 will not. */
const smallestVersion = (byteLength: number, level: QrErrorCorrection): number | null => {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteLength * 8 + headerBits(version) <= dataCodewordCount(version, level) * 8) return version
  }
  return null
}

/** Mode indicator, length, payload, terminator, then the spec's alternating pad bytes (8.4.9). */
const toDataCodewords = (bytes: number[], version: number, level: QrErrorCorrection): number[] => {
  const capacity = dataCodewordCount(version, level)
  const bits: number[] = []
  const push = (value: number, count: number): void => {
    for (let bit = count - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, charCountBits(version))
  for (const byte of bytes) push(byte, 8)
  // The terminator is up to four zero bits, and is simply dropped when the symbol is already full.
  push(0, Math.min(4, capacity * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords: number[] = []
  for (let start = 0; start < bits.length; start += 8) {
    let byte = 0
    for (let offset = 0; offset < 8; offset++) byte = (byte << 1) | bits[start + offset]!
    codewords.push(byte)
  }
  const firstPad = codewords.length
  while (codewords.length < capacity) codewords.push((codewords.length - firstPad) % 2 === 0 ? 0xec : 0x11)
  return codewords
}

/**
 * Split the data into blocks, give each block its own EC codewords, and interleave (8.6).
 *
 * Past version 5 the blocks come in two groups whose data lengths differ by one codeword. The
 * interleave takes one codeword from every block in turn and the short blocks simply drop out of
 * the last data round — get that wrong and the symbol still looks like a QR code while no reader
 * can make sense of it, which is why the round trip in the tests goes up to a two-group version.
 */
const interleave = (data: number[], version: number, level: QrErrorCorrection): number[] => {
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[level][version]!
  const blockCount = EC_BLOCKS[level][version]!
  const raw = totalCodewords(version)
  const shortBlocks = blockCount - (raw % blockCount)
  const shortDataLength = Math.floor(raw / blockCount) - ecPerBlock

  const blocks: Array<{ data: number[]; ec: number[] }> = []
  for (let index = 0, taken = 0; index < blockCount; index++) {
    const length = shortDataLength + (index < shortBlocks ? 0 : 1)
    const block = data.slice(taken, taken + length)
    taken += length
    blocks.push({ data: block, ec: reedSolomonRemainder(block, ecPerBlock) })
  }

  const result: number[] = []
  for (let column = 0; column <= shortDataLength; column++) {
    for (const block of blocks) if (column < block.data.length) result.push(block.data[column]!)
  }
  for (let column = 0; column < ecPerBlock; column++) {
    for (const block of blocks) result.push(block.ec[column]!)
  }
  return result
}

/**
 * Alignment pattern centres. The spec prints these as a table; the arithmetic below reproduces it
 * exactly, including version 32, which is the one version whose spacing does not come out of the
 * even-division rule and has to be named.
 */
const alignmentPositions = (version: number): number[] => {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (count * 2 - 2)) * 2
  const positions = [6]
  for (let position = size - 7; positions.length < count; position -= step) positions.splice(1, 0, position)
  return positions
}

/** The eight data mask conditions (table 10); true means the module is inverted. */
const MASKS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (row, col) => (row + col) % 2 === 0,
  row => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
]

const PENALTY_RUN = 3
const PENALTY_BLOCK = 3
const PENALTY_FINDER_LIKE = 40
const PENALTY_IMBALANCE = 10

interface Canvas {
  size: number
  modules: boolean[][]
  /** Function patterns and the reserved format/version areas, which no mask may touch. */
  reserved: boolean[][]
}

const createCanvas = (version: number): Canvas => {
  const size = version * 4 + 17
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }
}

const setFunction = (canvas: Canvas, row: number, col: number, dark: boolean): void => {
  if (row < 0 || col < 0 || row >= canvas.size || col >= canvas.size) return
  canvas.modules[row]![col] = dark
  canvas.reserved[row]![col] = true
}

/** A finder or alignment pattern is a set of concentric rings, so draw it by Chebyshev distance. */
const drawRings = (canvas: Canvas, row: number, col: number, radius: number, lightRings: number[]): void => {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setFunction(canvas, row + dy, col + dx, !lightRings.includes(distance))
    }
  }
}

const drawFunctionPatterns = (canvas: Canvas, version: number, level: QrErrorCorrection): void => {
  const size = canvas.size
  // Timing patterns run the full width and height; the finders overwrite their ends afterwards.
  for (let index = 0; index < size; index++) {
    setFunction(canvas, 6, index, index % 2 === 0)
    setFunction(canvas, index, 6, index % 2 === 0)
  }
  // Radius 4 covers the 7x7 finder plus its separator, which is why the separator needs no code.
  drawRings(canvas, 3, 3, 4, [2, 4])
  drawRings(canvas, 3, size - 4, 4, [2, 4])
  drawRings(canvas, size - 4, 3, 4, [2, 4])

  const positions = alignmentPositions(version)
  for (const row of positions) {
    for (const col of positions) {
      // The three corners belong to the finders, and the spec leaves them out rather than overlap.
      const corner = (row === positions[0] && col === positions[0]) ||
        (row === positions[0] && col === positions[positions.length - 1]) ||
        (row === positions[positions.length - 1] && col === positions[0])
      if (!corner) drawRings(canvas, row, col, 2, [1])
    }
  }

  // Drawn with mask 0 only to reserve the area; the real bits go down once a mask is chosen.
  drawFormatInfo(canvas, level, 0)
  if (version >= 7) drawVersionInfo(canvas, version)
}

/** Format information: 5 data bits, a BCH(15,5) remainder, XORed with 0x5412 so it is never blank. */
const formatInfoBits = (level: QrErrorCorrection, mask: number): number => {
  const data = (FORMAT_BITS[level] << 3) | mask
  let remainder = data
  for (let step = 0; step < 10; step++) remainder = (remainder << 1) ^ ((remainder >> 9) * 0x537)
  return ((data << 10) | remainder) ^ 0x5412
}

const drawFormatInfo = (canvas: Canvas, level: QrErrorCorrection, mask: number): void => {
  const bits = formatInfoBits(level, mask)
  const size = canvas.size
  const bit = (index: number): boolean => ((bits >> index) & 1) !== 0

  // Copy one, wrapped around the top-left finder, skipping the timing row and column.
  for (let index = 0; index <= 5; index++) setFunction(canvas, index, 8, bit(index))
  setFunction(canvas, 7, 8, bit(6))
  setFunction(canvas, 8, 8, bit(7))
  setFunction(canvas, 8, 7, bit(8))
  for (let index = 9; index < 15; index++) setFunction(canvas, 8, 14 - index, bit(index))

  // Copy two: the low bits run left from the top-right corner along row 8, the high bits run down
  // column 8 to the bottom-left corner, and the module just above them is always dark (8.9).
  for (let index = 0; index < 8; index++) setFunction(canvas, 8, size - 1 - index, bit(index))
  for (let index = 8; index < 15; index++) setFunction(canvas, size - 15 + index, 8, bit(index))
  setFunction(canvas, size - 8, 8, true)
}

/** Version information for versions 7 and up: 6 data bits and a BCH(18,6) remainder, twice. */
const drawVersionInfo = (canvas: Canvas, version: number): void => {
  let remainder = version
  for (let step = 0; step < 12; step++) remainder = (remainder << 1) ^ ((remainder >> 11) * 0x1f25)
  const bits = (version << 12) | remainder
  for (let index = 0; index < 18; index++) {
    const dark = ((bits >> index) & 1) !== 0
    const far = canvas.size - 11 + (index % 3)
    const near = Math.floor(index / 3)
    setFunction(canvas, near, far, dark)
    setFunction(canvas, far, near, dark)
  }
}

/**
 * Lay the codewords down in the two-module-wide zig-zag from the bottom right (8.7.3). Column 6
 * is the vertical timing pattern and is stepped over whole, otherwise the pairing would be off by
 * one for every column to its left.
 */
const drawCodewords = (canvas: Canvas, codewords: number[]): void => {
  const size = canvas.size
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vertical : vertical
        if (!canvas.reserved[row]![col] && index < codewords.length * 8) {
          canvas.modules[row]![col] = ((codewords[index >>> 3]! >>> (7 - (index & 7))) & 1) !== 0
          index++
        }
      }
    }
  }
}

/** XOR is its own inverse, so the same call both applies a mask and takes it back off again. */
const applyMask = (canvas: Canvas, mask: number): void => {
  const condition = MASKS[mask]!
  for (let row = 0; row < canvas.size; row++) {
    for (let col = 0; col < canvas.size; col++) {
      if (!canvas.reserved[row]![col] && condition(row, col)) canvas.modules[row]![col] = !canvas.modules[row]![col]
    }
  }
}

/**
 * A run history holds the last seven alternating run lengths so the 1:1:3:1:1 finder ratio can be
 * spotted as it goes past. The two fudges below — lengthening the first run and the last one by a
 * whole symbol width — stand in for the quiet zone, so a finder-like pattern hard against an edge
 * scores the same as one in the middle, which is what the spec intends.
 */
const addRunHistory = (length: number, history: number[], size: number): void => {
  const leading = history[0] === 0
  history.pop()
  history.unshift(leading ? length + size : length)
}

const countFinderLike = (history: number[]): number => {
  const unit = history[1]!
  const core = unit > 0 && history[2] === unit && history[3] === unit * 3 && history[4] === unit && history[5] === unit
  return (core && history[0]! >= unit * 4 && history[6]! >= unit ? 1 : 0) +
    (core && history[6]! >= unit * 4 && history[0]! >= unit ? 1 : 0)
}

const penaltyScore = (canvas: Canvas): number => {
  const { size, modules } = canvas
  let score = 0

  // Rules 1 and 3, once along the rows and once down the columns.
  for (const byRow of [true, false]) {
    for (let major = 0; major < size; major++) {
      let runColor = false
      let runLength = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let minor = 0; minor < size; minor++) {
        const dark = byRow ? modules[major]![minor]! : modules[minor]![major]!
        if (dark === runColor) {
          runLength++
          if (runLength === 5) score += PENALTY_RUN
          else if (runLength > 5) score += 1
        } else {
          // Every colour change closes a run, and a line that opens dark closes a light run of
          // length zero, which is what lets a finder-like pattern hard against the edge score.
          addRunHistory(runLength, history, size)
          if (!runColor) score += countFinderLike(history) * PENALTY_FINDER_LIKE
          runColor = dark
          runLength = 1
        }
      }
      if (runColor) {
        addRunHistory(runLength, history, size)
        runLength = 0
      }
      addRunHistory(runLength + size, history, size)
      score += countFinderLike(history) * PENALTY_FINDER_LIKE
    }
  }

  // Rule 2: every 2x2 block of one colour, counted once per top-left corner.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const dark = modules[row]![col]!
      if (dark === modules[row]![col + 1] && dark === modules[row + 1]![col] && dark === modules[row + 1]![col + 1]) {
        score += PENALTY_BLOCK
      }
    }
  }

  // Rule 4: ten points for every 5% the symbol strays from half dark.
  let darkModules = 0
  for (const row of modules) for (const module of row) if (module) darkModules++
  const total = size * size
  score += (Math.ceil(Math.abs(darkModules * 20 - total * 10) / total) - 1) * PENALTY_IMBALANCE
  return score
}

export function encodeQr(text: string, level: QrErrorCorrection = 'M'): QrMatrix {
  const bytes = utf8Bytes(text)
  const version = smallestVersion(bytes.length, level)
  if (version === null) throw new Error('Text is too long for a QR code')

  const canvas = createCanvas(version)
  drawFunctionPatterns(canvas, version, level)
  drawCodewords(canvas, interleave(toDataCodewords(bytes, version, level), version, level))

  // Every mask is tried and scored; nothing about the payload predicts which one reads best.
  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(canvas, mask)
    drawFormatInfo(canvas, level, mask)
    const score = penaltyScore(canvas)
    if (score < bestScore) {
      bestScore = score
      best = mask
    }
    applyMask(canvas, mask)
  }
  applyMask(canvas, best)
  drawFormatInfo(canvas, level, best)

  return { version, size: canvas.size, modules: canvas.modules }
}

/**
 * Colours reach this file from settings and themes, so they are checked against the handful of
 * forms a QR panel has any use for instead of being escaped. None of these can close an attribute
 * or open a tag, and anything else falls back to the default rather than being written through.
 */
const COLOR_FORMS: readonly RegExp[] = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^(?:rgb|rgba|hsl|hsla)\([0-9a-z%.,\s/+-]*\)$/i,
  /^var\(--[a-z0-9_-]+\)$/i,
  /^transparent$/i,
  /^currentcolor$/i
]

const safeColor = (value: string | undefined, fallback: string): string =>
  typeof value === 'string' && COLOR_FORMS.some(form => form.test(value.trim())) ? value.trim() : fallback

const wholeNumber = (value: number | undefined, fallback: number, minimum: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback

export interface QrSvgOptions {
  moduleSize?: number
  margin?: number
  dark?: string
  light?: string
  level?: QrErrorCorrection
}

/**
 * One self-contained `<svg>` string: a light background and a single path holding every dark
 * module. One path rather than an element per module because the renderer inlines this straight
 * into the settings panel, and even a version 4 symbol is a thousand modules. Horizontal runs
 * become one subpath each, which cuts the string down again.
 */
export function qrSvg(text: string, options: QrSvgOptions = {}): string {
  const matrix = encodeQr(text, options.level)
  const moduleSize = wholeNumber(options.moduleSize, 4, 1)
  const margin = wholeNumber(options.margin, 4, 0)
  const dark = safeColor(options.dark, '#000')
  const light = safeColor(options.light, '#fff')
  const extent = (matrix.size + margin * 2) * moduleSize

  const parts: string[] = []
  for (let row = 0; row < matrix.size; row++) {
    const line = matrix.modules[row]!
    for (let col = 0; col < matrix.size; col++) {
      if (!line[col]) continue
      let run = 1
      while (col + run < matrix.size && line[col + run]) run++
      const width = run * moduleSize
      parts.push(`M${(margin + col) * moduleSize} ${(margin + row) * moduleSize}h${width}v${moduleSize}h-${width}z`)
      col += run - 1
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" width="${extent}" height="${extent}" role="img" aria-label="QR code" shape-rendering="crispEdges">` +
    `<rect width="${extent}" height="${extent}" fill="${light}"/>` +
    `<path fill="${dark}" d="${parts.join('')}"/>` +
    '</svg>'
}

/** Exposed for the tests, which check the Reed-Solomon stage against the spec's worked example. */
export const _internals = { reedSolomonRemainder }
