import type { ControlId, HumanReviewItem, ReviewAnswerRecord } from '../../shared/production'

/**
 * Carrying human-review answers from one run to the next by meaning (docs/production-agent.md
 * section 7). The interpretation step regenerates its questions every run and numbers them
 * (`C01:interpretation-1`, ...), so an item id neither stays the same for the same question nor
 * means the same question twice. An answer is therefore matched to a later item by control, route
 * and the normalised wording of the question; the item id only decides between equal candidates,
 * and decides alone only for answers recorded before the wording was kept.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with',
  'and', 'or', 'this', 'that', 'these', 'those', 'it', 'its', 'their', 'there', 'any', 'all', 'each', 'every', 'as', 'from', 'into', 'than', 'then', 'so',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'please', 'confirm', 'check', 'verify', 'whether', 'if', 'site', 'page',
])

/** The question's content words: lower case, accents and punctuation dropped, stopwords removed, plurals folded, sorted and unique. */
export function meaningTokens(question: string): string[] {
  const words = question.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const tokens = new Set<string>()
  for (const word of words) {
    if (STOPWORDS.has(word)) continue
    tokens.add(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)
  }
  return [...tokens].sort()
}

/** The stable key of a review item: control, route and meaning; the item id plays no part. */
export function reviewKey(item: { controlId: ControlId; route?: string | null; question: string }): string {
  return `${item.controlId}|${item.route ?? ''}|${meaningTokens(item.question).join(' ')}`
}

/** Jaccard similarity of two token sets (1 for two empty sets). */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 1
  const left = new Set(a)
  let shared = 0
  for (const token of new Set(b)) if (left.has(token)) shared++
  return shared / (left.size + new Set(b).size - shared)
}

/** Reworded questions that share at least this much of their content words are the same question. */
export const SAME_MEANING = 0.8

export type AnswerMatch =
  /** The answer was recorded for this very item of this very run. */
  | { how: 'same-item'; answer: ReviewAnswerRecord }
  /** The answer was recorded for an item of another run that asks the same thing. */
  | { how: 'meaning'; answer: ReviewAnswerRecord; score: number }
  /** An answer recorded before wording was kept: the item id is all there is to go by. */
  | { how: 'legacy-id'; answer: ReviewAnswerRecord }

/**
 * Matches the items of one control result to recorded answers. Each answer of another run serves
 * at most one item, so one confirmed question never covers two different ones; the newest answer
 * wins between equally good candidates.
 */
export function matchAnswers(runId: string, items: readonly HumanReviewItem[], answers: readonly ReviewAnswerRecord[]): Map<string, AnswerMatch> {
  const newestFirst = [...answers].sort((a, b) => (a.answeredAt < b.answeredAt ? 1 : a.answeredAt > b.answeredAt ? -1 : 0))
  const matches = new Map<string, AnswerMatch>()
  const used = new Set<ReviewAnswerRecord>()
  // 1. Answers given to this run's own items.
  for (const item of items) {
    const own = newestFirst.find(answer => answer.runId === runId && answer.itemId === item.id && answer.controlId === item.controlId)
    if (own) { matches.set(item.id, { how: 'same-item', answer: own }); used.add(own) }
  }
  // 2. Answers with recorded wording, by meaning: best score first, the same item id breaking ties.
  const candidates: Array<{ item: HumanReviewItem; answer: ReviewAnswerRecord; score: number; sameId: boolean; order: number }> = []
  newestFirst.forEach((answer, order) => {
    if (answer.question == null || used.has(answer)) return
    const answerTokens = meaningTokens(answer.question)
    for (const item of items) {
      if (matches.has(item.id) || item.controlId !== answer.controlId || (item.route ?? null) !== (answer.route ?? null)) continue
      const score = similarity(meaningTokens(item.question), answerTokens)
      if (score >= SAME_MEANING) candidates.push({ item, answer, score, sameId: answer.itemId === item.id, order })
    }
  })
  candidates.sort((a, b) => b.score - a.score || Number(b.sameId) - Number(a.sameId) || a.order - b.order)
  for (const candidate of candidates) {
    if (matches.has(candidate.item.id) || used.has(candidate.answer)) continue
    matches.set(candidate.item.id, { how: 'meaning', answer: candidate.answer, score: candidate.score })
    used.add(candidate.answer)
  }
  // 3. Legacy answers without wording: the item id alone, as before.
  for (const item of items) {
    if (matches.has(item.id)) continue
    const legacy = newestFirst.find(answer => answer.question == null && !used.has(answer) && answer.itemId === item.id && answer.controlId === item.controlId)
    if (legacy) { matches.set(item.id, { how: 'legacy-id', answer: legacy }); used.add(legacy) }
  }
  return matches
}
