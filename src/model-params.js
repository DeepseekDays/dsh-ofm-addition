/**
 * OFM Addition — per-model request parameters.
 *
 * One route can be told, once, how it should be called: which reasoning rung,
 * how large an output ceiling, what sampling temperature, and which stop
 * sequences. The harness carries all four on `LlmCallConfig`, and the plugin
 * writes them at the last seam before dispatch (`agent/request`), so a stored
 * preference reaches the wire on the next request without a restart.
 *
 * Two rules shape everything here:
 *
 * 1. **A route with no entry is never touched.** The plugin is an add-on, so
 *    its blast radius is exactly the set of routes a person configured. An
 *    empty document means this feature is inert.
 * 2. **An entry owns all four fields, including their absence.** Stored
 *    parameters are re-applied on every request, and a field the entry leaves
 *    empty is *deleted* from the config instead of being left alone: the value
 *    a previous request recorded would otherwise come back as the session's own
 *    choice, and "restore the model default" would be impossible to express.
 *    Deleting also lets the adapter materialize its own default, which the
 *    harness then marks `adapterDefaults` — the flag that keeps that value out
 *    of the session's remembered selection.
 *
 * @module src/model-params.js
 */

/** Provider patterns that make up "Our Free Model" when nothing is stored. */
export const DEFAULT_SCOPE = Object.freeze(['our-free-model*'])

/** The request fields one entry owns; also the order they are reported in. */
export const PARAM_FIELDS = Object.freeze(['reasoningEffort', 'maxTokens', 'temperature', 'stop'])

/**
 * How a stored rung relates to a rung the session already selected.
 *
 * `preset` is the default and the honest reading of "this is what the model
 * runs with": the stored value is written even when the session picked one, so
 * the page and the wire agree. `session` defers to a pick made in the model
 * picker and only fills the rung when the session has none.
 */
export const EFFORT_MODE = Object.freeze({ PRESET: 'preset', SESSION: 'session' })

export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2
export const MAX_STOP_SEQUENCES = 8
export const MAX_STOP_LENGTH = 128
export const MAX_NOTE_LENGTH = 200
/** A stored ceiling the page will accept; the adapter clamps again on the wire. */
export const MAX_TOKENS_CEILING = 2_000_000
/** Guards against a hand-edited document growing without bound. */
export const MAX_ENTRIES = 2000
export const MAX_SCOPE_PATTERNS = 20

/**
 * An entry that owns nothing: every field is at the model's own default.
 *
 * This is a real, storable state rather than an absent one. Keeping the row
 * means the next request still clears the fields a previous request recorded,
 * which is what makes "restore the model default" finish the job instead of
 * leaving the last value pinned in the session.
 */
export function baseEntry() {
  return {
    /** `false` = the row exists to restore defaults, and owns nothing else. */
    enabled: false,
    /** Declared effort id, or `''` for "let the model decide". */
    effort: '',
    effortMode: EFFORT_MODE.PRESET,
    /** Output-token ceiling, or `null` for the adapter default. */
    maxTokens: null,
    temperature: null,
    stop: [],
    note: '',
    updatedAt: 0,
  }
}

/** Does this entry ask for anything, or is it only here to restore defaults? */
export function isConfigured(entry) {
  if (entry === null || entry === undefined) return false
  return entry.effort !== '' || entry.maxTokens !== null || entry.temperature !== null
    || (Array.isArray(entry.stop) && entry.stop.length > 0)
}

/** The document key for one route. */
export function entryKeyOf(provider, model) {
  return `${String(provider ?? '')}|${String(model ?? '')}`
}

/** Split one route key back into its halves; a key without `|` has no model. */
export function splitKey(key) {
  const at = String(key ?? '').indexOf('|')
  if (at < 0) return { provider: String(key ?? ''), model: '' }
  return { provider: String(key ?? '').slice(0, at), model: String(key ?? '').slice(at + 1) }
}

