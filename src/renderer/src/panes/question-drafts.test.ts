import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputQuestion, PendingInteraction, TimelineItem } from '../../../shared/structured-agent'
import { ANSWERED_IN_CONVERSATION } from '../../../shared/structured-agent'
import { QUESTION_DRAFT_LIMIT, questionDraftKey, questionDrafts } from './question-drafts'
import { emptyQuestionDraft, keepsQuestionDraft, StructuredActivity, type QuestionDraft } from './StructuredAgentRenderers'

// A half-typed answer survives the conversation view unmounting (tab-keep-alive.ts suspends every
// inactive tab): the card writes its draft here and a remounted card starts from it.
const questions: InputQuestion[] = [
  { id: 'look', question: 'Which look?', options: [{ label: 'A' }, { label: 'B' }], allowCustom: true },
  { id: 'hook', question: 'What are the hook words?', options: [], allowCustom: true }
]
const asked = (status: PendingInteraction['status'], outcome?: string): PendingInteraction => ({ id: 'q', kind: 'question', title: 'Codex asked you', status, input: {}, choices: [], questions, ...(outcome ? { outcome } : {}) })
const typed: QuestionDraft = { answers: {}, custom: { look: 'Night, handheld' }, customSelected: { look: true } }
const render = (interaction: PendingInteraction, sessionId = 'session', interactive = true): string => {
  const item: TimelineItem = { id: 'item-q', runtimeId: 'runtime', sequence: 1, timestamp: '2026-10-18T00:00:00Z', data: { type: 'interaction', interaction } }
  return renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId, cwd: 'C:\work', expanded: true, interactive, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}) }))
}

afterEach(() => questionDrafts.clear())

describe('question drafts outlive the conversation view (question-draft-survives-suspend)', () => {
  it('a remounted open card starts from the answer typed before the tab was switched away', () => {
    expect(render(asked('pending'))).not.toContain('Night, handheld')
    questionDrafts.set(questionDraftKey('session', 'item-q'), typed)
    const html = render(asked('pending'))
    expect(html).toContain('value="Night, handheld"')
    expect(html).toContain('Question 1 of 2')
  })
  it('a card that closed while its view was suspended comes back as the closed card with the answer', () => {
    questionDrafts.set(questionDraftKey('session', 'item-q'), typed)
    const html = render(asked('resolved', ANSWERED_IN_CONVERSATION))
    expect(html).toContain('Question closed')
    expect(html).toContain('value="Night, handheld"')
    expect(html).toContain('Send as message')
  })
  it('drafts are per conversation and per timeline item', () => {
    questionDrafts.set(questionDraftKey('other-session', 'item-q'), typed)
    expect(render(asked('pending'))).not.toContain('Night, handheld')
    expect(questionDraftKey('a', 'b')).not.toBe(questionDraftKey('a', 'c'))
    expect(questionDraftKey('a', 'b')).not.toBe(questionDraftKey('b', 'a'))
  })
  it('keeps what is worth keeping, and nothing once sent, discarded, answered or empty', () => {
    expect(keepsQuestionDraft(asked('pending'), true, typed, 'open', null)).toBe(true)
    expect(keepsQuestionDraft(asked('expired'), true, typed, 'open', null)).toBe(true)
    expect(keepsQuestionDraft(asked('pending'), true, emptyQuestionDraft, 'open', null)).toBe(false)
    expect(keepsQuestionDraft(asked('pending'), true, typed, 'open', { look: ['Night, handheld'] })).toBe(false)
    expect(keepsQuestionDraft(asked('expired'), true, typed, 'sent', null)).toBe(false)
    expect(keepsQuestionDraft(asked('expired'), true, typed, 'discarded', null)).toBe(false)
    expect(keepsQuestionDraft(asked('resolved', 'answered'), true, typed, 'open', { look: ['B'] })).toBe(false)
    expect(keepsQuestionDraft({ ...asked('pending'), kind: 'approval', questions: undefined }, true, typed, 'open', null)).toBe(false)
  })
  it('stays bounded, dropping the draft untouched longest', () => {
    for (let index = 0; index <= QUESTION_DRAFT_LIMIT; index++) questionDrafts.set(questionDraftKey('s', 'item-' + index), typed)
    expect(questionDrafts.size).toBe(QUESTION_DRAFT_LIMIT)
    expect(questionDrafts.get(questionDraftKey('s', 'item-0'))).toBeUndefined()
    // Writing again refreshes a draft's place.
    questionDrafts.set(questionDraftKey('s', 'item-1'), typed)
    questionDrafts.set(questionDraftKey('s', 'item-new'), typed)
    expect(questionDrafts.get(questionDraftKey('s', 'item-1'))).toBe(typed)
    expect(questionDrafts.get(questionDraftKey('s', 'item-2'))).toBeUndefined()
    questionDrafts.delete(questionDraftKey('s', 'item-1'))
    expect(questionDrafts.get(questionDraftKey('s', 'item-1'))).toBeUndefined()
  })
})
