import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCAL_MODELS } from '../../../shared/local-models'
import { localModelGlyph } from '../components/ProviderIcon'
import { LauncherPane } from './LauncherPane'

describe('new-tab launcher local model tiles', () => {
  it('gives every local model tile its own icon rather than one shared chip (V4 U4)', () => {
    const html = renderToStaticMarkup(createElement(LauncherPane, { projectId: 'p1', onOpen: () => undefined }))
    const labels = LOCAL_MODELS.map(model => localModelGlyph(model.id).label)
    for (const label of labels) expect(html).toContain(`aria-label="${label}"`)
    expect(new Set(labels).size).toBe(LOCAL_MODELS.length)
    expect(html).not.toContain('aria-label="Local"')
  })
})