/** One pattern list: newline or comma separated, trimmed, deduped, bounded. */
export function normalizeScope(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const out = []
  for (const raw of list) {
    const pattern = String(raw ?? '').trim()
    if (pattern === '' || out.includes(pattern)) continue
    out.push(pattern.slice(0, 120))
    if (out.length >= MAX_SCOPE_PATTERNS) break
  }
  return out.length > 0 ? out : [...DEFAULT_SCOPE]
}

/** Does one provider id belong to the configured scope? `*` wildcards honored. */
export function providerInScope(patterns, provider) {
  const list = normalizeScope(patterns)
  return list.some((pattern) => matches(pattern, provider))
}

/** Glob with a single `*` wildcard, the same shape the scope allow-lists use. */
function matches(pattern, value) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const [head, ...tail] = pattern.split('*')
  const rest = tail.join('*')
  if (!String(value).startsWith(head)) return false
  if (rest === '') return true
  return String(value).slice(head.length).endsWith(rest)
}

/** Human-readable parameter summary, used by the settings page and the log. */
export function describeEntry(entry, facts) {
  if (isConfigured(entry) !== true) return 'model defaults'
  const parts = []
  if (entry.effort !== '') parts.push(`effort ${entry.effort}`)
  if (entry.maxTokens !== null) parts.push(`max ${entry.maxTokens}`)
  if (entry.temperature !== null) parts.push(`temp ${entry.temperature}`)
  if (Array.isArray(entry.stop) && entry.stop.length > 0) parts.push(`stop ${entry.stop.length}`)
  const suffix = entry.effortMode === EFFORT_MODE.SESSION ? ' (session pick wins)' : ''
  return parts.join(', ') + suffix
}

/**
 * Effort ids one resolved model declares, or `undefined` when unresolved.
 *
 * Both shapes reach this function — the adapter's `{ id, name, description }`
 * rows when a model was resolved, and plain strings from a stored document or
 * a test — so it reads either rather than making every caller normalize first.
 */
export function declaredEfforts(facts) {
  const list = facts?.efforts
  if (!Array.isArray(list)) return undefined
  return list
    .map((row) => (typeof row === 'string' ? row : String(row?.id ?? '')))
    .filter((id) => id !== '')
}

/**
 * Coerce one posted entry into something safe to store and to send.
 *
 * Invalid values are dropped rather than rejected wholesale: a page that loses
 * a whole model's careful configuration because one field went stale would be
 * worse than one that keeps what it can and says what it dropped.
 *
 * @param raw - the entry as posted (or read back from disk)
 * @param facts - resolved model metadata, or `undefined` when unresolvable
 * @returns `{ entry, problems }` — problems are stable codes the caller reports
 */
export function sanitizeEntry(raw, facts) {
  const entry = baseEntry()
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entry, problems: ['not-an-object'] }
  }
  entry.enabled = raw.enabled === true
  entry.effortMode = raw.effortMode === EFFORT_MODE.SESSION ? EFFORT_MODE.SESSION : EFFORT_MODE.PRESET
  entry.note = typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE_LENGTH) : ''
  entry.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Math.trunc(Number(raw.updatedAt)) : 0

  const effort = typeof raw.effort === 'string' ? raw.effort.trim() : ''
  if (effort !== '') {
    const declared = declaredEfforts(facts)
    // Unresolvable metadata keeps the value and says so: the request seam
    // re-checks membership right before the wire, so a transient lookup failure
    // must not silently delete a setting the person typed.
    if (declared === undefined) {
      entry.effort = effort
      problems.push('effort-unverified')
    } else if (!declared.includes(effort)) problems.push('effort-not-declared')
    else entry.effort = effort
  }

  entry.maxTokens = sanitizeTokens(raw.maxTokens, facts, problems)
  entry.temperature = sanitizeTemperature(raw.temperature, problems)
  entry.stop = sanitizeStop(raw.stop)
  return { entry, problems }
}

