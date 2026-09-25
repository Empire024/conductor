export interface QuestionExpect { all?: string[][]; any?: string[][] }
export interface Question { id: string; kind: 'plain' | 'current' | 'research' | 'followup' | 'uncensored'; prompt: string; expect?: QuestionExpect }
export interface QuestionSet { version: number; about: string; conversations: Array<{ id: string; questions: Question[] }> }
export interface QuestionRun { answer: string; tools: Array<{ name: string; input?: string; failed?: boolean }>; stopReason?: string; phase?: string }
export interface QuestionGrade { id: string; kind: Question['kind']; pass: boolean; failures: string[]; tools: string[]; searches: number; reads: number; cited: boolean }
export const QUESTIONS_PATH: string
export function loadQuestionSet(path?: string): QuestionSet
export function gradeAnswer(question: Question, run: QuestionRun): QuestionGrade
export function summarize(grades: QuestionGrade[]): { passed: number; total: number; pass: boolean }
