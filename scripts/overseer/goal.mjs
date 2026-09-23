import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { CHECKOUT, isInside } from './util.mjs'

const isString = value => typeof value === 'string' && value.trim().length > 0
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string')

/** Every problem in a goal spec, as human-readable strings. Empty means valid. */
export function validateGoal(goal) {
  const errors = []
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return ['goal must be a JSON object']
  if (!isString(goal.id) || !/^[a-z0-9][a-z0-9._-]*$/i.test(goal.id)) errors.push('id must be a non-empty slug of letters, digits, ".", "_" or "-"')
  if (!isString(goal.title)) errors.push('title is required')
  if (!isString(goal.prompt)) errors.push('prompt is required')
  const project = goal.project
  if (!project || typeof project !== 'object') errors.push('project is required')
  else {
    if (!isString(project.name) || /[\\/:*?"<>|]/.test(project.name)) errors.push('project.name must be a plain folder name')
    if (!isString(project.path) || !isAbsolute(project.path)) errors.push('project.path must be an absolute path')
    if (project.inputs !== undefined && !stringArray(project.inputs)) errors.push('project.inputs must be an array of file names')
    else for (const input of project.inputs ?? []) if (isAbsolute(input) || input.split(/[\\/]/).includes('..')) errors.push(`project.inputs entry ${JSON.stringify(input)} must be relative to project.path`)
  }
  const worker = goal.worker
  if (!worker || typeof worker !== 'object') errors.push('worker is required')
  else {
    if (!isString(worker.provider)) errors.push('worker.provider is required')
    if (!isString(worker.model)) errors.push('worker.model is required')
    if (worker.provider === 'local' && worker.permission !== 'accept-edits') errors.push('a local worker needs worker.permission "accept-edits"')
  }
  if (goal.timeoutMinutes !== undefined && !(typeof goal.timeoutMinutes === 'number' && goal.timeoutMinutes > 0)) errors.push('timeoutMinutes must be a positive number')
  const success = goal.success
  if (!success || typeof success !== 'object') errors.push('success is required')
  else {
    for (const key of ['phases', 'stopReasons', 'answerMatches', 'answerRejects']) if (success[key] !== undefined && !stringArray(success[key])) errors.push(`success.${key} must be an array of strings`)
    for (const key of ['answerMatches', 'answerRejects']) for (const pattern of success[key] ?? []) { try { new RegExp(pattern) } catch (error) { errors.push(`success.${key} has an invalid pattern ${JSON.stringify(pattern)}: ${error.message}`) } }
    if (success.requireValidatedArtifact !== undefined && typeof success.requireValidatedArtifact !== 'boolean') errors.push('success.requireValidatedArtifact must be boolean')
    if (success.maxLoopWarnings !== undefined && !(Number.isInteger(success.maxLoopWarnings) && success.maxLoopWarnings >= 0)) errors.push('success.maxLoopWarnings must be a non-negative integer')
    if (success.oracle !== undefined && !isString(success.oracle)) errors.push('success.oracle must be a path')
  }
  const fixer = goal.fixer
  if (fixer !== undefined) {
    if (!fixer || typeof fixer !== 'object') errors.push('fixer must be an object')
    else {
      if (fixer.provider !== undefined && fixer.provider !== 'claude') errors.push('fixer.provider must be "claude"')
      if (fixer.project !== undefined && (!isString(fixer.project) || !isAbsolute(fixer.project))) errors.push('fixer.project must be an absolute path')
      if (fixer.focus !== undefined && !stringArray(fixer.focus)) errors.push('fixer.focus must be an array of strings')
      if (fixer.timeoutMinutes !== undefined && !(typeof fixer.timeoutMinutes === 'number' && fixer.timeoutMinutes > 0)) errors.push('fixer.timeoutMinutes must be a positive number')
    }
  }
  return errors
}

/** Defaults applied after validation, so the rest of the overseer never re-checks presence. */
export function normalizeGoal(goal, source) {
  return {
    ...goal,
    source,
    timeoutMinutes: goal.timeoutMinutes ?? 25,
    project: { ...goal.project, inputs: goal.project.inputs ?? [] },
    success: { phases: ['completed'], ...goal.success },
    fixer: { provider: 'claude', model: 'opus', project: CHECKOUT, focus: [], notes: '', timeoutMinutes: 60, ...goal.fixer }
  }
}

export async function loadGoal(path) {
  const source = resolve(path)
  let goal
  try { goal = JSON.parse((await readFile(source, 'utf8')).replace(/^﻿/, '')) } catch (error) {
    throw new Error(`goal ${path}: ${error.code === 'ENOENT' ? 'file not found' : `not valid JSON (${error.message})`}`)
  }
  const errors = validateGoal(goal)
  if (errors.length) throw new Error(`goal ${path} is invalid:\n  - ${errors.join('\n  - ')}`)
  return normalizeGoal(goal, source)
}

/**
 * The folder the worker runs in. For the dev target a fresh copy of the inputs under the dev
 * projects root, so every iteration starts from the same bytes; for the installed target the
 * owner's real folder, untouched.
 */
export async function prepareProjectFolder(goal, { target, projectsRoot }) {
  if (target === 'installed') return goal.project.path
  const folder = join(projectsRoot, goal.project.name)
  if (!isInside(projectsRoot, folder) || resolve(folder) === resolve(projectsRoot)) throw new Error(`refusing to prepare ${folder} outside ${projectsRoot}`)
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true })
  for (const input of goal.project.inputs) {
    const from = resolve(goal.project.path, input)
    const to = resolve(folder, input)
    await mkdir(resolve(to, '..'), { recursive: true })
    try { await copyFile(from, to) } catch (error) { throw new Error(`cannot copy input ${input} from ${goal.project.path}: ${error.message}`) }
  }
  await rm(join(folder, '.conductor-scratch'), { recursive: true, force: true })
  return folder
}

export const goalLabel = goal => `${goal.id} (${basename(goal.source ?? goal.id)})`
