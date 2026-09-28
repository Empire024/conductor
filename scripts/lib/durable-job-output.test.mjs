import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OUTPUT_CAP_BYTES, captureJobOutput, isolationProblems, jobBranch, lastLines, readJobFile } from './durable-job-output.mjs'

const INITIAL_NOTES = 'first line\n'
const JOB = 'job_test_1'

/** The smoke's project: main at "Initial" with notes.txt, and the job's own branch holding its
 *  committed result, as src/main/durable-jobs/worktree.ts leaves it. */
function project({ jobNotes = 'first line\ndurable smoke\n', branch = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'durable-job-output-'))
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim()
  writeFileSync(join(root, 'notes.txt'), INITIAL_NOTES)
  // Switching back to main below must not rewrite notes.txt with CRLF on a core.autocrlf machine.
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-q', '-m', 'Initial')
  const initialCommit = git('rev-parse', 'HEAD')
  if (branch) {
    git('checkout', '-q', '-b', jobBranch(JOB))
    if (jobNotes === null) git('rm', '-q', 'notes.txt'); else writeFileSync(join(root, 'notes.txt'), jobNotes)
    git('commit', '-q', '-am', 'Durable job checkpoint')
    git('checkout', '-q', 'main')
  }
  return { root, git, initialCommit, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('readJobFile reads the job\'s committed branch, not the owner\'s untouched checkout', async () => {
  const box = project()
  try {
    assert.deepEqual(await readJobFile(box.root, JOB, 'notes.txt'), { text: 'first line\ndurable smoke\n' })
    assert.equal(readFileSync(join(box.root, 'notes.txt'), 'utf8'), INITIAL_NOTES)
  } finally { box.cleanup() }
})

test('readJobFile names a missing branch, and a file missing on the branch', async () => {
  const noBranch = project({ branch: false })
  const noFile = project({ jobNotes: null })
  try {
    assert.deepEqual(await readJobFile(noBranch.root, JOB, 'notes.txt'), { text: null, missing: `branch conductor-job/${JOB}` })
    assert.deepEqual(await readJobFile(noFile.root, JOB, 'notes.txt'), { text: null, missing: `notes.txt on conductor-job/${JOB}` })
  } finally { noBranch.cleanup(); noFile.cleanup() }
})

test('readJobFile reads the project folder in place only when it is not a git repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durable-job-output-plain-'))
  try {
    writeFileSync(join(root, 'notes.txt'), 'plain\n')
    assert.deepEqual(await readJobFile(root, JOB, 'notes.txt'), { text: 'plain\n' })
    assert.deepEqual(await readJobFile(root, JOB, 'INDEX.md'), { text: null, missing: 'INDEX.md in the project folder' })
    assert.deepEqual(await isolationProblems(root, { initialCommit: 'x', initialNotes: INITIAL_NOTES }), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('isolationProblems passes an untouched checkout and names a moved main or a changed notes.txt', async () => {
  const box = project()
  try {
    const expected = { initialCommit: box.initialCommit, initialNotes: INITIAL_NOTES }
    assert.deepEqual(await isolationProblems(box.root, expected), [])
    writeFileSync(join(box.root, 'notes.txt'), 'first line\nleaked\n')
    assert.match((await isolationProblems(box.root, expected)).join('\n'), /the owner's notes\.txt changed/)
    box.git('commit', '-q', '-am', 'moved')
    const problems = await isolationProblems(box.root, expected)
    assert.ok(problems.some(problem => /the owner's main moved/.test(problem)), problems.join('\n'))
  } finally { box.cleanup() }
})

test('captureJobOutput keeps both copies, the branch and summaries, sanitized and capped, and logs the last five lines', async () => {
  const secret = 'SECRET-TOKEN-0123456789'
  const long = Array.from({ length: 9000 }, (_, i) => `line ${i} ${i === 3 ? secret : ''}`).join('\n') + '\ndurable smoke\n'
  const box = project({ jobNotes: long })
  const dir = join(box.root, '..', `${JOB}-evidence-${process.pid}`)
  try {
    const record = await captureJobOutput({ projectPath: box.root, jobId: JOB, dir, sanitize: text => text.split(secret).join('[redacted]'), stageSummaries: [{ stage: 'Append', summary: 'done' }] })
    assert.equal(record.branch, `conductor-job/${JOB}`)
    assert.equal(record.branchHead, box.git('rev-parse', `conductor-job/${JOB}`))
    assert.equal(record.mainHead, box.initialCommit)
    assert.deepEqual(record.files['notes.txt'].job.last5, ['line 8996 ', 'line 8997 ', 'line 8998 ', 'line 8999 ', 'durable smoke'])
    assert.deepEqual(record.files['notes.txt'].project.last5, ['first line'])
    assert.equal(record.files['INDEX.md'], undefined, 'a file neither copy has is skipped')
    const saved = readFileSync(join(dir, 'job', 'notes.txt'), 'utf8')
    assert.ok(Buffer.byteLength(saved) < OUTPUT_CAP_BYTES + 200 && /\[truncated at 65536 of \d+ bytes\]/.test(saved), 'capped at 64 KiB')
    assert.ok(!saved.includes(secret) && saved.includes('[redacted]'), 'sanitized')
    assert.equal(readFileSync(join(dir, 'project', 'notes.txt'), 'utf8'), INITIAL_NOTES)
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
    assert.deepEqual(summary.stageSummaries, [{ stage: 'Append', summary: 'done' }])
    assert.equal(summary.jobId, JOB)
  } finally { box.cleanup(); rmSync(dir, { recursive: true, force: true }) }
})

test('captureJobOutput records a missing branch instead of failing', async () => {
  const box = project({ branch: false })
  const dir = join(box.root, '..', `${JOB}-missing-${process.pid}`)
  try {
    const record = await captureJobOutput({ projectPath: box.root, jobId: JOB, dir })
    assert.equal(record.branchHead, null)
    assert.deepEqual(record.files['notes.txt'].job, { missing: `branch conductor-job/${JOB}` })
    assert.ok(existsSync(join(dir, 'summary.json')))
  } finally { box.cleanup(); rmSync(dir, { recursive: true, force: true }) }
})

test('lastLines ignores trailing blank lines and keeps null for a missing text', () => {
  assert.deepEqual(lastLines('a\nb\n\n'), ['a', 'b'])
  assert.equal(lastLines(null), null)
})
