import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRecord } from '../../../shared/models'
import type { ProjectTask, ProjectTaskActivity } from '../../../shared/project-backlog'
import type { ContextAttachment } from '../../../shared/structured-agent'
import { embedTaskImages, ProjectBacklogPane, sortProjectTasks, splitTaskImages, submitTaskShortcut, taskTitleRow } from './ProjectBacklogPane'

// A minimal, real Storage-shaped implementation: the component reads/writes the
// bare `localStorage` global directly (not `window.localStorage`), so a Node
// test environment needs it stubbed before the module's initial render.
class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null }
  setItem(key: string, value: string): void { this.store.set(key, value) }
  removeItem(key: string): void { this.store.delete(key) }
  clear(): void { this.store.clear() }
}

const project: ProjectRecord = { id: 'proj1', name: 'Test Project', path: 'C:\\work\\test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
const image: ContextAttachment = { id: '.conductor/prompt-images/img1.png', kind: 'image', name: 'Screenshot.png', path: '.conductor/prompt-images/img1.png' }

describe('embedding and recovering task images in Markdown titles', () => {
  it('leaves a plain title untouched when there are no images', () => {
    expect(embedTaskImages('Menus do not scroll', [])).toBe('Menus do not scroll')
  })
  it('appends one Markdown image link per attachment, sanitizing brackets out of the name', () => {
    const images: ContextAttachment[] = [image, { id: 'x', kind: 'image', name: 'weird[name].png', path: '.conductor/prompt-images/x.png' }]
    const embedded = embedTaskImages('Crash on save', images)
    expect(embedded).toBe('Crash on save\n\n![Screenshot.png](.conductor/prompt-images/img1.png)\n![weirdname.png](.conductor/prompt-images/x.png)')
  })
  it('ignores an attachment with no stored path', () => {
    expect(embedTaskImages('Title', [{ id: 'x', kind: 'image', name: 'no-path.png' }])).toBe('Title')
  })
  it('round-trips text and image references back out of an embedded title', () => {
    const embedded = embedTaskImages('Broken layout', [image])
    expect(splitTaskImages(embedded)).toEqual({ text: 'Broken layout', images: [{ id: image.path, name: image.name, path: image.path }] })
  })
  it('recovers multiple images and default names for links without alt text', () => {
    const title = 'Two screenshots attached\n\n![](.conductor/prompt-images/a.png)\n![Second](.conductor/prompt-images/b.png)'
    expect(splitTaskImages(title)).toEqual({
      text: 'Two screenshots attached',
      images: [{ id: '.conductor/prompt-images/a.png', name: 'Image', path: '.conductor/prompt-images/a.png' }, { id: '.conductor/prompt-images/b.png', name: 'Second', path: '.conductor/prompt-images/b.png' }]
    })
  })
  it('leaves a title with no image lines completely unchanged', () => {
    expect(splitTaskImages('Just a normal bug report')).toEqual({ text: 'Just a normal bug report', images: [] })
  })
})

function keyEvent(overrides: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode: number }> = {}) {
  const requestSubmit = vi.fn()
  let defaultPrevented = false
  const event = {
    key: overrides.key ?? 'Enter',
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    nativeEvent: { isComposing: overrides.isComposing ?? false, keyCode: overrides.keyCode ?? 0 },
    currentTarget: { form: { requestSubmit } },
    preventDefault: () => { defaultPrevented = true }
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>
  return { event, requestSubmit, prevented: () => defaultPrevented }
}

describe('sorting project tasks for display (priority first, then newest added)', () => {
  // Sorting is purely a view concern here: feature-list.md keeps its own on-disk
  // order, and the pane reorders only what it renders (see ProjectBacklogPane).
  const created = (at: string): ProjectTaskActivity[] => [{ id: at, status: 'todo', actor: 'file', at }]
  const task = (overrides: Partial<ProjectTask> & { id: string }): ProjectTask =>
    ({ title: overrides.id, kind: 'bug', status: 'todo', priority: 'normal', weight: 'medium', line: 1, activity: [], ...overrides })

  it('always ranks high above normal above low, independent of when each was added', () => {
    const low = task({ id: 'low', priority: 'low', activity: created('2026-01-03T00:00:00Z') })
    const normal = task({ id: 'normal', priority: 'normal', activity: created('2026-01-02T00:00:00Z') })
    const high = task({ id: 'high', priority: 'high', activity: created('2026-01-01T00:00:00Z') })
    expect(sortProjectTasks([low, normal, high]).map(t => t.id)).toEqual(['high', 'normal', 'low'])
  })

  it('orders same-priority tasks newest-added first', () => {
    const oldest = task({ id: 'oldest', activity: created('2026-01-01T00:00:00Z') })
    const newest = task({ id: 'newest', activity: created('2026-01-03T00:00:00Z') })
    const middle = task({ id: 'middle', activity: created('2026-01-02T00:00:00Z') })
    expect(sortProjectTasks([oldest, newest, middle]).map(t => t.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('judges age from the earliest recorded activity (creation), not the most recent status change', () => {
    const recentlyTouchedButOld = task({ id: 'touched', activity: [
      { id: 'a', status: 'doing', actor: 'you', at: '2026-01-05T00:00:00Z' },
      { id: 'b', status: 'todo', actor: 'file', at: '2026-01-01T00:00:00Z' }
    ] })
    const untouchedButNewer = task({ id: 'untouched', activity: created('2026-01-02T00:00:00Z') })
    expect(sortProjectTasks([recentlyTouchedButOld, untouchedButNewer]).map(t => t.id)).toEqual(['untouched', 'touched'])
  })

  it('falls back to file position, newest (highest line) first, when a task has no activity yet', () => {
    const earlier = task({ id: 'earlier', activity: [], line: 5 })
    const later = task({ id: 'later', activity: [], line: 42 })
    expect(sortProjectTasks([earlier, later]).map(t => t.id)).toEqual(['later', 'earlier'])
  })

  it('returns a new array rather than mutating the one it is given', () => {
    const a = task({ id: 'a', activity: created('2026-01-01T00:00:00Z') })
    const b = task({ id: 'b', activity: created('2026-01-02T00:00:00Z') })
    const input = [a, b]
    sortProjectTasks(input)
    expect(input).toEqual([a, b])
  })
})

describe('a done task renders the check affordance', () => {
  it('adds a check icon in front of the title once a task is done', () => {
    const html = renderToStaticMarkup(taskTitleRow('done', 'Ship the release', () => {}))
    expect(html).toContain('project-task-done-check')
    expect(html).toContain('Ship the release')
  })
  it('leaves todo and doing rows without the check icon', () => {
    expect(renderToStaticMarkup(taskTitleRow('todo', 'Ship the release', () => {}))).not.toContain('project-task-done-check')
    expect(renderToStaticMarkup(taskTitleRow('doing', 'Ship the release', () => {}))).not.toContain('project-task-done-check')
  })
})

describe('Ctrl+Enter submits a filed task', () => {
  it('requests form submission on Ctrl+Enter and Cmd+Enter', () => {
    for (const overrides of [{ ctrlKey: true }, { metaKey: true }]) {
      const { event, requestSubmit, prevented } = keyEvent(overrides)
      submitTaskShortcut(event)
      expect(requestSubmit).toHaveBeenCalledTimes(1)
      expect(prevented()).toBe(true)
    }
  })
  it('does not submit on plain Enter, so a new line can still be typed', () => {
    const { event, requestSubmit } = keyEvent({})
    submitTaskShortcut(event)
    expect(requestSubmit).not.toHaveBeenCalled()
  })
  it('does not submit while an IME composition is in progress, even with Ctrl held', () => {
    for (const overrides of [{ ctrlKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 }]) {
      const { event, requestSubmit } = keyEvent(overrides)
      submitTaskShortcut(event)
      expect(requestSubmit).not.toHaveBeenCalled()
    }
  })
})

describe('ProjectBacklogPane compose form image upload', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', new MemoryStorage()) })
  afterEach(() => { vi.unstubAllGlobals() })
  const render = (): string => renderToStaticMarkup(createElement(ProjectBacklogPane, { project }))

  it('always shows the upload affordance, with no leftover chips when nothing is attached', () => {
    const html = render()
    expect(html).toContain('aria-label="Upload images"')
    expect(html).not.toContain('sa-context-chips')
    expect(html).toContain('title="Ctrl+Enter to add; Enter for a new line"')
  })

  it('offers a compact priority control alongside the new task type, defaulting to normal', () => {
    const html = render()
    expect(html).toContain('aria-label="New task priority"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('project-priority-trigger priority-normal')
    expect(html).toContain('Normal priority')
    // A themed native <select> tints every option in its popup, not just the trigger
    // (the bug this control replaced): confirm it is a custom listbox, not a <select>.
    expect(html).not.toContain('<select aria-label="New task priority"')
  })

  it('restores a queued image as a removable thumbnail chip alongside the draft title', () => {
    localStorage.setItem('conductor.tasks.draft.' + project.id, JSON.stringify({ title: 'Investigate the crash', images: [image], editing: null }))
    const html = render()
    expect(html).toContain('Investigate the crash')
    expect(html).toContain('sa-context-chips')
    expect(html).toContain('Screenshot.png')
    expect(html).toContain('aria-label="Remove attached image Screenshot.png"')
    expect(html).toContain('aria-label="Upload images"')
  })

  it('ignores a corrupted draft image entry instead of crashing the pane', () => {
    localStorage.setItem('conductor.tasks.draft.' + project.id, JSON.stringify({ title: 'Still works', images: [{ kind: 'image' }], editing: null }))
    const html = render()
    expect(html).toContain('Still works')
    expect(html).not.toContain('sa-context-chips')
  })

  it('defaults a newly filed task to the neutral Task kind, not Bug', () => {
    const html = render()
    expect(html).toContain('aria-label="New task type"')
    expect(html).toContain('<option value="task" selected="">Task</option>')
    expect(html).toContain('<option value="bug">Bug</option>')
  })

  it('offers a compact weight control alongside the new task type, defaulting to medium', () => {
    const html = render()
    expect(html).toContain('aria-label="New task weight"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('project-weight-trigger weight-medium')
    expect(html).toContain('Medium weight')
    expect(html).not.toContain('<select aria-label="New task weight"')
  })

  it('lists Task alongside Bug, Feature and Idea in the type filter', () => {
    const html = render()
    expect(html).toContain('aria-label="Task type filter"')
    expect(html).toContain('<option value="task">Tasks</option>')
  })
})
