import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConductorDatabase } from '../database'
import { ScheduleStore } from '../schedule-store'
import { LATEST_MODEL_SOURCES, LatestModelsJob } from './latest-models'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-latest-models-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Models'), store = new ScheduleStore(path)
  const schedule = store.create({ projectId: project.id, jobId: 'latest-models-methods' })
  cleanup.push(() => { store.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, project, schedule }
}
const html = (suffix = '') => `<html><body><main>${'Official model documentation with supported methods and capabilities. '.repeat(3)}${suffix}</main></body></html>`

describe('LatestModelsJob', () => {
  it('uses conditional primary-source reads and performs no agent submission when unchanged', async () => {
    const f = fixture(), submit = vi.fn(), steerAccepted = vi.fn()
    let pass = 0
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const source = LATEST_MODEL_SOURCES.find(item => item.url === String(url))!
      if (pass >= LATEST_MODEL_SOURCES.length) {
        expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"')
        return new Response(null, { status: 304, headers: { etag: '"v1"' } })
      }
      pass++
      return new Response(html(), { status: 200, headers: { etag: '"v1"', 'content-type': 'text/html' } })
    }) as typeof globalThis.fetch
    const job = new LatestModelsJob({ store: f.store, artifactDirectory: join(f.root, 'evidence'), fetch: fetchMock,
      catalog: () => ({ workspaces: [], targets: [], providers: [{ provider: 'codex', available: true, source: 'configured', permissions: [], models: [{ id: 'gpt-6-astra', label: 'Astra' }] }] }) })
    const first = await job.run({ schedule: f.schedule, now: new Date('2026-09-21T10:00:00Z'), signal: new AbortController().signal })
    expect(first).toMatchObject({ outcome: 'changed', artifactPath: expect.stringContaining('evidence') })
    const second = await job.run({ schedule: f.schedule, now: new Date('2026-09-21T11:00:00Z'), signal: new AbortController().signal })
    expect(second).toMatchObject({ outcome: 'unchanged', detail: expect.stringContaining('No agent turn') })
    expect(submit).not.toHaveBeenCalled(); expect(steerAccepted).not.toHaveBeenCalled()
  })

  it('rejects redirects and oversized bodies instead of storing unvalidated evidence', async () => {
    const f = fixture()
    const redirect = new LatestModelsJob({ store: f.store, artifactDirectory: f.root, catalog: () => ({ workspaces: [], targets: [], providers: [] }),
      fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } })) as typeof globalThis.fetch })
    await expect(redirect.run({ schedule: f.schedule, now: new Date(), signal: new AbortController().signal })).rejects.toThrow('No remote primary source')

    let cancelled=false
    const oversized = new LatestModelsJob({ store: f.store, artifactDirectory: f.root, catalog: () => ({ workspaces: [], targets: [], providers: [] }),
      fetch: vi.fn(async () => new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(200_000));controller.enqueue(new Uint8Array(100_000))},cancel(){cancelled=true}}), { status: 200 })) as typeof globalThis.fetch })
    await expect(oversized.run({ schedule: f.schedule, now: new Date(), signal: new AbortController().signal })).rejects.toThrow('No remote primary source')
    expect(cancelled).toBe(true)
  })

  it('keeps usable source results when one allowlisted primary source is unavailable', async () => {
    const f=fixture()
    const job=new LatestModelsJob({store:f.store,artifactDirectory:join(f.root,'evidence'),catalog:()=>({workspaces:[],targets:[],providers:[]}),fetch:vi.fn(async url=>{
      if(String(url).includes('developers.openai.com'))throw new Error('offline')
      return new Response(html(String(url)),{status:200})
    }) as typeof globalThis.fetch})
    const result=await job.run({schedule:f.schedule,now:new Date(),signal:new AbortController().signal})
    expect(result).toMatchObject({outcome:'changed',detail:expect.stringContaining('Warning: openai-models')})
    expect(f.store.source(f.schedule.id,'openai-models')).toBeNull()
    expect(f.store.source(f.schedule.id,'anthropic-models')).not.toBeNull()
  })
})
