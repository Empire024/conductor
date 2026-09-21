import { describe, expect, it } from 'vitest'
import { _internals, encodeQr, qrSvg, type QrErrorCorrection, type QrMatrix } from './qr-code'

/**
 * The encoder is written out in this repository, so it is tested the way a wire format is tested:
 * against the spec's own worked example, against the published capacity boundaries, and against a
 * second implementation. The second implementation is the decoder at the bottom of this file —
 * a reader that knows nothing about how the encoder placed anything and rebuilds the text from the
 * modules alone. Asserting the encoder against itself would pass on a symbol no phone can read.
 */

const SAMPLE_URL = 'https://192.168.0.205:51841/#pair=4H7K-QP2M'

/**
 * Every valid 15-bit format information string, indexed by (level bits << 3 | mask). Copied from
 * the spec's table 13 rather than computed, so a mistake in the encoder's BCH arithmetic cannot
 * agree with a matching mistake here.
 */
const FORMAT_STRINGS = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
  0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
  0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed
]

/** Table 12's two-bit level indicators, which are not in L, M, Q, H order. */
const LEVEL_BY_BITS: Record<number, QrErrorCorrection> = { 0: 'M', 1: 'L', 2: 'H', 3: 'Q' }

/** Alignment pattern centres, transcribed from the spec's annex E table rather than derived. */
const ALIGNMENT_CENTRES: readonly number[][] = [
  [], [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
]

const EC_PER_BLOCK: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
}

const BLOCK_COUNT: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
}

/** Table 10, written from the spec so a transposed mask in the encoder shows up as a failure. */
const MASK_CONDITIONS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (row, col) => (row + col) % 2 === 0,
  row => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
]

const dark = (matrix: QrMatrix, row: number, col: number): boolean => matrix.modules[row]![col]!

/** The 15 format bits from each of the two places they are written, most significant bit last. */
const readFormat = (matrix: QrMatrix): { top: number; split: number } => {
  const size = matrix.size
  const bit = (row: number, col: number, index: number): number => (dark(matrix, row, col) ? 1 : 0) << index

  let top = 0
  for (let index = 0; index <= 5; index++) top |= bit(index, 8, index)
  top |= bit(7, 8, 6)
  top |= bit(8, 8, 7)
  top |= bit(8, 7, 8)
  for (let index = 9; index < 15; index++) top |= bit(8, 14 - index, index)

  let split = 0
  for (let index = 0; index < 8; index++) split |= bit(8, size - 1 - index, index)
  for (let index = 8; index < 15; index++) split |= bit(size - 15 + index, 8, index)

  return { top, split }
}

/** Which modules carry no data, worked out from the spec's rules and not from the encoder's map. */
const functionModules = (version: number): boolean[][] => {
  const size = version * 4 + 17
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const mark = (row: number, col: number): void => {
    if (row >= 0 && col >= 0 && row < size && col < size) reserved[row]![col] = true
  }

  // Three finders with their separators, each occupying an 8x8 corner.
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      mark(row, col)
      mark(row, size - 1 - col)
      mark(size - 1 - row, col)
    }
  }
  for (let index = 0; index < size; index++) {
    mark(6, index)
    mark(index, 6)
  }
  // Both format information copies, including the module that is always dark.
  for (let index = 0; index < 9; index++) {
    mark(8, index)
    mark(index, 8)
  }
  for (let index = 0; index < 8; index++) {
    mark(8, size - 1 - index)
    mark(size - 1 - index, 8)
  }
  if (version >= 7) {
    for (let along = 0; along < 6; along++) {
      for (let across = 0; across < 3; across++) {
        mark(along, size - 11 + across)
        mark(size - 11 + across, along)
      }
    }
  }
  for (const row of ALIGNMENT_CENTRES[version]!) {
    for (const col of ALIGNMENT_CENTRES[version]!) {
      const onFinder = (row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)
      if (onFinder) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(row + dy, col + dx)
    }
  }
  return reserved
}

/**
 * Walk the data region the way a reader does: two-module columns from the right edge, alternating
 * up and down, stepping over the vertical timing column, unmasking as it goes.
 */
