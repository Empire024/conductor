import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Target lines in data2.txt: tab-separated rows with at least four non-empty cells ("Zobrazit PDF" filler lines have one). */
export function countTargets(text) {
  return String(text).split(/\r?\n/).filter(line => line.split('\t').filter(cell => cell.trim()).length >= 4).length
}

/**
 * Minimal oracle for the faktury goal: the validated process_files artifact must carry exactly
 * one outcome per invoice line in data2.txt. It does not check dates; the artifact's own
 * validation and the predicate's blocked-outcome rule cover correctness of each outcome.
 */
export async function evaluate({ projectPath, artifact }) {
  const notes = []
  let text
  try { text = await readFile(join(projectPath, 'data2.txt'), 'utf8') } catch (error) {
    return { pass: false, notes: [`cannot read data2.txt in ${projectPath}: ${error.message}`] }
  }
  const expected = countTargets(text)
  notes.push(`data2.txt has ${expected} target line(s)`)
  if (!artifact || !Array.isArray(artifact.outcomes)) return { pass: false, notes: [...notes, 'no validated artifact to compare'] }
  const actual = artifact.outcomes.length
  notes.push(`artifact has ${actual} outcome(s)`)
  return { pass: expected > 0 && actual === expected, notes }
}
