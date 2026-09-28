// How the durable-job smoke reads a job's result: the way the owner receives it. A job on a git
// repository never touches the owner's tree - it commits to its own conductor-job/<id> branch, and
// integrating that branch is the owner's call (src/main/durable-jobs/worktree.ts). So the checked
// files come from that branch; only a project that is not a git repository is read in place. The
// owner's checkout staying untouched is the job's isolation guarantee, and is checked too.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const OUTPUT_CAP_BYTES = 64 * 1024
/** Every file a fixture's output check reads at its top level (append, index, crossref). */
export const CHECKED_FILES = ['notes.txt', 'INDEX.md', 'CROSSREF.md']

export const jobBranch = jobId => `conductor-job/${jobId}`
export const isGitProject = projectPath => existsSync(join(projectPath, '.git'))
const git = (projectPath, args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** The head commit of a local branch, or null when there is no such branch. */
export function branchHead(projectPath, branch) {
  try { return git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).trim() || null } catch { return null }
}

/** `path` as the job committed it: `{ text }`, or `{ text: null, missing }` naming what was not there
 *  (the branch itself, or the file on it). Not a git repository: the project folder. */
export async function readJobFile(projectPath, jobId, path) {
  if (!isGitProject(projectPath)) {
    try { return { text: await readFile(join(projectPath, path), 'utf8') } } catch { return { text: null, missing: `${path} in the project folder` } }
  }
  const branch = jobBranch(jobId)
  if (!branchHead(projectPath, branch)) return { text: null, missing: `branch ${branch}` }
  try { return { text: git(projectPath, ['show', `refs/heads/${branch}:${path.replace(/\\/g, '/')}`]) } } catch { return { text: null, missing: `${path} on ${branch}` } }
}

/** The owner's checkout after the job: main still at the initial commit and notes.txt still exactly
 *  its initial content. Returns the problems; empty means untouched. Not a git repository: none. */
export async function isolationProblems(projectPath, { initialCommit, initialNotes }) {
  if (!isGitProject(projectPath)) return []
  const problems = []
  const main = branchHead(projectPath, 'main')
  if (main !== initialCommit) problems.push(`the owner's main moved: ${main ?? 'missing'} is not the initial commit ${initialCommit}`)
  const notes = await readFile(join(projectPath, 'notes.txt'), 'utf8').catch(() => null)
  if (notes !== initialNotes) problems.push(`the owner's notes.txt changed: it ends ${JSON.stringify(notes === null ? null : notes.slice(-200))}`)
  return problems
}

/** The last `count` lines of a text, trailing blank lines ignored; null for a missing text. */
export const lastLines = (text, count = 5) => text == null ? null : text.replace(/\s+$/, '').split(/\r?\n/).slice(-count)

const capped = text => {
  const bytes = Buffer.from(text, 'utf8')
  return bytes.length <= OUTPUT_CAP_BYTES ? text : `${bytes.subarray(0, OUTPUT_CAP_BYTES).toString('utf8')}\n[truncated at ${OUTPUT_CAP_BYTES} of ${bytes.length} bytes]\n`
}

/**
 * Evidence for a failed acceptance check, written under `dir`: each checked file as the job
 * committed it (job/<file>) and as the owner's checkout holds it (project/<file>), capped at
 * OUTPUT_CAP_BYTES and passed through `sanitize`, plus summary.json with the branch, its head, the
 * owner's main, and the job's final stage summaries. Returns the compact record the FAILED line logs
 * (the last five lines of each copy).
 */
export async function captureJobOutput({ projectPath, jobId, dir, sanitize = text => text, stageSummaries = null }) {
  const save = async (name, text) => {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), sanitize(capped(text)))
  }
  const repository = isGitProject(projectPath)
  const branch = repository ? jobBranch(jobId) : null
  const record = { dir, branch, branchHead: repository ? branchHead(projectPath, branch) : null, mainHead: repository ? branchHead(projectPath, 'main') : null, files: {} }
  for (const path of CHECKED_FILES) {
    const job = await readJobFile(projectPath, jobId, path)
    const project = await readFile(join(projectPath, path), 'utf8').catch(() => null)
    if (job.text === null && project === null && path !== 'notes.txt') continue
    if (job.text !== null) await save(join('job', path), job.text)
    if (project !== null) await save(join('project', path), project)
    const view = text => ({ bytes: Buffer.byteLength(text, 'utf8'), last5: lastLines(sanitize(text)) })
    record.files[path] = { job: job.text === null ? { missing: job.missing } : view(job.text), project: project === null ? { missing: `${path} in the owner's checkout` } : view(project) }
  }
  await save('summary.json', JSON.stringify({ jobId, ...record, stageSummaries }, null, 2))
  return record
}
