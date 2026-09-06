export type PerformanceHealth = 'smooth' | 'busy' | 'strained'
export type TabUiWeight = 'light' | 'medium' | 'heavy'

export const classifyPerformance = ({
  cpuPercent,
  fps,
  longTaskMs
}: {
  cpuPercent: number
  fps: number
  longTaskMs: number
}): PerformanceHealth => {
  if (cpuPercent >= 80 || fps < 42 || longTaskMs >= 180) return 'strained'
  if (cpuPercent >= 35 || fps < 54 || longTaskMs >= 60) return 'busy'
  return 'smooth'
}

export const classifyTabUiWeight = (domNodes: number): TabUiWeight => {
  if (domNodes >= 1_200) return 'heavy'
  if (domNodes >= 400) return 'medium'
  return 'light'
}

export const formatMemoryMb = (memoryMb: number): string =>
  memoryMb >= 1024 ? `${(memoryMb / 1024).toFixed(1)} GB` : `${Math.round(memoryMb)} MB`
