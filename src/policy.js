/**
 * OFM Addition — continuation policy.
 *
 * Everything that decides whether the plugin may prompt a session again lives
 * here, with no harness import: one durable turn boundary folds into an agent's
 * continuation state, and a live agent snapshot decides whether that state
 * authorizes one more send. Keeping the decision pure is what lets the whole
 * feature be exercised without booting DSH.
 *
 * @module src/policy.js
 */

/** The turn-ending reason a provider reports when it stopped at the output cap. */
export const MAX_TOKENS = 'max-tokens'

/** The failure code the harness reports when a request outgrew the model's window. */
export const CONTEXT_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * Closed vocabulary for "why nothing was sent". The browser half renders one
 * localized line per value, so a new rule here needs a dictionary entry there.
 */
export const OUTCOME = Object.freeze({
  SENT: 'sent',
  DISABLED: 'disabled',
  NO_PENDING: 'no-pending',
  AGENT_GONE: 'agent-gone',
  AGENT_BUSY: 'agent-busy',
  USER_DRIVING: 'user-driving',
  BUDGET_SPENT: 'budget-spent',
  ROUTE_FILTERED: 'route-filtered',
  SUBAGENT_FILTERED: 'subagent-filtered',
  TOOL_CALL_TRUNCATED: 'tool-call-truncated',
  /** The next request would already be too close to the model's context window. */
  CONTEXT_FULL: 'context-full',
  /** A request actually outgrew the window, so the episode is over for good. */
  CONTEXT_OVERFLOW: 'context-overflow',
  DISPOSED: 'disposed',
})

/** Every outcome the settings page can explain, in the order it lists them. */
export const OUTCOME_ORDER = Object.freeze([
  OUTCOME.SENT,
  OUTCOME.DISABLED,
  OUTCOME.BUDGET_SPENT,
  OUTCOME.CONTEXT_FULL,
  OUTCOME.CONTEXT_OVERFLOW,
  OUTCOME.ROUTE_FILTERED,
  OUTCOME.SUBAGENT_FILTERED,
  OUTCOME.USER_DRIVING,
  OUTCOME.AGENT_BUSY,
  OUTCOME.TOOL_CALL_TRUNCATED,
  OUTCOME.NO_PENDING,
  OUTCOME.AGENT_GONE,
  OUTCOME.DISPOSED,
])

/**
 * Preset prompts. `simple` is the literal word the harness hint tells the user
 * to send; `explicit` spells out the truncation so a model that would otherwise
 * restart or restate carries on instead.
 */
export const PROMPT_PRESETS = Object.freeze({
  simple: '继续',
  explicit:
    '继续 —— 上一条回答因达到输出上限被截断。请从中断处接着写，不要重述已经写过的内容，也不要重新开头。',
})

/** Prompt presets in the order the settings page offers them. */
export const PROMPT_PRESET_ORDER = Object.freeze(['explicit', 'simple'])

/** Settings a fresh install starts from. */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  /** Master switch. */
  enabled: true,
  /**
   * Auto-continues allowed per truncation episode before the plugin stands down.
   * **Zero means no ceiling**: the context guard below becomes the only thing
   * that stops the run, which is the point of allowing it at all.
   */
  maxContinuations: 3,
  /** Quiet period between the session going idle and the prompt being sent. */
  delayMs: 350,
  /** Which built-in prompt to send. */
  promptPreset: 'explicit',
  /** When non-empty, replaces the preset verbatim. */
  prompt: '',
  /** Provider allow-list; empty means every provider. `*` wildcards are honored. */
  providers: [],
  /** Model allow-list; empty means every model. `*` wildcards are honored. */
  models: [],
  /** Whether subagents are continued too. */
  includeSubagents: false,
  /** How the sent prompt presents in the transcript: `user` or `notice`. */
  messageMode: 'user',
  /** Refuse when the output was cut in the middle of a tool call. */
  skipOnTruncatedToolCall: false,
  /**
   * Refuse to continue once the next request would already be close to the
   * routed model's context window. This is the second gate that makes an
   * unlimited `maxContinuations` safe.
   */
  contextGuard: true,
  /**
   * Fraction of the prompt's own budget at which that gate closes.
   *
   * The budget is the window minus the output the request reserves, so `1` means
   * "stop at the literal limit" and anything lower leaves the model room to
   * finish instead of erroring.
   */
  contextRatio: 0.9,
  /**
   * Hold every feature to Our Free Model's own routes.
   *
   * This is the plugin's reason to exist and the one switch that decides
   * whether it touches a session at all: off, the allow-lists below take over.
   */
  ofmOnly: true,
  /** Routes counted as "ours" while `ofmOnly` is on. */
  ofmProviders: ['our-free-model*'],
  /** Fold a run's own continuation rows and answered truncation notices away. */
  foldContinuations: true,
  /** Annotate a run's last output with how many times it was continued. */
  showContinueCount: true,
})