const readCodewords = (matrix: QrMatrix, mask: number): number[] => {
  const size = matrix.size
  const reserved = functionModules(matrix.version)
  const condition = MASK_CONDITIONS[mask]!
  const bits: number[] = []
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue
        const module = dark(matrix, row, col) !== condition(row, col)
        bits.push(module ? 1 : 0)
      }
    }
    upward = !upward
  }

  const codewords: number[] = []
  for (let start = 0; start + 8 <= bits.length; start += 8) {
    let byte = 0
    for (let offset = 0; offset < 8; offset++) byte = (byte << 1) | bits[start + offset]!
    codewords.push(byte)
  }
  return codewords
}

/** Undo the interleave and drop the error correction codewords, which this reader does not need. */
const deinterleave = (codewords: number[], version: number, level: QrErrorCorrection): number[] => {
  const ecPerBlock = EC_PER_BLOCK[level][version]!
  const blockCount = BLOCK_COUNT[level][version]!
  const total = codewords.length
  const shortBlocks = blockCount - (total % blockCount)
  const shortLength = Math.floor(total / blockCount) - ecPerBlock
  const lengths = Array.from({ length: blockCount }, (_unused, index) => shortLength + (index < shortBlocks ? 0 : 1))
  const blocks: number[][] = lengths.map(() => [])
  let index = 0
  for (let column = 0; column <= shortLength; column++) {
    for (let block = 0; block < blockCount; block++) {
      if (column < lengths[block]!) blocks[block]!.push(codewords[index++]!)
    }
  }
  return blocks.flat()
}

/** The full reader: format information, unmasking, de-interleaving, then one byte-mode segment. */
const decodeQr = (matrix: QrMatrix): { text: string; level: QrErrorCorrection; mask: number } => {
  const { top, split } = readFormat(matrix)
  expect(top).toBe(split)
  const index = FORMAT_STRINGS.indexOf(top)
  expect(index).toBeGreaterThanOrEqual(0)
  const level = LEVEL_BY_BITS[index >> 3]!
  const mask = index & 7

  const data = deinterleave(readCodewords(matrix, mask), matrix.version, level)
  const bits = data.flatMap(byte => [7, 6, 5, 4, 3, 2, 1, 0].map(shift => (byte >> shift) & 1))
  let cursor = 0
  const take = (count: number): number => {
    let value = 0
    for (let offset = 0; offset < count; offset++) value = (value << 1) | bits[cursor++]!
    return value
  }

  expect(take(4)).toBe(0b0100)
  const length = take(matrix.version < 10 ? 8 : 16)
  const bytes: number[] = []
  for (let byte = 0; byte < length; byte++) bytes.push(take(8))
  return { text: new TextDecoder().decode(Uint8Array.from(bytes)), level, mask }
}

/** Deterministic filler with a full cycle through the alphabet, so lengths are what they say. */
const filler = (length: number): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/:.#?&='
  let text = ''
  for (let index = 0; index < length; index++) text += alphabet[(index * 31 + 7) % alphabet.length]
  return text
}

describe('reed-solomon', () => {
  it('matches the annex I worked example for version 1-M', () => {
    // '01234567' in numeric mode, padded: the one example the standard itself prints in full.
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
    expect(_internals.reedSolomonRemainder(data, 10))
      .toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55])
  })

  it('matches the HELLO WORLD example for version 1-M', () => {
    // The same message every QR tutorial works through: alphanumeric mode, then the pad bytes.
    const data = [0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
    expect(_internals.reedSolomonRemainder(data, 10))
      .toEqual([0xc4, 0x23, 0x27, 0x77, 0xeb, 0xd7, 0xe7, 0xe2, 0x5d, 0x17])
  })

  it('produces one remainder codeword per requested error correction codeword', () => {
    for (const count of [7, 17, 22, 30]) {
      expect(_internals.reedSolomonRemainder([1, 2, 3, 4, 5], count)).toHaveLength(count)
    }
  })
})

