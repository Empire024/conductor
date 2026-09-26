/** Whether an owner's message needs the web before a local model answers it.
 *
 *  A small model decides this badly on its own: its memory is stale and it does not know it, so
 *  Dolphin answered "latest Python" with 3.12 from 2023 and "who got pole position ... this
 *  weekend?" with a driver from its training data. A message this returns true for starts with a
 *  forced web search (agent.ts). The decision is made from what kind of answer the message asks
 *  for rather than from a word list:
 *
 *  1. The owner asked for the web (online, look it up, with sources): always.
 *  2. A message about the workspace (files, code, tests, commits) is answered from the workspace.
 *  3. Time relative to now (this weekend, last night, tomorrow, latest, so far this season) or a
 *     date the model cannot know (a year from its training cutoff on): the answer is after its
 *     training by construction.
 *  4. Otherwise an answer that can change over time: results and scores, standings, who holds an
 *     office or leads a company, prices and markets, releases and versions, news, weather. Unless
 *     the message is about history (a year before the cutoff, a war, "the first president") or is
 *     a general-knowledge question (explain, how does, what is the difference), which the model
 *     answers from what it knows.
 *
 *  Generous on purpose: a false positive costs one search, a false negative a confidently outdated
 *  answer. The unit table in web-answers.test.ts holds owner-style questions both ways. */

/** The first year a local model's training cannot cover. Dolphin X1 8B is a Llama 3.1 fine-tune
 *  (training data to about the end of 2023); a newer model only moves this later. */
export const LOCAL_KNOWLEDGE_YEAR = 2024

const EXPLICIT = /\b(?:online|on the (?:web|internet|net)|look(?:ing)? (?:it |this |that |them |these |those )?up|search (?:for|the web|online|the internet|it)|google|browse|find (?:me |out |info|reviews?|articles?|sources?|links?)|with (?:sources|links|citations|references)|cite (?:your |the )?sources|reviews|review of (?:the )?(?!code|changes?|diff|pr|pull|file|function|this|my)\w)/i

// A bare "name.js" or "llama.cpp" is as often a product as a file, so those extensions count only
// in a path; the rest are files wherever they appear.
const WORKSPACE = /(?:\b[\w.-]+\.(?:ts|tsx|jsx|mjs|cjs|py|json|ya?ml|toml|md|css|html|sql|sh|ps1|lock|csv|tsv|txt|log)\b|[\w.-]*\/[\w./-]*\.(?:js|rs|go|java|cs|cpp|c|h)\b|\b(?:src|lib|test|tests|scripts)\/|\b(?:commits?|branch(?:es)?|diffs?|stack ?trace|pull request|the (?:tests?|build|repo(?:sitory)?|workspace|codebase|project|function|file|folder|directory|script|logs?|error|bug)|my (?:code|project|repo|changes|files?|script|tests?)|this (?:code|project|repo|file|function|script|error|bug|test))\b)/i

const TIME_RELATIVE = /\b(?:today|tonight|tomorrow|yesterday|right now|nowadays|these days|currently|at the moment|as of (?:now|today|this)|so far (?:this|in)|lately|recent(?:ly)?|latest|newest|upcoming|what time is it|current time|this (?:morning|afternoon|evening|week(?:end)?|month|year|season|quarter|spring|summer|autumn|fall|winter|round)|last (?:night|week(?:end)?|month|year|season|quarter|game|match|race|round|episode|election|night's|weekend's)|past (?:week|month|few (?:days|weeks|months))|next (?:week(?:end)?|month|year|season|game|match|race|election|release|launch|episode|round)|(?:earlier|later) (?:today|this week))\b/i