/** Routes an Our Free Model install registers. */
export const OFM_PROVIDER_PATTERNS = Object.freeze(['our-free-model*'])

/** Fraction bounds a stored `contextRatio` is clamped into. */
export const CONTEXT_RATIO_MIN = 0.5
export const CONTEXT_RATIO_MAX = 1

/** Clamp a stored guard threshold into a usable fraction. */
export function resolveContextRatio(settings) {
  const value = Number(settings?.contextRatio)
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.contextRatio
  return Math.min(Math.max(value, CONTEXT_RATIO_MIN), CONTEXT_RATIO_MAX)
}

/**
 * How one measurement stands against the routed model's context window.
 *
 * `context` is the host half's best-effort reading of the next request:
 * `{ known, projectedTokens, contextWindow, reservedTokens }`. An adapter that
 * declares no window, or a composition without the meter that measures one,
 * yields `known: false` — and an unknown limit **allows** the continuation, so
 * the feature degrades to "run until the provider says stop" rather than to
 * "never run". The provider's own overflow is caught separately and finally.
 *
 * @param settings - resolved settings
 * @param context - the measurement, or undefined when none was possible
 * @returns `{ limited, unknown, projected, available, threshold }`
 */
export function contextPressure(settings, context) {
  const unknown = { limited: false, unknown: true, projected: 0, available: 0, threshold: 0 }
  if (settings?.contextGuard !== true) return { limited: false, unknown: false, projected: 0, available: 0, threshold: 0 }
  if (context === undefined || context === null || context.known !== true) return unknown
  const window = Number(context.contextWindow)
  if (!Number.isFinite(window) || window <= 0) return unknown
  const reserved = Math.max(0, Number(context.reservedTokens) || 0)
  const projected = Math.max(0, Number(context.projectedTokens) || 0)
  const available = window - reserved
  if (available <= 0) return { limited: true, unknown: false, projected, available: 0, threshold: 0 }
  const threshold = Math.floor(available * resolveContextRatio(settings))
  return { limited: projected >= threshold, unknown: false, projected, available, threshold }
}

/** Whether an episode's continuation budget still allows another prompt. */
export function budgetAllows(settings, state) {
  const limit = Math.max(0, Math.trunc(Number(settings?.maxContinuations) || 0))
  if (limit === 0) return true
  return (state?.fired ?? 0) < limit
}

/** Render a continuation count for logs and the settings page. */
export function describeBudget(settings) {
  const limit = Math.max(0, Math.trunc(Number(settings?.maxContinuations) || 0))
  return limit === 0 ? '∞' : String(limit)
}

/** Resolved prompt for the current settings, custom text winning over the preset. */
export function resolvePrompt(settings) {
  const custom = typeof settings?.prompt === 'string' ? settings.prompt.trim() : ''
  if (custom !== '') return custom
  const preset = typeof settings?.promptPreset === 'string' ? settings.promptPreset : ''
  return PROMPT_PRESETS[preset] ?? PROMPT_PRESETS.explicit
}

