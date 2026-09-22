import { describe, expect, it } from 'vitest'
import { ApprovalReviews, actionDigest, type ReviewAction, type ReviewPersistence, type ReviewResult } from './approval-review'

class MemoryPersistence implements ReviewPersistence {
  private values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
}

const action = (overrides: Partial<ReviewAction> = {}): ReviewAction => ({
  projectId: 'project-1', machineId: 'machine-1', workerId: 'worker-1', runtimeId: 'runtime-1', requestId: 'request-1',
  tool: 'Write', arguments: { content: 'hello', file_path: 'src/example.ts' }, paths: ['src/example.ts'],
  boundary: 'workspace-write', reason: 'write a source file', sideEffects: ['modify workspace'], ownerEvidence: 'owner selected task',
  authorizationId: 'auth-1', native: { tool_use_id: 'native-1', tool_name: 'Write' }, ...overrides
})

const result = (digest: string, decision: ReviewResult['decision'] = 'allow', reviewerId = 'reviewer-1'): ReviewResult => ({
  decision, rationale: `reviewed ${decision}`, digest, reviewerId, model: 'review-model', turnId: 'turn-1'
})

const unchanged = (record: Awaited<ReturnType<ApprovalReviews['review']>>) => record

describe('ApprovalReviews', () => {
  it('reserves a logical mutation only once when two different requests were both reviewed concurrently', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence()), first = action(), second = action({ requestId: 'other-request' })
    await Promise.all([journal.review(first, async digest => result(digest), unchanged), journal.review(second, async digest => result(digest), unchanged)])
    journal.reserve(first)
    expect(() => journal.reserve(second)).toThrow('competing operation')
  })

  it('keeps uncertain response intent after a changed-payload presentation transition', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence()), first = action()
    await journal.review(first, async digest => result(digest), unchanged)
    journal.reserve(first)
    const changed = action({ arguments: { content: 'changed', file_path: 'src/example.ts' } })
    expect((await journal.review(changed, async digest => result(digest), unchanged)).phase).toBe('blocked')
    const next = await journal.review({ ...changed, requestId: 'replacement' }, async digest => result(digest), unchanged)
    expect(next.phase).toBe('blocked')
    expect(next.rationale).toContain('no conclusive execution')
  })

  it('refuses a stale journal transition rather than replacing newer state', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence()), original = action()
    const reviewed = await journal.review(original, async digest => result(digest), unchanged)
    journal.reserve(original)
    expect(() => journal.transition(reviewed, 'owner', 'stale escalation')).toThrow('stale transition')
  })
  it('makes argument key order irrelevant but blocks changed arguments under one request identity', async () => {
    const first = action({ arguments: { a: 1, nested: { z: true, a: false } } })
    const reordered = action({ arguments: { nested: { a: false, z: true }, a: 1 } })
    expect(actionDigest(first)).toBe(actionDigest(reordered))

    const journal = new ApprovalReviews(new MemoryPersistence())
    let runs = 0
    const reviewed = await journal.review(first, async digest => { runs++; return result(digest) }, unchanged)
    expect(reviewed.phase).toBe('approved')
    expect(runs).toBe(1)

    const changed = await journal.review(action({ arguments: { a: 2, nested: { z: true, a: false } } }), async digest => { runs++; return result(digest) }, unchanged)
    expect(changed.phase).toBe('blocked')
    expect(changed.rationale).toContain('changed arguments')
    expect(runs).toBe(1)
  })

  it('persists an owner denial across a different worker and tool targeting the same path', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence())
    const denied = await journal.review(action(), async digest => result(digest, 'deny'), unchanged)
    expect(denied.phase).toBe('denied')
    expect(journal.denied(action({ workerId: 'worker-2', tool: 'Bash', requestId: 'request-2', native: { tool_name: 'Bash' } }))).toBe(true)

    let runs = 0
    const retried = await journal.review(action({ workerId: 'worker-2', tool: 'Bash', requestId: 'request-2', native: { tool_name: 'Bash' } }), async digest => { runs++; return result(digest, 'allow') }, unchanged)
    expect(retried.phase).toBe('denied')
    expect(retried.rationale).toContain('durable denial')
    expect(runs).toBe(0)
  })

  it('runs one reviewer for duplicate concurrent requests', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence())
    let runs = 0
    let release!: (value: ReviewResult) => void
    const reviewer = new Promise<ReviewResult>(resolve => { release = resolve })
    const run = (digest: string) => { runs++; return reviewer.then(value => ({ ...value, digest })) }
    const first = journal.review(action(), run, unchanged)
    const second = journal.review(action(), run, unchanged)
    release(result(actionDigest(action())))
    const records = await Promise.all([first, second])
    expect(runs).toBe(1)
    expect(records[0]?.phase).toBe('approved')
    expect(records[1]?.phase).toBe('approved')
  })

  it('pauses when the reviewer is unavailable', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence())
    const record = await journal.review(action(), async () => { throw new Error('reviewer unavailable') }, unchanged)
    expect(record.phase).toBe('paused')
    expect(record.rationale).toBe('reviewer unavailable')
  })

  it('blocks unsupported boundaries without calling the reviewer', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence())
    let runs = 0
    const record = await journal.review(action({ boundary: 'unsupported', reason: 'native route is not reviewable' }), async digest => { runs++; return result(digest) }, unchanged)
    expect(record.phase).toBe('blocked')
    expect(record.rationale).toBe('native route is not reviewable')
    expect(runs).toBe(0)
  })

  it('blocks reviewer allow for native-owner boundaries and permits only explicit escalation to owner', async () => {
    const journal = new ApprovalReviews(new MemoryPersistence())
    const allow = await journal.review(action({ boundary: 'native-owner' }), async digest => result(digest, 'allow'), unchanged)
    expect(allow.phase).toBe('blocked')
    expect(allow.rationale).toContain('Explicit escalation is required')

    const escalation = await journal.review(action({ requestId: 'request-2', boundary: 'native-owner' }), async digest => result(digest, 'escalate'), unchanged)
    expect(escalation.phase).toBe('owner')
  })

  it('requires reviewer escalation before accepting an owner answer', async () => {
    const persistence = new MemoryPersistence()
    const journal = new ApprovalReviews(persistence)
    const approved = await journal.review(action(), async digest => result(digest, 'allow'), unchanged)
    expect(() => journal.reserve(action(), 'allow')).toThrow('only after explicit reviewer escalation')
    expect(() => journal.reserve(action(), 'deny')).toThrow('only after explicit reviewer escalation')

    const ownerAction = action({ requestId: 'request-owner' })
    await journal.review(ownerAction, async digest => result(digest, 'escalate'), unchanged)
    const reserved = journal.reserve(ownerAction, 'allow')
    expect(reserved.phase).toBe('responding')
    expect(approved.phase).toBe('approved')
  })

  it.each([
    { name: 'self reviewer', reviewerId: 'worker-1', digest: undefined },
    { name: 'incorrect digest', reviewerId: 'reviewer-1', digest: 'wrong-digest' }
  ])('pauses and rejects $name results', async row => {
    const journal = new ApprovalReviews(new MemoryPersistence())
    const record = await journal.review(action(), async digest => result(row.digest ?? digest, 'allow', row.reviewerId), unchanged)
    expect(record.phase).toBe('paused')
    expect(record.rationale).toContain('matching digest')
  })

  it('persists response intent and never replays it after reconstruction or a new request id', async () => {
    const persistence = new MemoryPersistence()
    const firstJournal = new ApprovalReviews(persistence)
    const original = action()
    const approved = await firstJournal.review(original, async digest => result(digest), unchanged)
    expect(firstJournal.reserve(original).phase).toBe('responding')

    const reconstructed = new ApprovalReviews(persistence)
    let reruns = 0
    const recovered = await reconstructed.review(original, async digest => { reruns++; return result(digest) }, unchanged)
    expect(recovered.phase).toBe('paused')
    expect(recovered.rationale).toContain('Recovered outstanding review')
    expect(reruns).toBe(0)

    const replacement = action({ requestId: 'request-replacement' })
    const blocked = await reconstructed.review(replacement, async digest => { reruns++; return result(digest) }, unchanged)
    expect(blocked.phase).toBe('blocked')
    expect(blocked.rationale).toContain('native response intent')
    expect(reruns).toBe(0)
    expect(approved.id).toBe(recovered.id)
  })
})
