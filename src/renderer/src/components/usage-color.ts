/** Colour of a usage graph at a given percent: blue for most of the range, red sharply near 100%. */
const BLUE: [number, number, number] = [0x4f, 0x8f, 0xef]
const RED: [number, number, number] = [0xe5, 0x39, 0x35]
/** Below this the graph is plain blue; the ramp then eases in (squared) so it is fully red only at 100%. */
export const USAGE_RAMP_START = 75

export function usageRedShare(percent: number): number {
  const t = Math.min(1, Math.max(0, (percent - USAGE_RAMP_START) / (100 - USAGE_RAMP_START)))
  return t * t
}

export function usageColor(percent: number): string {
  const red = usageRedShare(percent)
  const [r, g, b] = BLUE.map((channel, index) => Math.round(channel + ((RED[index] ?? channel) - channel) * red))
  return `rgb(${r}, ${g}, ${b})`
}

/** Gradient stops from the bottom (0%) to the top (100%) of a graph whose y axis is percent. */
export const USAGE_STOPS: readonly number[] = [0, 75, 82, 88, 94, 100]

/** The same ramp as a CSS gradient for a horizontal fill bar whose full track is 0-100%: sized so red appears only at the high end of the fill. */
export function usageBarBackground(fillPercent: number): { backgroundImage: string; backgroundSize: string } {
  const stops = USAGE_STOPS.map(percent => `${usageColor(percent)} ${percent}%`).join(', ')
  return { backgroundImage: `linear-gradient(to right, ${stops})`, backgroundSize: `${(10000 / Math.max(1, Math.min(100, fillPercent))).toFixed(1)}% 100%` }
}