describe('encodeQr structure', () => {
  const matrix = encodeQr(SAMPLE_URL)

  it('sizes the symbol from its version', () => {
    expect(matrix.size).toBe(17 + 4 * matrix.version)
    expect(matrix.modules).toHaveLength(matrix.size)
    for (const row of matrix.modules) expect(row).toHaveLength(matrix.size)
  })

  it('draws the three finder patterns', () => {
    const finder = [
      [1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1, 1, 1]
    ]
    const corners = [[0, 0], [0, matrix.size - 7], [matrix.size - 7, 0]]
    for (const [top, left] of corners) {
      const seen = finder.map((_row, row) => finder[row]!.map((_cell, col) => (dark(matrix, top! + row, left! + col) ? 1 : 0)))
      expect(seen).toEqual(finder)
    }
  })

  it('separates each finder from the data with a light band', () => {
    for (let index = 0; index < 8; index++) {
      expect(dark(matrix, 7, index)).toBe(false)
      expect(dark(matrix, index, 7)).toBe(false)
      expect(dark(matrix, 7, matrix.size - 1 - index)).toBe(false)
      expect(dark(matrix, matrix.size - 1 - index, 7)).toBe(false)
    }
  })

  it('alternates the timing patterns between the finders', () => {
    for (let index = 8; index < matrix.size - 8; index++) {
      expect(dark(matrix, 6, index)).toBe(index % 2 === 0)
      expect(dark(matrix, index, 6)).toBe(index % 2 === 0)
    }
  })

  it('sets the module that is always dark', () => {
    expect(dark(matrix, 4 * matrix.version + 9, 8)).toBe(true)
  })

  it('writes the same valid format information in both places', () => {
    const { top, split } = readFormat(matrix)
    expect(top).toBe(split)
    expect(FORMAT_STRINGS).toContain(top)
    const index = FORMAT_STRINGS.indexOf(top)
    expect(LEVEL_BY_BITS[index >> 3]).toBe('M')
    // The mask the format claims has to be the mask that was actually applied, which only a
    // successful decode can show.
    expect(decodeQr(matrix)).toEqual({ text: SAMPLE_URL, level: 'M', mask: index & 7 })
  })

  it('is deterministic', () => {
    expect(encodeQr(SAMPLE_URL).modules).toEqual(matrix.modules)
  })
})

describe('larger symbols', () => {
  /** Table D.1, so the BCH(18,6) arithmetic is checked against published values, not repeated. */
  const VERSION_INFORMATION: Record<number, number> = { 7: 0x07c94, 12: 0x0c762, 40: 0x28c69 }
  const samples: Array<{ version: number; matrix: QrMatrix }> = [
    { version: 7, matrix: encodeQr(filler(110), 'M') },
    { version: 12, matrix: encodeQr(filler(270), 'M') },
    { version: 40, matrix: encodeQr('a'.repeat(2953), 'L') }
  ]

  it('writes the version information in both corners', () => {
    for (const { version, matrix } of samples) {
      expect(matrix.version).toBe(version)
      let topRight = 0
      let bottomLeft = 0
      for (let index = 0; index < 18; index++) {
        const far = matrix.size - 11 + (index % 3)
        const near = Math.floor(index / 3)
        topRight |= (dark(matrix, near, far) ? 1 : 0) << index
        bottomLeft |= (dark(matrix, far, near) ? 1 : 0) << index
      }
      expect(topRight).toBe(VERSION_INFORMATION[version])
      expect(bottomLeft).toBe(VERSION_INFORMATION[version])
    }
  })

  it('draws every alignment pattern the table calls for', () => {
    for (const { version, matrix } of samples) {
      const centres = ALIGNMENT_CENTRES[version]!
      let drawn = 0
      for (const row of centres) {
        for (const col of centres) {
          const onFinder = (row === 6 && col === 6) || (row === 6 && col === matrix.size - 7) ||
            (row === matrix.size - 7 && col === 6)
          if (onFinder) continue
          drawn++
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              // Dark centre, light ring, dark ring: the pattern a reader uses to correct for skew.
              expect(dark(matrix, row + dy, col + dx)).toBe(Math.max(Math.abs(dy), Math.abs(dx)) !== 1)
            }
          }
        }
      }
      expect(drawn).toBe(centres.length * centres.length - 3)
    }
  })
})

describe('version selection', () => {
  it('fills version 1 at level M to its published 14 bytes', () => {
    expect(encodeQr('a'.repeat(14), 'M').version).toBe(1)
    expect(encodeQr('a'.repeat(15), 'M').version).toBe(2)
  })

  it('reaches version 40 at level L and refuses one byte more', () => {
    expect(encodeQr('a'.repeat(2953), 'L').version).toBe(40)
    expect(() => encodeQr('a'.repeat(2954), 'L')).toThrow('Text is too long for a QR code')
  })

  it('counts UTF-8 bytes rather than characters', () => {
    // Ten characters, but twenty bytes, so this cannot fit the 14-byte version 1.
    expect(encodeQr('ééééééééée', 'M').version).toBe(2)
  })

  it('grows with the error correction level', () => {
    const text = filler(40)
    const versions = (['L', 'M', 'Q', 'H'] as const).map(level => encodeQr(text, level).version)
    expect(versions).toEqual([...versions].sort((left, right) => left - right))
    expect(versions[0]!).toBeLessThan(versions[3]!)
  })
})