/** One positive integer ceiling, clamped to what the model could accept. */
function sanitizeTokens(value, facts, problems) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    problems.push('max-tokens-invalid')
    return null
  }
  let tokens = Math.trunc(number)
  const contextWindow = Number(facts?.contextWindow)
  const ceiling = Number.isFinite(contextWindow) && contextWindow > 1
    ? Math.min(MAX_TOKENS_CEILING, Math.trunc(contextWindow) - 1)
    : MAX_TOKENS_CEILING
  if (tokens > ceiling) {
    problems.push('max-tokens-clamped')
    tokens = ceiling
  }
  return tokens
}

/** One sampling temperature inside the range the wire accepts. */
function sanitizeTemperature(value, problems) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) {
    problems.push('temperature-invalid')
    return null
  }
  const clamped = Math.min(Math.max(number, TEMPERATURE_MIN), TEMPERATURE_MAX)
  if (clamped !== number) problems.push('temperature-clamped')
  return clamped
}

/** A short, deduped stop list; empty entries are not sequences. */
function sanitizeStop(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/)
  const out = []
  for (const raw of list) {
    const text = String(raw ?? '').replace(/\r/g, '').slice(0, MAX_STOP_LENGTH)
    if (text.trim() === '' || out.includes(text)) continue
    out.push(text)
    if (out.length >= MAX_STOP_SEQUENCES) break
  }
  return out
}

/**
 * Apply one stored entry to one request config.
 *
 * Pure: the input object is never mutated, and the returned config is a new
 * object whenever anything changed. `applied` lists the fields this request
 * actually carries because of the entry; `skipped` names the fields the entry
 * asked for and did not get, with a stable reason — an effort the model no
 * longer declares must be dropped rather than sent, because the harness
 * rejects an unknown effort before provider I/O and that failure ends the turn.
 *
 * @param entry - a sanitized entry
 * @param config - the config the loop (and any other listener) resolved
 * @param facts - resolved model metadata, or `undefined` when unresolvable
 * @returns `{ config, applied, skipped }`
 */
export function applyPreset(entry, config, facts) {
  const applied = []
  const skipped = []
  if (entry === null || entry === undefined || config === null || config === undefined) {
    return { config, applied, skipped }
  }
  // A row exists for exactly one reason: this plugin owns these four fields on
  // this route. An entry that asks for nothing is still a row, so the fields a
  // previous request recorded are cleared rather than left pinned in the
  // session — which is what makes "restore the model default" finish its job.
  const next = { ...config }

  const sessionPick = typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
  const declared = declaredEfforts(facts)
  if (entry.effortMode === EFFORT_MODE.SESSION && sessionPick) {
    skipped.push({ field: 'reasoningEffort', reason: 'session-pick' })
  } else if (typeof entry.effort === 'string' && entry.effort !== '') {
    if (declared === undefined) skipped.push({ field: 'reasoningEffort', reason: 'model-unresolved' })
    else if (declared.length === 0) skipped.push({ field: 'reasoningEffort', reason: 'no-effort-menu' })
    else if (!declared.includes(entry.effort)) skipped.push({ field: 'reasoningEffort', reason: 'not-declared' })
    else next.reasoningEffort = entry.effort
  } else {
    delete next.reasoningEffort
  }

  // `null` is the stored spelling of "the model decides"; a hand-edited file
  // may also simply omit the key, which means the same thing.
  if (entry.maxTokens === null || entry.maxTokens === undefined) delete next.maxTokens
  else next.maxTokens = entry.maxTokens

  if (entry.temperature === null || entry.temperature === undefined) delete next.temperature
  else next.temperature = entry.temperature

  if (Array.isArray(entry.stop) && entry.stop.length > 0) next.stop = [...entry.stop]
  else delete next.stop

  for (const field of PARAM_FIELDS) {
    if (!fieldChanged(config[field], next[field])) continue
    applied.push(field)
  }
  return { config: next, applied, skipped }
}

/** Field equality for the four owned fields; arrays compare element-wise. */
function fieldChanged(before, after) {
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : []
    const right = Array.isArray(after) ? after : []
    return left.length !== right.length || left.some((value, index) => value !== right[index])
  }
  return before !== after
}

/** Rungs with no thinking at all, where a "highest rung" question is moot. */
const OFF_EFFORTS = new Set(['disabled', 'off', 'none'])

