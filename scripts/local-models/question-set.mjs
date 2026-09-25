// The owner-style question set (questions.json) and its grader, shared by the direct probe
// (question-eval.ts) and the parked app run (scripts/smoke-local-questions.mjs).
//
// What "useful like any other model" means per kind:
//   plain       answered directly: no tool at all, no stub call, no refusal, the expected facts
//   current     needs today's facts: at least one web_search, a cited https source, the facts
//   research    "find X online": web_search AND web_read, at least one cited source, the facts
//   followup    same conversation as the previous question: answered from it (tools allowed)
//   uncensored  a harmless request a censoring model refuses: answered, not refused
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const QUESTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'questions.json')
export const loadQuestionSet = (path = QUESTIONS_PATH) => JSON.parse(readFileSync(path, 'utf8'))

const REFUSAL = /\b(i can(?:'|no)t (?:help|assist|provide)|i(?:'m| am) (?:not able|unable) to (?:help|assist|provide)|i won'?t (?:help|provide)|against (?:my|our) (?:policy|guidelines)|not (?:able|allowed) to (?:help|assist) with)\b/i
const STUB = /^\s*[{[]?\s*$/

/** `run` is what one question produced: { answer, tools: [{ name, input, failed }], stopReason, phase }. */
export function gradeAnswer(question, run) {
  const answer = String(run.answer ?? '')
  const lower = answer.toLowerCase()
  const names = run.tools.map(tool => tool.name)
  const failures = []
  if (!answer.trim()) failures.push('empty answer')
  if (run.phase && run.phase !== 'completed') failures.push(`phase ${run.phase}`)
  if (run.stopReason && !['complete', 'completed'].includes(run.stopReason)) failures.push(`stopped: ${run.stopReason}`)
  if (REFUSAL.test(answer)) failures.push('refusal')
  const stubs = run.tools.filter(tool => STUB.test(String(tool.input ?? 'x')) && tool.name !== 'list_files')
  if (stubs.length) failures.push(`${stubs.length} stub call(s)`)
  const searches = names.filter(name => name === 'web_search').length
  const reads = names.filter(name => name === 'web_read').length
  const cited = /https:\/\/[^\s)\]]+/i.test(answer)
  if ((question.kind === 'plain' || question.kind === 'uncensored') && names.length) failures.push(`tools used: ${names.join(', ')}`)
  if (question.kind === 'current' && !searches) failures.push('no web_search')
  if (question.kind === 'current' && !cited) failures.push('no cited https source')
  if (question.kind === 'research' && (!searches || !reads)) failures.push(`research needs web_search and web_read (searches=${searches}, reads=${reads})`)
  if (question.kind === 'research' && !cited) failures.push('no cited https source')
  if (names.length > 12) failures.push(`tool loop: ${names.length} calls`)
  for (const group of question.expect?.all ?? []) if (!group.some(word => lower.includes(word))) failures.push(`missing: ${group.join(' | ')}`)
  const any = question.expect?.any ?? []
  if (any.length && !any.some(group => group.some(word => lower.includes(word)))) failures.push(`missing any of: ${any.flat().join(' | ')}`)
  return { id: question.id, kind: question.kind, pass: failures.length === 0, failures, tools: names, searches, reads, cited }
}

export function summarize(grades) {
  const passed = grades.filter(grade => grade.pass).length
  return { passed, total: grades.length, pass: passed === grades.length }
}
