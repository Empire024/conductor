/** A provider's entry in models.list, as far as choosing a stage model needs it. */
export interface CatalogEntry {
  provider: string
  available: boolean
  models: Array<{ id: string; label?: string; isDefault?: boolean; effort?: string[] }>
}

export interface ModelChoice { model?: string; effort?: string; note?: string }

/**
 * The tabs.open arguments for a run's planner or stage agent. The run opens them on the owner's
 * scope, where tabs.open would otherwise bring the tab to the front, so they ask for the background
 * open every agent-opened tab gets: a "new" mark, and the owner's active tab, caret and window stay
 * put. The owner still brings one into view by clicking it or its link on the idea.
 */
export function agentTabArgs(request: { provider: string; title: string }, choice: ModelChoice): Record<string, unknown> {
  return { provider: request.provider, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}), title: request.title, focus: false }
}

const simple = (value: string): string => value.toLowerCase().replace(/\[1m\]/g, '').replace(/^(claude|codex|openai)[-:/]/, '').replace(/[^a-z0-9]+/g, '')

/**
 * The model a stage agent opens on. A plan names models the way a planner writes them ("opus",
 * "claude-opus-5-5", "gpt-6-astra"); tabs.open takes only an id from models.list. Exact ids win,
 * then the closest id or label, then the provider's default, and the note says what changed.
 */
export function chooseModel(catalog: readonly CatalogEntry[], request: { provider: string; model: string; effort?: string }): ModelChoice {
  const entry = catalog.find(item => item.provider === request.provider && item.available)
  if (!entry) throw new Error(`${request.provider} is unavailable on this machine`)
  const wanted = simple(request.model)
  const model = entry.models.find(item => item.id === request.model)
    ?? (wanted ? entry.models.find(item => simple(item.id) === wanted) ?? entry.models.find(item => simple(item.id).includes(wanted) || wanted.includes(simple(item.id)) || simple(item.label ?? '').includes(wanted)) : undefined)
  const chosen = model ?? entry.models.find(item => item.isDefault) ?? entry.models[0]
  const notes: string[] = []
  if (!model) notes.push(`${request.provider} ${request.model} is not in models.list; using ${chosen ? chosen.id : 'the provider default'}`)
  else if (model.id !== request.model) notes.push(`${request.model} opened as ${model.id}`)
  const effort = request.effort && chosen?.effort?.includes(request.effort) ? request.effort : undefined
  if (request.effort && !effort) notes.push(`effort ${request.effort} is not offered for ${chosen?.id ?? 'that model'}; using its default`)
  return { ...(chosen ? { model: chosen.id } : {}), ...(effort ? { effort } : {}), ...(notes.length ? { note: notes.join('; ') } : {}) }
}