/**
 * Display order of the rungs this harness and its providers actually name.
 *
 * Unknown ids rank with the low rungs rather than above them, so a provider
 * that invents a new top rung still loses to an explicit `max` while a list of
 * only unknown ids still answers with one of them.
 */
const EFFORT_RANK = new Map([
  ['minimal', 0], ['light', 1], ['low', 1], ['medium', 2], ['balanced', 2],
  ['high', 3], ['deep', 4], ['xhigh', 5], ['max', 6],
])

/** The highest rung one model declares, or `''` when there is nothing to pick. */
export function topEffort(efforts) {
  const list = Array.isArray(efforts) ? efforts.filter((id) => typeof id === 'string' && id !== '') : []
  const candidates = list.filter((id) => !OFF_EFFORTS.has(id))
  if (candidates.length === 0) return ''
  let best = candidates[0]
  let bestRank = EFFORT_RANK.get(best) ?? 0
  for (const id of candidates.slice(1)) {
    const rank = EFFORT_RANK.get(id) ?? 0
    // Ties keep the later rung: declaration order is the picker's order.
    if (rank >= bestRank) {
      best = id
      bestRank = rank
    }
  }
  return best
}

/**
 * The "everything the model can give" preset for one route.
 *
 * The ceiling is the adapter's own default for the model — the number it would
 * reserve anyway — so this raises nothing past what the provider advertises.
 * Temperature and stop sequences are deliberately absent: neither has a
 * meaningful maximum, and inventing one would change how the model answers.
 *
 * @param facts - resolved model metadata
 * @returns a configured entry, or `null` when nothing can be raised
 */
export function topPreset(facts) {
  const effort = topEffort(declaredEfforts(facts))
  const capacity = Number(facts?.defaultMaxTokens)
  const maxTokens = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null
  if (effort === '' && maxTokens === null) return null
  return {
    ...baseEntry(),
    enabled: true,
    effort,
    effortMode: EFFORT_MODE.PRESET,
    maxTokens,
    note: '',
    updatedAt: 0,
  }
}

/** Merge posted entries into a stored table without dropping the other rows. */
export function mergeEntries(table, patch) {
  const out = { ...(table ?? {}) }
  for (const [key, entry] of Object.entries(patch ?? {})) {
    if (typeof key !== 'string' || key === '' || !key.includes('|')) continue
    out[key] = entry
    if (Object.keys(out).length >= MAX_ENTRIES) break
  }
  return out
}

/**
 * Read one document back into a usable shape.
 *
 * The file is on disk and therefore editable by hand and by older versions, so
 * nothing here trusts it: unknown keys are dropped, entries are re-sanitized
 * without model facts (membership is checked again at request time), and the
 * scope falls back to the Our Free Model patterns.
 */
export function sanitizeDocument(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const entries = {}
  const source = value.entries !== null && typeof value.entries === 'object' && !Array.isArray(value.entries)
    ? value.entries
    : {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof key !== 'string' || !key.includes('|')) continue
    // Facts are unknown while loading: the effort survives a cold read and is
    // checked against the live model right before it would go on the wire.
    const { entry: clean } = sanitizeEntry({ ...entry, effort: '' }, undefined)
    clean.effort = typeof entry?.effort === 'string' ? entry.effort.trim().slice(0, 60) : ''
    entries[key] = clean
    if (Object.keys(entries).length >= MAX_ENTRIES) break
  }
  return {
    version: 1,
    scope: normalizeScope(value.scope),
    entries,
    ai: {
      provider: typeof value.ai?.provider === 'string' ? value.ai.provider.slice(0, 80) : '',
      model: typeof value.ai?.model === 'string' ? value.ai.model.slice(0, 160) : '',
      maxTokens: Number.isSafeInteger(Number(value.ai?.maxTokens)) && Number(value.ai?.maxTokens) > 0
        ? Math.min(Math.trunc(Number(value.ai.maxTokens)), 32000)
        : 4096,
    },
  }
}

/** The document a fresh install starts from. */
export function initialParams() {
  return sanitizeDocument({})
}