/** Coerce a stored allow-list into trimmed, non-empty, de-duplicated patterns. */
export function normalizeList(value) {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : []
  const out = []
  for (const row of rows) {
    const text = String(row ?? '').trim()
    if (text === '' || out.includes(text)) continue
    out.push(text)
  }
  return out
}

/**
 * Match one allow-list pattern against a value.
 *
 * Only `*` is special (any run of characters), because the field is a filter a
 * person types, not a regular expression — `our-free-model*` is the whole
 * vocabulary anyone needs.
 */
export function matchesPattern(pattern, value) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const parts = pattern.split('*')
  let cursor = 0
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === '') continue
    if (index === 0) {
      if (!value.startsWith(part)) return false
      cursor = part.length
      continue
    }
    const found = value.indexOf(part, cursor)
    if (found < 0) return false
    cursor = found + part.length
  }
  const last = parts[parts.length - 1]
  return last === '' || value.endsWith(last)
}

/** Whether a route passes the configured provider and model filters. */
export function routeMatches(settings, route) {
  const provider = typeof route?.provider === 'string' ? route.provider : ''
  const model = typeof route?.model === 'string' ? route.model : ''
  const providers = normalizeList(settings?.providers)
  const models = normalizeList(settings?.models)
  if (providers.length > 0 && !providers.some((pattern) => matchesPattern(pattern, provider))) return false
  if (models.length > 0 && !models.some((pattern) => matchesPattern(pattern, model))) return false
  return true
}

/**
 * Whether this plugin may touch a route at all.
 *
 * `ofmOnly` wins over the general allow-list rather than intersecting with it:
 * the plugin is an add-on for one provider, and "our routes, or whatever you
 * list" is a rule a person can predict. Both the continuation and the two
 * transcript features go through here, so switching scopes never leaves half
 * the plugin behind.
 *
 * @param settings - resolved settings
 * @param route - `{ provider, model }`
 * @returns whether the route is in scope
 */
export function routeAllowed(settings, route) {
  if (settings?.ofmOnly === true) {
    const provider = typeof route?.provider === 'string' ? route.provider : ''
    const patterns = normalizeList(settings.ofmProviders)
    const effective = patterns.length > 0 ? patterns : OFM_PROVIDER_PATTERNS
    return effective.some((pattern) => matchesPattern(pattern, provider))
  }
  return routeMatches(settings, route)
}

/** A subagent is identified by the delegation depth it was stamped with. */
export function isSubagent(agent) {
  if (agent?.options?.subagentDepth !== undefined) return true
  const origin = agent?.session?.header?.origin
  return origin === 'subagent'
}

/**
 * One agent's continuation state.
 *
 * `streak` counts the truncation episode the agent is in and `fired` how many
 * prompts this plugin already sent into it; together they are the budget. Both
 * reset the moment the episode ends on anything but a truncation, or the moment
 * a real person types.
 */
export function createAgentState() {
  return {
    streak: 0,
    fired: 0,
    /** Armed truncation awaiting an idle moment, or null. */
    pending: null,
    /** Identities of prompts this plugin injected, so they never count as user input. */
    ours: new Set(),
    /** Whether the most recent assistant message carried a tool call. */
    truncatedToolCall: false,
    /** Set when the last turn died on the context window rather than ending. */
    overflowed: false,
  }
}

/**
 * Fold one durable `turn/end` into an agent's state.
 * @param state - the agent's continuation state, mutated in place
 * @param reason - the event's `data.reason`
 * @param snapshot - `{ turn, now }` for the truncation being armed
 * @returns the armed pending record, or null when the episode ended
 */
export function observeTurnEnd(state, reason, snapshot) {
  if (reason?.kind !== MAX_TOKENS) {
    state.streak = 0
    state.fired = 0
    state.pending = null
    // A request that outgrew the window is the one ending the plugin must not
    // try to answer; recording it is what lets the settings page say why the
    // run stopped instead of leaving it looking like an ordinary failure.
    state.overflowed = reason?.kind === 'error' && reason?.error?.code === CONTEXT_EXCEEDED_CODE
    return null
  }
  state.overflowed = false
  state.streak += 1
  state.pending = {
    turn: snapshot?.turn,
    at: snapshot?.now ?? Date.now(),
    truncatedToolCall: state.truncatedToolCall === true,
  }
  return state.pending
}