const CHANGEABLE: RegExp[] = [
  // Results, scores and standings.
  /\bwho (?:won|wins|win|is winning|leads|is leading|scored|took|got|claimed|clinched|finished|topped|qualified|beat|lost)\b/i,
  /\bwhich \w+(?: \w+)? (?:won|wins|is winning|leads|scored|got|took|finished)\b/i,
  /\b(?:what(?:'s| is| was) the (?:final )?score|final score|half-?time score|scores? (?:of|in|from) (?:the |last |tonight|yesterday))/i,
  /\bresults? (?:of|for|from|in) (?:the )?(?:[\w-]+ ){0,4}(?:election|race|game|match|grand prix|gp|vote|referendum|primary|tournament|championship|final|qualifying|draw|lottery)\b/i,
  /\b(?:standings|leaderboard|league table|world rankings?|rankings|pole position|pole sitter|on pole|podium|fastest lap|box office|transfer news|line-?ups?|fixtures|election results|opinion polls?)\b/i,
  /\bhow did (?:the )?[\w.-]+(?: [\w.-]+){0,2} (?:do|play|perform|finish|fare)\b/i,
  /\bwho(?:'s| is) (?:ahead|leading|favou?red|favou?rite|playing|headlining|in the lead)\b/i,
  // Who holds an office, runs a company, is still alive.
  /\bwho(?:'s| is| are)\b[^?.!]*\b(?:president|prime minister|premier|chancellor|ceo|cto|cfo|coo|chair(?:man|woman|person)?|head coach|coach|manager|captain|leader|mayor|governor|king|queen|monarch|pope|minister|secretary|director|owner|champion|richest|number one|no\.? ?1)\b/i,
  /\bwho (?:runs|owns|leads|heads|coaches|manages|chairs|bought|acquired)\b/i,
  /\b(?:still (?:alive|open|in (?:office|charge|business)|available|the (?:ceo|president|champion|leader|best|fastest|cheapest))|is [\w .'-]{2,40} (?:alive|dead)|did [\w .'-]{2,40} die|has [\w .'-]{2,40} died|net worth)\b/i,
  // Prices and markets.
  /\b(?:prices?|pricing|cheapest|best deals?|on sale|stock price|stock market|stocks|share price|market cap|exchange rate|bitcoin|btc|ethereum|crypto(?:currency)?|inflation rate|mortgage rates|gas prices|fuel prices)\b/i,
  /\bhow much (?:does|do|is|are|did|would|will) (?:an? |the |one )?(?![\d.,%]+\b)[a-z][^?]*\b(?:cost|costs|go for|sell for|retail)\b/i,
  /\bhow much is (?:an? |the |one )[a-z]/i,
  /\binterest rates? (?:today|now|currently|in [a-z])/i,
  // Releases and versions.
  /\b(?:(?:latest|newest|current|last) (?:stable )?(?:version|release|model|update|build|patch|episode|season|album|iphone|gpu)|what(?:'s| is) new in|release (?:date|notes)|changelog|(?:came|coming|come) out|out yet|been released|launch(?:ed|es)?|announce(?:d|ments?)|is [\w .'-]{2,40} (?:out|available|released)\b)/i,
  /\bwhen (?:is|does|will|do|are|did)\b[^?]*\b(?:release|launch|start|begin|open|come out|air|premiere|arrive|ship)\b/i,
  // News, weather, outages.
  /\b(?:news|headlines?|weather|forecast|temperature (?:in|at|today|tomorrow|outside)|traffic (?:in|on|at)|outage|is [\w.]+ down|breaking)\b/i
]

const HISTORY = /\b(?:world war|civil war|cold war|revolution|dynasty|empire|ancient|medieval|centur(?:y|ies)|in history|historically|first (?:ever )?(?:president|prime minister|man|person|woman|king|queen)|who (?:was|were) the)\b/i

const KNOWLEDGE_FORM = /^\s*(?:(?:hey |ok |so )?(?:can you |could you |please |pls )?(?:explain|define|describe|teach me|help me understand)\b|what(?:'s| is| are) (?:the )?(?:difference|differences|meaning|definition|purpose)\b|what does\b|how (?:does|do|to|can|would|should|is)\b|why (?:does|do|is|are|did)\b)/i

const YEARS = /\b(1[89]\d\d|2[01]\d\d)\b/g

export function wantsWeb(instruction: string, knowledgeYear = LOCAL_KNOWLEDGE_YEAR): boolean {
  const text = instruction.replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (EXPLICIT.test(text)) return true
  if (WORKSPACE.test(text)) return false
  const years = [...text.matchAll(YEARS)].map(match => Number(match[1]))
  if (TIME_RELATIVE.test(text) || years.some(year => year >= knowledgeYear)) return true
  if (years.length || HISTORY.test(text) || KNOWLEDGE_FORM.test(text)) return false
  return CHANGEABLE.some(pattern => pattern.test(text))
}

/** Whether the message asks for something time-relative, so a search built from it needs the
 *  date: "this weekend" means nothing to a search engine without the year. */
export const timeRelative = (instruction: string): boolean => TIME_RELATIVE.test(instruction)
