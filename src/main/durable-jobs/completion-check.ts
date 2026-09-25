import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CompletionCheck, CompletionCheckPort } from './ports'

/**
 * A stage's own final answer is never proof by itself (RV1 D5: a stage whose completion
 * criterion was "LOG.md has 100000 lines" reported completed after 442 s with LOG.md never
 * created). For the criteria phrased as a fact about a file on disk, this checks the fact before
 * the controller trusts the model's "done". A criterion this cannot parse is left unchecked
 * (`checked: false`) rather than failing the stage on a criterion nothing here understands.
 */

const EXISTS_RE = /^(\S+?)\s+(?:exists|has been created|is created|was created)\.?$/i
const LINES_RE = /^(\S+?)\s+(?:has|contains)\s+(exactly\s+)?(?:at\s+least\s+)?([\d,]+)\+?\s+lines?\.?$/i

async function lineCount(path: string): Promise<number> {
  const text = await readFile(path, 'utf8')
  if (!text) return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.length ? body.split('\n').length : 0
}

/** One completion criterion checked against the job's cwd; never throws. */
async function checkOne(cwd: string, criterion: string): Promise<CompletionCheck> {
  const text = criterion.trim()
  const lines = LINES_RE.exec(text)
  if (lines) {
    const [, rawPath, exactly, rawCount] = lines as unknown as [string, string, string | undefined, string]
    const need = Number(rawCount.replace(/,/g, ''))
    try {
      const actual = await lineCount(resolve(cwd, rawPath))
      const met = exactly ? actual === need : actual >= need
      return { criterion, checked: true, met, detail: `${rawPath} has ${actual} line(s), need ${exactly ? 'exactly ' : 'at least '}${need}` }
    } catch {
      return { criterion, checked: true, met: false, detail: `${rawPath} does not exist (need ${exactly ? 'exactly ' : 'at least '}${need} line(s))` }
    }
  }
  const exists = EXISTS_RE.exec(text)
  if (exists) {
    const rawPath = exists[1]!
    const met = await readFile(resolve(cwd, rawPath)).then(() => true, () => false)
    return { criterion, checked: true, met, detail: met ? `${rawPath} exists` : `${rawPath} does not exist` }
  }
  return { criterion, checked: false, met: true, detail: 'not a mechanically checkable criterion' }
}

export async function checkCompletionCriteria(cwd: string, criteria: readonly string[]): Promise<CompletionCheck[]> {
  return Promise.all(criteria.map(criterion => checkOne(cwd, criterion)))
}

export const unmetCriteria = (checks: readonly CompletionCheck[]): CompletionCheck[] => checks.filter(check => check.checked && !check.met)

export const mechanicalCompletionCheck: CompletionCheckPort = { check: checkCompletionCriteria }
