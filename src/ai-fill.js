/**
 * OFM Addition — the "let a model fill it in" half of the model parameter page.
 *
 * The page can already compute the arithmetic maximum for every route (that is
 * `topPreset`). What it cannot compute is judgement: which of two thousand
 * possible combinations suits a small fast model, a long-context reasoning
 * model, and a vision model. So this module hands a model the roster with its
 * declared capabilities and asks for one entry per route — and then treats the
 * answer as untrusted input, because it is. Every value is re-validated against
 * the same model metadata the picker uses, and anything that does not fit is
 * dropped with a reason instead of being written to disk.
 *
 * @module src/ai-fill.js
 */

import { baseEntry, declaredEfforts, isConfigured, sanitizeEntry, splitKey } from './model-params.js'

/** The instruction half of the call; the roster is the data half. */
export const AI_SYSTEM = [
  'You tune LLM request parameters inside the DeepSeek Harness (DSH).',
  'You receive a roster of routes; each line lists the thinking rungs that route declares and the',
  'output ceiling it advertises. You return one parameter entry per route, as JSON only.',
  'Hard rules:',
  '1. "effort" must be one of the rung ids listed for that exact route, or omitted entirely.',
  '2. "maxTokens" must be an integer no larger than that route\'s output ceiling, or omitted.',
  '3. "temperature" is 0 to 2 and optional; omit it unless a value is clearly better for that route.',
  '4. "stop" is an optional array of at most 4 short literal strings; omit it if unsure.',
  '5. Never invent a route, a rung id, or a number larger than the roster states.',
  'Aim for the highest quality that route can actually deliver: reasoning routes get their top',
  'rung, small or fast routes get a middle rung rather than the top one, and no route is given a',
  'setting the harness could not deliver. Output a single JSON object and nothing else.',
].join('\n')

/** One roster line: everything the model needs to judge one route. */
export function describeModelLine(row) {
  const parts = [
    `${row.key}`,
    `name=${row.name ?? row.model}`,
    `ctx=${Number.isFinite(row.contextWindow) ? row.contextWindow : '?'}`,
    `out=${Number.isFinite(row.defaultMaxTokens) ? row.defaultMaxTokens : '?'}`,
    `efforts=${(declaredEfforts(row) ?? []).join('/') || 'none'}`,
  ]
  if (typeof row.defaultEffort === 'string' && row.defaultEffort !== '') parts.push(`default=${row.defaultEffort}`)
  if (row.vision === true) parts.push('vision')
  if (row.current !== undefined && row.current !== null) parts.push(`current=${JSON.stringify(row.current)}`)
  return parts.join(' | ')
}

/**
 * Build the two strings the host sends to the tuning model.
 *
 * `current` is included per route so a re-run refines the existing settings
 * instead of overwriting them blind, and `cap` states the schema once rather
 * than making every line imply it.
 */
export function buildAiPrompt({ models, instruction = '' }) {
  const lines = (Array.isArray(models) ? models : []).map(describeModelLine)
  const user = [
    'Routes to tune (one per line):',
    ...lines,
    '',
    'Answer with exactly this JSON shape:',
    '{"entries":{"<provider|model>":{"effort":"<rung id or omit>","maxTokens":<integer or omit>,'
      + '"temperature":<0-2 or omit>,"stop":["<short string>"],"reason":"<one short sentence>"}}}',
    'You may omit any field, and you may omit a route you have no opinion about.',
    instruction === '' ? '' : `Extra instruction from the user: ${instruction}`,
  ].filter((line) => line !== '').join('\n')
  return { system: AI_SYSTEM, user }
}

/**
 * Pull one JSON object out of a model answer.
 *
 * Models wrap JSON in prose and fences even when told not to, so the fences are
 * stripped and then the first balanced object is taken. A brace count is used
 * rather than a regex because the payload contains quoted braces in reasons.
 */
export function extractJsonObject(text) {
  let value = String(text ?? '')
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null) value = fenced[1]
  const start = value.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Validate one model answer into storable entries.
 *
 * @param text - the raw model output
 * @param models - the same roster rows the prompt was built from
 * @returns `{ proposals, rejected, parsed }` — `parsed` is false when no JSON
 *   object could be read at all, which the page reports as a model failure
 *   rather than as an empty suggestion
 */
export function parseAiProposals(text, models) {
  const roster = new Map()
  for (const row of Array.isArray(models) ? models : []) roster.set(row.key, row)
  const parsed = extractJsonObject(text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { proposals: {}, rejected: [], parsed: false }
  }
  const raw = parsed.entries !== null && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
    ? parsed.entries
    : parsed
  const proposals = {}
  const rejected = []
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'entries' || key === 'reason') continue
    const route = roster.get(key)
    if (route === undefined) {
      rejected.push({ key, reason: 'unknown-route' })
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      rejected.push({ key, reason: 'not-an-object' })
      continue
    }
    const { entry, problems } = sanitizeEntry(
      {
        enabled: true,
        effort: typeof value.effort === 'string' ? value.effort : '',
        effortMode: baseEntry().effortMode,
        maxTokens: value.maxTokens,
        temperature: value.temperature,
        stop: value.stop,
        note: typeof value.reason === 'string' ? value.reason : '',
        updatedAt: 0,
      },
      { efforts: route.efforts, contextWindow: route.contextWindow },
    )
    if (isConfigured(entry) !== true) {
      rejected.push({ key, reason: problems.length > 0 ? problems.join(',') : 'empty' })
      continue
    }
    proposals[key] = entry
  }
  return { proposals, rejected, parsed: true }
}

/** Split one proposal key for display; kept here so the page shares one rule. */
export function routeOfKey(key) {
  return splitKey(key)
}
