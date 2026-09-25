/** Direct probe of the owner-style question set (questions.json) against a running local
 *  llama.cpp server, through the real LocalAgentSession and tools but without Electron. For
 *  iterating on the prompt and tools quickly; the evidence run is the parked app one,
 *  scripts/smoke-local-questions.mjs.
 *    npm run local -- start --model local/dolphin-x1-8b --fast
 *    node --experimental-transform-types scripts/local-models/question-eval.ts --model local/dolphin-x1-8b [--research] [--only Q4,Q8]
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig, readApiKey, endpointFor } from '../../src/main/local-models/config.ts'
import { DockerSandbox } from '../../src/main/local-models/sandbox.ts'
import { LocalAgentSession } from '../../src/main/local-models/agent.ts'
import { gradeAnswer, loadQuestionSet, summarize } from './question-set.mjs'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined }
const modelId = flag('model') ?? 'local/dolphin-x1-8b'
const only = flag('only')?.split(',')
const research = argv.includes('--research')
const pace = Number(flag('pace') ?? 20)
const config = loadConfig()
const model = config.models[modelId]
if (!model) throw new Error(`Unknown local model ${modelId}`)
const root = await mkdtemp(join(tmpdir(), 'conductor-question-eval-'))
await writeFile(join(root, 'README.md'), '# Scratch project\n')
const output = resolve(flag('out') ?? 'artifacts/local-questions')
await mkdir(output, { recursive: true })
const sandbox = new DockerSandbox('question-eval-' + Date.now(), root, config.sandbox)
const set = loadQuestionSet()
const grades: ReturnType<typeof gradeAnswer>[] = []
const transcript: unknown[] = []
try {
  for (const conversation of set.conversations) {
    const questions = conversation.questions.filter((question: { id: string }) => !only || only.includes(question.id))
    if (!questions.length) continue
    const session = new LocalAgentSession({ endpoint: endpointFor(model), apiKey: readApiKey(), model: model.id, workspace: root, sandbox, readOnly: false, grants: { git: false, research }, timeoutSec: 60, contextTokens: model.contextTokens })
    for (const question of questions) {
      // Owner pace: a person does not send nine questions a minute, and the search engine
      // throttles a burst that fast (web.ts, SEARCH_ENGINES).
      if (grades.length && pace) await new Promise(done => setTimeout(done, pace * 1000))
      const tools: Array<{ name: string; input: string; failed?: boolean; output?: string }> = []
      const notices: string[] = []
      const started = Date.now()
      const outcome = await session.run(question.prompt, {
        toolStart: call => { tools.push({ name: call.name, input: call.input }); process.stdout.write(`  ${question.id} ${call.name} ${call.input.slice(0, 120)}\n`) },
        toolEnd: call => { const tool = tools.at(-1); if (tool) { tool.failed = call.failed; tool.output = call.output.slice(0, 300) } },
        notice: message => notices.push(message)
      }, AbortSignal.timeout(300_000))
      const grade = gradeAnswer(question, { answer: outcome.text, tools, stopReason: outcome.stopReason })
      grades.push(grade)
      transcript.push({ id: question.id, prompt: question.prompt, answer: outcome.text, stopReason: outcome.stopReason, elapsedMs: Date.now() - started, tools, notices, grade })
      console.log(`[${question.id}] ${grade.pass ? 'PASS' : 'FAIL'} ${(Date.now() - started) / 1000}s tools=${grade.tools.join(',') || '-'} ${grade.failures.join('; ')}\n  ${outcome.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
  }
} finally {
  await sandbox.stop()
  const file = join(output, `${modelId.replace(/\W+/g, '-')}${research ? '-research' : ''}-${Date.now()}.json`)
  await writeFile(file, JSON.stringify({ model: modelId, research, summary: summarize(grades), transcript }, null, 2))
  console.log(JSON.stringify(summarize(grades)), file)
}
