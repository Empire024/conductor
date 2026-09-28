/**
 * Deterministic task categorization (docs/model-routing.md, module B): a keyword and tool
 * heuristic from a task prompt to TaskFeatures, used when nobody labelled the task. The local
 * classifier may refine it; this stays the fallback and the test oracle. First matching rule wins,
 * so the order below is the precedence.
 */
import type { TaskCategory, TaskFeatures } from '../../shared/model-routing'

export interface CategorizeInput {
  prompt: string
  tools?: string[]
  contextTokens?: number | null
  /** Attachment kinds or objects carrying one (structured-agent ContextAttachment.kind, mimeType). */
  attachments?: Array<string | { kind?: string; mimeType?: string; name?: string }>
  projectId?: string
}

export const LONG_CONTEXT_TOKENS = 100_000
const SUMMARY_CHARS = 300

const IMAGE = /\b(screenshots?|images?|photos?|pictures?|diagram image|png|jpe?g|mockups?)\b/i
const BROWSER_TOOL = /browser|playwright|puppeteer|navigate|web_?fetch|chrome/i
const RULES: Array<[TaskCategory, RegExp]> = [
  ['architecture', /\b(architect(ure|ural)?|system design|design (the|a|an) (system|service|module|api|schema)|high[- ]level design|component boundaries)\b/i],
  ['debugging', /\b(fix(es|ing)?|failing|fails|broken|bugs?|debug(ging)?|crash(es|ing)?|stack ?trace|exception|regression|doesn'?t work|not working|error)\b/i],
  ['research', /\b(research|compare (the )?(sources|options|providers|libraries|models)|find sources|literature|survey|look up|investigate options|state of the art)\b/i],
  ['review', /\b(review|audit|critique|code review|check (the|this) (diff|pr|change))\b/i],
  ['summarization', /\b(summari[sz]e|summary|tl;?dr|recap|condense|digest of)\b/i],
  ['large-repo', /\b(across the (whole )?(codebase|repo(sitory)?)|entire (codebase|repo(sitory)?)|whole (codebase|repo(sitory)?)|monorepo|every (module|package|file))\b/i],
  ['frontend', /\b(css|tailwind|react|component|jsx|tsx|ui|ux|layout|styling|frontend|front-end|renderer|button|modal|dark mode)\b/i],
  ['structured-output', /\b(json schema|return (only )?json|output (as )?json|structured output|yaml output|csv output|as a table)\b/i],
  ['file-analysis', /\b(analy[sz]e (the|this) (file|log|csv|pdf|document)|read the (log|file)|parse (the|this) (csv|log|file)|log file|spreadsheet)\b/i],
  ['terminal-use', /\b(run the command|shell|terminal|powershell|bash|cli command|install (the )?package|npm (run|install)|git (rebase|bisect|log))\b/i],
  ['tool-calling', /\b(call the tool|tool calls?|function call(ing)?|use the (tool|api))\b/i],
  ['decision', /\b(decide|choose between|should (we|i)|pick (one|the best)|approve or deny|trade-?offs?)\b/i],
  ['difficult-coding', /\b(implement|refactor|concurren(cy|t)|race condition|algorithm|optimi[sz]e|migrat(e|ion)|parser|compiler|protocol|rewrite)\b/i],
  ['simple-coding', /\b(rename|typo|add a comment|variable|one-?line|small change|tweak|bump (the )?version|update the (text|string|label)|add (a )?(field|flag|log line))\b/i],
]
const BASE: Partial<Record<TaskCategory, TaskFeatures['complexity']>> = {
  'simple-coding': 1, summarization: 2, general: 2, 'structured-output': 2, 'tool-calling': 2, 'file-analysis': 2, 'terminal-use': 2, decision: 2, vision: 2,
  frontend: 3, debugging: 3, research: 3, review: 3, 'browser-use': 3, 'long-context': 3,
  'difficult-coding': 4, architecture: 4, 'large-repo': 4,
}
const HARD = /\b(complex|hard|tricky|subtle|intermittent|flaky|concurren(cy|t)|race|distributed|security|across|entire|end[- ]to[- ]end|overnight)\b/i
const EASY = /\b(quick(ly)?|small|simple|trivial|tiny|just|typo|minor)\b/i
const HIGH_RISK = /\b(delete|drop (table|database)|rm -rf|force[- ]push|production|prod|credentials?|secrets?|payments?|deploy|publish|(cut|create|tag|ship|push|make) (a |the )?(new )?release|release (it|the build|to)|wipe|reset --hard|migrat(e|ion) (the )?(data|database))\b/i
const MEDIUM_RISK_CATEGORIES: ReadonlySet<TaskCategory> = new Set(['difficult-coding', 'large-repo', 'debugging', 'architecture', 'terminal-use', 'browser-use'])

const attachmentIsImage = (attachment: NonNullable<CategorizeInput['attachments']>[number]): boolean =>
  typeof attachment === 'string' ? /^(image|screenshot)$/i.test(attachment) : attachment.kind === 'image' || /^image\//i.test(attachment.mimeType ?? '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.name ?? '')

export function categoryOf(input: CategorizeInput): TaskCategory {
  const prompt = input.prompt ?? '', tools = input.tools ?? []
  if ((input.attachments ?? []).some(attachmentIsImage) || IMAGE.test(prompt)) return 'vision'
  if ((input.contextTokens ?? 0) > LONG_CONTEXT_TOKENS) return 'long-context'
  if (tools.some(tool => BROWSER_TOOL.test(tool)) || /\b(browser|web ?page|click (the|on)|navigate to|fill (in )?the form)\b/i.test(prompt)) return 'browser-use'
  for (const [category, pattern] of RULES) if (pattern.test(prompt)) return category
  return 'general'
}

export function categorize(input: CategorizeInput): TaskFeatures {
  const prompt = input.prompt ?? '', category = categoryOf(input)
  let complexity: number = BASE[category] ?? 2
  if (HARD.test(prompt)) complexity++
  if (prompt.length > 2_000 || (input.contextTokens ?? 0) > 50_000) complexity++
  if (EASY.test(prompt) && !HARD.test(prompt)) complexity--
  const bounded = Math.min(5, Math.max(1, complexity)) as TaskFeatures['complexity']
  const risk: TaskFeatures['risk'] = HIGH_RISK.test(prompt) ? 'high' : MEDIUM_RISK_CATEGORIES.has(category) || bounded >= 4 ? 'medium' : 'low'
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return {
    category, complexity: bounded, risk,
    toolsRequired: [...new Set(input.tools ?? [])],
    contextTokens: typeof input.contextTokens === 'number' && Number.isFinite(input.contextTokens) ? input.contextTokens : null,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(flat ? { summary: flat.length > SUMMARY_CHARS ? flat.slice(0, SUMMARY_CHARS - 1) + '…' : flat } : {}),
  }
}
