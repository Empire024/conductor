import cliCatalogs from './cli-catalogs.mjs?raw'
import conductorPins from './conductor-pins.mjs?raw'
import primarySources from './primary-sources.mjs?raw'
import compatibilityReport from './compatibility-report.mjs?raw'
import offlineTests from './offline-tests.mjs?raw'
import type { ScheduleScriptFormat, ScheduleScriptRunWhen, ScheduleTiming } from '../../../shared/schedules'

export interface BuiltinScheduleScript { name: string; description: string; language: 'node'; format: ScheduleScriptFormat; runWhen: ScheduleScriptRunWhen; timeoutSec: number; order: number; content: string }
export interface BuiltinScheduleSpec { kind: 'latest-models-methods'; name: string; prompt: string; everyMinutes: number; timing: ScheduleTiming; brain: boolean; timeoutMs: number; scripts: BuiltinScheduleScript[] }

/** Goal for the assigned frontier agent. It receives this with the (summarized) script output,
 *  once, only when some output changed or failed. */
const PROMPT = [
  'Keep Conductor working with the Claude Code and Codex CLIs installed on this machine and with the models they currently offer.',
  'The evidence is this task\'s script output: what the installed CLIs advertise (cli-catalogs), what Conductor hard-codes (conductor-pins), the model ids on the providers\' own pages (primary-sources), the computed findings with proposed edits (compatibility-report) and, when something moved, the offline test results (offline-tests).',
  'Answer from that evidence only, with no speculation, in at most about 400 words:',
  '1. What changed: CLI versions, models added or removed, what an alias now resolves to, new ids on the primary pages.',
  '2. What could break in Conductor and why: a CLI version Conductor refuses or has not verified, a catalog id the CLI no longer offers, a label naming the wrong version, a hard-coded id, a stale fixture, a failing offline test.',
  '3. The exact edits, one per line as file, constant, old -> new. Start from the report\'s proposedEdit entries; correct or drop any the evidence does not support.',
  '4. Which tests to run (the report\'s relevantTests) and whether the offline tests already fail.',
  'If nothing needs doing, say so in one sentence. Do not edit files or run anything; this answer is for the owner.'
].join('\n')

const script = (order: number, name: string, description: string, content: string, timeoutSec: number, runWhen: ScheduleScriptRunWhen = 'always'): BuiltinScheduleScript =>
  ({ name, description, language: 'node', format: 'json', runWhen, timeoutSec, order, content })

export const LATEST_MODELS_BUILTIN: BuiltinScheduleSpec = {
  kind: 'latest-models-methods',
  name: 'Latest models and CLI compatibility',
  prompt: PROMPT,
  everyMinutes: 1_440,
  timing: 'night',
  brain: true,
  timeoutMs: 30 * 60_000,
  scripts: [
    script(1, 'cli-catalogs', 'Versions and model catalogs the installed Claude Code (initialize) and Codex (app-server model/list) advertise; no inference.', cliCatalogs, 180),
    script(2, 'conductor-pins', 'Catalogs, version pins, effort ladders, fixtures and hard-coded model ids in the Conductor checkout, read from source text.', conductorPins, 30),
    script(3, 'primary-sources', 'Model ids and release facts from the OpenAI, Anthropic, llama.cpp and Qwen primary sources (conditional GET, cached).', primarySources, 90),
    script(4, 'compatibility-report', 'Findings with proposed edits: CLI versus Conductor pins, fixtures and primary sources.', compatibilityReport, 30),
    script(5, 'offline-tests', 'The offline vitest files the report names, run only when something moved.', offlineTests, 900, 'changed')
  ]
}
