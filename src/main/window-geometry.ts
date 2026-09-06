export interface ScreenPoint {
  x: number
  y: number
}

export interface WindowBounds extends ScreenPoint {
  width: number
  height: number
}

export interface SavedWindowPlacement {
  bounds: WindowBounds
  maximized: boolean
}

export interface SavedWindowLayout {
  version: 1
  main?: SavedWindowPlacement
  detached: Record<string, SavedWindowPlacement>
}

export const isPointOutsideBounds = (point: ScreenPoint, bounds: WindowBounds): boolean =>
  point.x < bounds.x ||
  point.y < bounds.y ||
  point.x >= bounds.x + bounds.width ||
  point.y >= bounds.y + bounds.height

const isFiniteBounds = (value: unknown): value is WindowBounds => {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Partial<WindowBounds>
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    Number(bounds.width) >= 320 && Number(bounds.height) >= 240
}

const parsePlacement = (value: unknown): SavedWindowPlacement | null => {
  if (!value || typeof value !== 'object') return null
  const placement = value as Partial<SavedWindowPlacement>
  if (!isFiniteBounds(placement.bounds) || typeof placement.maximized !== 'boolean') return null
  return { bounds: placement.bounds, maximized: placement.maximized }
}

export const parseSavedWindowLayout = (serialized: string | null | undefined): SavedWindowLayout | null => {
  if (!serialized) return null
  try {
    const value = JSON.parse(serialized) as Partial<SavedWindowLayout>
    if (value.version !== 1 || !value.detached || typeof value.detached !== 'object') return null
    const detached: Record<string, SavedWindowPlacement> = {}
    for (const [id, candidate] of Object.entries(value.detached)) {
      const placement = parsePlacement(candidate)
      if (placement) detached[id] = placement
    }
    const main = parsePlacement(value.main)
    return { version: 1, ...(main ? { main } : {}), detached }
  } catch {
    return null
  }
}

export const isWindowPlacementVisible = (
  placement: SavedWindowPlacement,
  workAreas: WindowBounds[]
): boolean => workAreas.some((area) => {
  const overlapWidth = Math.min(placement.bounds.x + placement.bounds.width, area.x + area.width) -
    Math.max(placement.bounds.x, area.x)
  const overlapHeight = Math.min(placement.bounds.y + placement.bounds.height, area.y + area.height) -
    Math.max(placement.bounds.y, area.y)
  return overlapWidth >= 80 && overlapHeight >= 40
})
