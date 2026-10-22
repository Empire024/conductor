import { USAGE_STOPS, usageColor } from './usage-color'

/** Vertical gradient for a graph whose y axis is percent: blue at the bottom, red only near the top. */
export function UsageGradient({ id, bottom, top }: { id: string; bottom: number; top: number }): React.JSX.Element {
  return <defs>
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={bottom} y2={top}>
      {USAGE_STOPS.map(percent => <stop key={percent} offset={`${percent}%`} stopColor={usageColor(percent)} />)}
    </linearGradient>
  </defs>
}