describe('qrSvg', () => {
  it('renders one path over a background at the default scale', () => {
    const svg = qrSvg(SAMPLE_URL)
    const size = encodeQr(SAMPLE_URL).size
    const extent = (size + 8) * 4
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.match(/<path/g)).toHaveLength(1)
    expect(svg).toContain(`viewBox="0 0 ${extent} ${extent}"`)
    expect(svg).toContain(`width="${extent}" height="${extent}"`)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="QR code"')
    expect(svg).toContain('fill="#000"')
    expect(svg).toContain('fill="#fff"')
    expect(qrSvg(SAMPLE_URL)).toBe(svg)
  })

  it('honours the module size and margin', () => {
    const size = encodeQr(SAMPLE_URL).size
    const svg = qrSvg(SAMPLE_URL, { moduleSize: 6, margin: 2 })
    const extent = (size + 4) * 6
    expect(svg).toContain(`viewBox="0 0 ${extent} ${extent}"`)
  })

  it('keeps nothing external and nothing that could break out of an attribute', () => {
    const svg = qrSvg(SAMPLE_URL, { dark: '"><script>alert(1)</script>', light: 'javascript:x' })
    expect(svg).toContain('fill="#000"')
    expect(svg).toContain('fill="#fff"')
    expect(svg).not.toContain('script')
    // The namespace is the only URL allowed anywhere in the output: nothing is fetched to render.
    expect(svg.match(/https?:/g)).toEqual(['http:'])
    expect(svg).not.toContain('href')
    expect(svg).not.toContain('url(')
  })

  it('passes through the colour forms a theme actually uses', () => {
    const svg = qrSvg(SAMPLE_URL, { dark: 'var(--fg-default)', light: 'rgba(255, 255, 255, 0.9)' })
    expect(svg).toContain('fill="var(--fg-default)"')
    expect(svg).toContain('fill="rgba(255, 255, 255, 0.9)"')
    expect(qrSvg(SAMPLE_URL, { dark: 'currentColor', light: 'transparent' })).toContain('fill="currentColor"')
  })
})

describe('round trip through an independent reader', () => {
  const cases: Array<{ name: string; text: string; version: number; level: QrErrorCorrection }> = [
    { name: 'the pairing URL', text: SAMPLE_URL, version: 4, level: 'M' },
    { name: 'a version 1 symbol', text: 'conductor', version: 1, level: 'M' },
    { name: 'a version 1 symbol at level H', text: 'AB-1234', version: 1, level: 'H' },
    { name: 'a version 4 symbol', text: filler(50), version: 4, level: 'M' },
    { name: 'a version 4 symbol at level H', text: filler(30), version: 4, level: 'H' },
    { name: 'a version 7 symbol, the first with version information', text: filler(110), version: 7, level: 'M' },
    { name: 'a version 7 symbol at level H', text: filler(62), version: 7, level: 'H' },
    { name: 'a version 12 symbol, with two block groups', text: filler(270), version: 12, level: 'M' },
    { name: 'a version 12 symbol at level H', text: filler(150), version: 12, level: 'H' }
  ]

  for (const { name, text, version, level } of cases) {
    it(`reads back ${name}`, () => {
      const matrix = encodeQr(text, level)
      expect(matrix.version).toBe(version)
      const read = decodeQr(matrix)
      expect(read.text).toBe(text)
      expect(read.level).toBe(level)
      expect(read.mask).toBeGreaterThanOrEqual(0)
      expect(read.mask).toBeLessThan(8)
    })
  }

  it('reads back text that is not ASCII', () => {
    const text = 'Pair phone — café ünïcode ✓'
    expect(decodeQr(encodeQr(text)).text).toBe(text)
  })

  it('reads back every error correction level of the same URL', () => {
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      expect(decodeQr(encodeQr(SAMPLE_URL, level))).toMatchObject({ text: SAMPLE_URL, level })
    }
  })
})
