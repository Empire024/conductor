// The launcher grid's runtime tiles, for smoke scripts.
//
// `.filter({ hasText: 'Claude' })` alone also matches the "Claude Cloud" toggle (aria-pressed) that
// sits in the same grid, and 'Claude Code' matches its "Claude Code in the cloud" detail line, so
// Playwright strict mode fails or the wrong button is clicked. A tile is matched here by its exact
// title, and the toggle buttons (Claude Cloud, a local tile's durable toggle) are excluded.

/** Short names and provider ids smokes use, mapped to the tile's title in LauncherPane.tsx. */
const TITLES = new Map([
  ['claude', 'Claude Code'],
  ['claude code', 'Claude Code'],
  ['codex', 'Codex'],
  ['grok', 'Grok'],
  ['qwen', 'Qwen Code'],
  ['qwen code', 'Qwen Code'],
  ['kimi', 'Kimi Code'],
  ['gemini', 'Gemini CLI']
])

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The tile title a smoke means by `name` ('claude', 'Claude', 'Codex', 'Qwen 3.5 9B', ...). */
export function launcherTileTitle(name) {
  return TITLES.get(String(name).trim().toLowerCase()) ?? String(name)
}

/**
 * The launcher tile for `name`. `grid` narrows which launcher grid to search: a selector
 * (default every `.launcher-grid`) or a Locator such as `page.locator('.launcher-grid').last()`.
 * `name` 'local' means every local-model tile; add `.first()` for one.
 */
export function launcherTile(page, name, { grid = '.launcher-grid' } = {}) {
  const buttons = typeof grid === 'string'
    ? page.locator(`${grid} button:not([aria-pressed])`)
    : grid.locator('button:not([aria-pressed])')
  if (String(name).trim().toLowerCase() === 'local') return buttons.filter({ hasText: 'Local model' })
  const title = new RegExp(`^\\s*${escapeRegExp(launcherTileTitle(name))}\\s*$`)
  return buttons.filter({ has: page.locator('strong', { hasText: title }) })
}
