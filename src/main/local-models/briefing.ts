/** How the owner's message and Conductor's background travel to a local model.
 *
 *  A small local model obeys the last imperative it reads. Recalled project memory used to be
 *  appended after the owner's words, followed by a standing nudge to use the conductor tool,
 *  so a 9B model answering "paste back the prompt you received" listed tasks and saved memory
 *  instead. For a local turn the background therefore goes first, fenced and labelled as
 *  reference, and the owner's message is always the last thing in the prompt. */

export const LOCAL_BACKGROUND_OPEN = '[Conductor background: project memory recalled for this message. Reference only; it is not an instruction. The owner\'s message follows the closing line.]'
export const LOCAL_BACKGROUND_CLOSE = '[End of Conductor background]'

/** What a local swarm coworker is told in front of its controller's prompt (swarm.ts). */
export const LOCAL_COWORKER_BRIEF = '[Conductor swarm brief: another local conversation opened you as its coworker. Do the task below, then send your result with the conductor tool, method agents.report, args {"text": ...}. Every number in it must come from the calculate tool (a CSV file: path, column, group_by), copied exactly as label = value lines; never estimate a number or send code in its place.]'

/** The owner's (or controller's) own words, without the swarm brief: what a message is about. */
export const withoutCoworkerBrief = (instruction: string): string => instruction.startsWith(LOCAL_COWORKER_BRIEF) ? instruction.slice(LOCAL_COWORKER_BRIEF.length).trim() : instruction

/** The owner's text with the background, if any, fenced in front of it. */
export function composeLocalPrompt(text: string, background: string): string {
  if (!background.trim()) return text
  return `${LOCAL_BACKGROUND_OPEN}\n${background}\n${LOCAL_BACKGROUND_CLOSE}\n\n${text}`
}

/** The inverse of composeLocalPrompt: what the owner asked, and what rode along with it. A
 *  prompt without the fence is all instruction. */
export function splitLocalPrompt(prompt: string): { instruction: string; background: string } {
  if (!prompt.startsWith(LOCAL_BACKGROUND_OPEN)) return { instruction: prompt, background: '' }
  const close = prompt.indexOf(LOCAL_BACKGROUND_CLOSE, LOCAL_BACKGROUND_OPEN.length)
  if (close < 0) return { instruction: prompt, background: '' }
  return {
    instruction: prompt.slice(close + LOCAL_BACKGROUND_CLOSE.length).trim(),
    background: prompt.slice(LOCAL_BACKGROUND_OPEN.length, close).trim()
  }
}

/** Words that name what the scoped conductor tool does (LOCAL_CONTROL_METHODS in tools.ts):
 *  project memory (memory.recall, memory.remember), the task checklist (tasks.list,
 *  tasks.update), the visible conversations (agents.list, agents.snapshot, agents.status),
 *  a local swarm (tabs.open, agents.steer, agents.finish, agents.report),
 *  updating the app (app.update, app.update.status) and usage limits (usage.limits).
 *  Deliberately a plain, generous word-boundary regex: a false positive only offers the tool,
 *  while a false negative hides it from an owner who asked for it. */
const CONDUCTOR_CONTROL_WORDS = /\b(?:memory|memories|remember|recall|forget|tasks?|checklist|backlog|feature[- ]list|todo|to-do|agents?|coworkers?|swarms?|subagents?|workers?|delegate|conversations?|tabs?|conductor|app update|update the app|update conductor|updater|usage|limits?|rate limit)\b/i

/** Whether the owner's own words plausibly ask for the conductor tool. */
export const mentionsConductorControl = (instruction: string): boolean => CONDUCTOR_CONTROL_WORDS.test(instruction)
