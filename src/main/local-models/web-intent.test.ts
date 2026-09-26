import { describe, expect, it } from 'vitest'
import { LOCAL_KNOWLEDGE_YEAR, wantsWeb } from './web-intent.ts'
import { searchQuery, wantsMath } from './agent.ts'

/** Owner-style questions both ways (FX40). The first group must search before answering: its
 *  answer is after the model's training, or can change. The second must stay tool-free. */
const CURRENT = [
  // VR8c C1: answered "Max Verstappen" from memory 3/4; truth George Russell.
  'who got pole position for the azerbaijan grand prix this weekend?',
  'who won the game last night?',
  'what was the score in the arsenal match yesterday',
  'did lewis hamilton finish on the podium last weekend',
  'how did the knicks do tonight',
  'current f1 drivers standings',
  'who is leading the premier league right now',
  'who won the 2025 champions league final',
  'what happened in the stock market today',
  'whats the latest stable python version right now',
  'what is the newest llama.cpp release on github?',
  "what's new in typescript 7?",
  'is gta 6 out yet',
  'when does the next iphone come out',
  'when is the next spacex launch',
  'latest typescript release notes',
  'how much does an rtx 5090 cost',
  "what's the bitcoin price",
  'eur to usd exchange rate',
  'who is the ceo of openai',
  "who's the prime minister of the uk",
  'who runs twitter these days',
  'is jimmy carter still alive',
  "what's the weather in bratislava tomorrow",
  'any news about the eu ai act?',
  'tell me the top headlines',
  'did the fed cut rates this month?',
  'what did apple announce at wwdc this year',
  'how many points did lebron score last game',
  'find reviews of the nvidia rtx 5070 online',
  'look up the dolphin x1 8b model online',
  'can you find out online what changed in the latest typescript release and summarize it with sources?',
  'can you find some reviews of the steam deck oled online and sum up the pros and cons? include links',
  'who are the favourites for the election in october 2026',
  'results of the german election',
  'what are the box office numbers for the new marvel movie'
]
const PLAIN = [
  'whats the difference between a mutex and a semaphore? keep it short',
  'whats the difference between tcp and udp? short answer pls',
  'how many grams of butter is 1 cup',
  'explain mortgage APR vs interest rate',
  'fix the failing test in src/app.ts',
  'how do I compute a z-score in python',
  'what is the time complexity of quicksort',
  'write a haiku about autumn',
  'convert 72 fahrenheit to celsius',
  'what does HTTP status 418 mean',
  'how does qualifying work in formula 1',
  'what is a grand prix',
  'who wrote pride and prejudice',
  'who was the first president of the united states',
  'who won the 1966 world cup',
  'who won world war 2',
  'summarize README.md',
  'refactor this function to use async/await',
  "what's the capital of australia",
  'how do vaccines work',
  'explain how pole vaulting works',
  'give me a regex that matches an email address',
  'what is 15% of 240',
  'translate good morning into german',
  'why is the sky blue',
  'plan a weekend trip to rome for me',
  'what happened in 1989 in berlin',
  'look at the latest commit and tell me what it changed',
  'review my changes in src/app.ts',
  'explain how the stock market works',
  'how do I deal with merge conflicts',
  'what does the latest field in package.json do'
]

describe('whether a message needs the web (web-intent.ts)', () => {
  it('sends a question whose answer is after the training or can change to the web first', () => {
    expect(CURRENT.length + PLAIN.length).toBeGreaterThanOrEqual(40)
    const missed = CURRENT.filter(question => !wantsWeb(question))
    expect(missed).toEqual([])
  })
  it('keeps plain knowledge, history and workspace questions tool-free', () => {
    const pushed = PLAIN.filter(question => wantsWeb(question))
    expect(pushed).toEqual([])
  })
  it('treats any year from the training cutoff on as something the model cannot know', () => {
    expect(wantsWeb(`what happened at ces ${LOCAL_KNOWLEDGE_YEAR}`)).toBe(true)
    expect(wantsWeb(`what happened at ces ${LOCAL_KNOWLEDGE_YEAR - 3}`)).toBe(false)
    // A later model moves the line.
    expect(wantsWeb('who won the 2025 champions league final', 2026)).toBe(false)
  })
  it('dates a search Conductor runs itself for a time-relative question', () => {
    const now = new Date(2026, 8, 26)
    expect(searchQuery('who got pole position for the azerbaijan grand prix this weekend?', now)).toBe('who got pole position for the azerbaijan grand prix this weekend 2026')
    expect(searchQuery('whats the latest stable python version right now', now)).toBe('whats the latest stable python version 2026')
    expect(searchQuery('who won the 2025 champions league final last night', now)).not.toContain('2026')
    expect(searchQuery('any news about the eu ai act?', now)).toBe('any news about the eu ai act')
  })
})

describe('whether a message asks for numbers to be worked out', () => {
  it('recognizes sums, totals and merges over data, not code or dispatch', () => {
    for (const ask of ['Read jan.csv with read_file. Add up the amount for each category. Then call the conductor tool with method agents.report', 'Using only the two reports your coworkers sent, give the total per category for January and February together, and say which category grew the most from January to February.', 'what is the average of 12, 15 and 19', 'sum the amounts in expenses.csv by month'])
      expect(wantsMath(ask), ask).toBe(true)
    for (const plain of ['merge the feature branch into main', 'fix the total in src/cart.ts', 'whats the difference between a mutex and a semaphore? keep it short', 'You control a small swarm of coworkers. Use the conductor tool with method tabs.open twice: 1. args {"title": "January", "prompt": "Read jan.csv. Add up the amount for each category."}', 'who got pole position for the azerbaijan grand prix this weekend?'])
      expect(wantsMath(plain), plain).toBe(false)
  })
})