/**
 * Fold one `assistant/message` into an agent's state, so the truncation point
 * can be classified when the turn ends.
 */
export function observeAssistantMessage(state, message) {
  const content = Array.isArray(message?.content) ? message.content : []
  state.truncatedToolCall = content.some((block) => block?.type === 'tool-call')
  return state.truncatedToolCall
}

/**
 * Fold one `user/message` into an agent's state.
 * @param state - the agent's continuation state, mutated in place
 * @param message - the durable message
 * @returns whether this was real user input (which restarts the budget)
 */
export function observeUserMessage(state, message) {
  const id = typeof message?.id === 'string' ? message.id : ''
  if (id !== '' && state.ours.has(id)) {
    state.ours.delete(id)
    return false
  }
  if (message?.source?.kind !== 'user') return false
  state.streak = 0
  state.fired = 0
  state.pending = null
  return true
}

/** A refusal, with the sentence the settings page shows for it. */
function refuse(outcome, detail) {
  return { ok: false, outcome, detail: typeof detail === 'string' ? detail : '' }
}

/**
 * Decide whether the armed truncation may be answered with one more prompt.
 *
 * The caller re-runs this after its delay, so every condition it reads is
 * re-read there too — a person who typed, stopped, or switched model in the
 * meantime must win.
 *
 * @param input.agent - live agent snapshot: `{ status, options, session, queued }`
 * @param input.route - resolved `{ provider, model }` for the current request
 * @param input.state - the agent's continuation state
 * @param input.settings - resolved settings
 * @param input.context - the host half's context measurement, when it managed one
 * @returns `{ ok: true, prompt }` or `{ ok: false, outcome, detail }`
 */
export function decide(input) {
  const { agent, state, settings, route } = input
  if (input.disposed === true) return refuse(OUTCOME.DISPOSED)
  if (settings?.enabled !== true) return refuse(OUTCOME.DISABLED)
  if (state === undefined || state === null || state.pending === null || state.pending === undefined) {
    return refuse(OUTCOME.NO_PENDING)
  }
  if (agent === undefined || agent === null) return refuse(OUTCOME.AGENT_GONE)
  if (agent.status !== 'idle') return refuse(OUTCOME.AGENT_BUSY)
  const queued = Number(agent.queued?.nextTurn ?? 0) + Number(agent.queued?.nextStep ?? 0)
  if (queued > 0) return refuse(OUTCOME.USER_DRIVING)
  if (!budgetAllows(settings, state)) return refuse(OUTCOME.BUDGET_SPENT)
  if (isSubagent(agent) && settings.includeSubagents !== true) return refuse(OUTCOME.SUBAGENT_FILTERED)
  if (!routeAllowed(settings, route)) {
    return refuse(OUTCOME.ROUTE_FILTERED, `${route?.provider ?? '?'}/${route?.model ?? '?'}`)
  }
  if (state.pending.truncatedToolCall === true && settings.skipOnTruncatedToolCall === true) {
    return refuse(OUTCOME.TOOL_CALL_TRUNCATED)
  }
  // Last because it is the only rule that needs a measurement: an unknown or
  // unmeasured window allows the continuation rather than blocking the feature.
  const pressure = contextPressure(settings, input.context)
  if (pressure.limited) {
    return refuse(OUTCOME.CONTEXT_FULL, `${pressure.projected} / ${pressure.threshold}`)
  }
  return { ok: true, outcome: OUTCOME.SENT, prompt: resolvePrompt(settings) }
}

/** Clamp a stored delay into something a timer can hold without wedging the app. */
export function resolveDelay(settings) {
  const value = Number(settings?.delayMs)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SETTINGS.delayMs
  return Math.min(Math.round(value), 30_000)
}
