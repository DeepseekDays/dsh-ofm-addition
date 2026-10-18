/**
 * OFM Addition — plugin entry (Host half).
 *
 * An add-on for Our Free Model that gives the harness one thing it does not do
 * on its own: when a turn ends because the model hit its output-token cap, the
 * prompt the harness tells the user to type is typed for them.
 *
 * The whole feature is a fold over two durable facts plus one live snapshot:
 *
 *   `turn/end` with `reason.kind === 'max-tokens'`  arms the agent,
 *   `agent/status` going idle                      is the moment it can be sent,
 *   and a re-check at that moment                 decides whether it should be.
 *
 * Nothing here wraps or replaces a harness service. The plugin only observes,
 * then calls `agent.followup()` — the same public entry point the built-in goal
 * driver, the scheduler, and the webhook bridge all use — so a composition that
 * removes this plugin is exactly as healthy as one that never had it.
 *
 * The re-check is the part that matters. Between arming and sending there is a
 * configured quiet period, and in that window a person may have typed, pressed
 * stop, or switched model; every rule is evaluated again on the far side of the
 * delay, and anything that moved wins.
 *
 * The second half of the plugin is a table rather than a rule: **per-model
 * request parameters**. Each Our Free Model route can be given a reasoning
 * rung, an output ceiling, a sampling temperature and stop sequences once, and
 * the plugin writes them onto every later request for that route at the
 * `agent/request` seam — the last point before the harness logs and dispatches
 * the envelope. A route with no row is never touched, so an untouched install
 * behaves exactly like one without this plugin.
 *
 * @module index.js
 */

import path from 'node:path'
import { DATA_DIR_NAME, JsonStore, initialStats, recordOutcome, resolveDshHome } from './src/store.js'
import { foldIndex, foldLog } from './src/ledger.js'
import {
  DEFAULT_SETTINGS,
  OUTCOME,
  OUTCOME_ORDER,
  PROMPT_PRESET_ORDER,
  PROMPT_PRESETS,
  createAgentState,
  decide,
  describeBudget,
  isSubagent,
  normalizeList,
  observeAssistantMessage,
  observeTurnEnd,
  observeUserMessage,
  resolveContextRatio,
  resolveDelay,
  resolvePrompt,
  routeAllowed,
} from './src/policy.js'
import { buildContinuation } from './src/message.js'
import { rejectionFor } from './src/trust.js'
import {
  applyPreset,
  describeEntry,
  entryKeyOf,
  isConfigured,
  normalizeScope,
  providerInScope,
  sanitizeDocument,
  sanitizeEntry,
  splitKey,
  topPreset,
} from './src/model-params.js'
import { buildAiPrompt, parseAiProposals } from './src/ai-fill.js'

export const name = 'ofm-addition'

/**
 * `agents` is what the plugin exists for: it resolves a session to its live
 * driver and sends the prompt. `sessions` carries the durable `session/event`
 * stream the arming half reads. `webServer` and `connection` are reached through
 * `ctx.get()` instead, so a composition without them loses the settings page and
 * nothing else.
 */
export const inject = ['agents', 'sessions']

/** Published version, read once at load for the settings page footer. */
export const VERSION = '0.4.0'

/**
 * @param ctx - the plugin's cordis context
 * @param config - optional initial settings; the stored file overrides them
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const dataDir = path.join(resolveDshHome(), DATA_DIR_NAME)
  const settings = new JsonStore(path.join(dataDir, 'settings.json'), { ...DEFAULT_SETTINGS, ...(config ?? {}) })
  const stats = new JsonStore(path.join(dataDir, 'stats.json'), initialStats())

  /**
   * The per-model parameter table.
   *
   * A separate document from the settings on purpose: settings are a form with
   * one value per field, while this is a table keyed by route that grows with
   * the models a person tunes. Keeping them apart means saving one model's
   * parameters cannot rewrite the rest of the page.
   */
  const params = new JsonStore(path.join(dataDir, 'params.json'), sanitizeDocument(config?.modelParams ?? {}))
  // The file wins over the seed, and it is hand-editable and outlives version
  // changes, so it is read back through the same normalizer the API uses — an
  // entry with a missing key must mean "the model decides", never "send
  // undefined to the adapter".
  params.value = sanitizeDocument(params.value)
  /** Resolved model metadata per route, with the time it was read. */
  const modelFacts = new Map()
  /** The roster the parameter page renders, cached briefly so a refresh is cheap. */
  let rosterCache = { at: 0, value: undefined }
  /** One level of undo for a bulk write; process-local, like any UI edit stack. */
  let lastBulk = { at: 0, entries: undefined }
  /** Requests this process has carried parameters for, newest last. */
  const appliedStats = { count: 0, lastAt: 0, lastKey: '', lastApplied: [], skipped: {} }

  const FACTS_TTL_MS = 5 * 60 * 1000
  const ROSTER_TTL_MS = 15 * 1000
  const AI_TIMEOUT_MS = 120 * 1000

  /** The LLM service, which may not be mounted in a minimal composition. */
  function llmService() {
    return typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  }

  /**
   * Read one route's capabilities, cached.
   *
   * The capability list is what makes a stored rung safe to send: the harness
   * refuses an effort the adapter does not declare, and that refusal ends the
   * turn. So this is consulted on the request path, not only when saving.
   */
  async function factsFor(provider, model, signal) {
    const key = entryKeyOf(provider, model)
    const cached = modelFacts.get(key)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < FACTS_TTL_MS) return cached.facts
    const llm = llmService()
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      // Names and descriptions are kept, not just the ids: the parameter page
      // shows the same rung labels the model picker does, so a person never has
      // to learn a second vocabulary for one setting.
      const efforts = Array.isArray(info?.reasoning?.efforts)
        ? info.reasoning.efforts
          .map((row) => ({
            id: String(row?.id ?? ''),
            name: typeof row?.name === 'string' && row.name !== '' ? row.name : String(row?.id ?? ''),
            description: typeof row?.description === 'string' ? row.description.slice(0, 300) : '',
          }))
          .filter((row) => row.id !== '')
        : []
      const resolved = {
        efforts,
        defaultEffort: typeof info?.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : '',
        contextWindow: Number.isFinite(Number(info?.context?.contextWindow))
          ? Math.trunc(Number(info.context.contextWindow))
          : undefined,
        defaultMaxTokens: Number.isFinite(Number(info?.defaultMaxTokens))
          ? Math.trunc(Number(info.defaultMaxTokens))
          : undefined,
        name: typeof info?.name === 'string' && info.name !== '' ? info.name : model,
        vision: Array.isArray(info?.inputModalities) ? info.inputModalities.includes('image') : false,
      }
      modelFacts.set(key, { at: now, facts: resolved })
      return resolved
    } catch (error) {
      logger.debug?.(`ofm-addition: could not resolve ${key} (${error?.message ?? error})`)
      return undefined
    }
  }

  /**
   * Every route the parameter page may manage.
   *
   * Providers come from the live registry rather than a hard-coded list, so a
   * second Our Free Model route (or a pattern added to the scope field) shows
   * up without a code change.
   */
  async function roster() {
    const now = Date.now()
    if (rosterCache.value !== undefined && now - rosterCache.at < ROSTER_TTL_MS) return rosterCache.value
    const llm = llmService()
    const scope = normalizeScope(params.get().scope)
    const models = []
    let providers = []
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      try {
        providers = (llm.listProviders() ?? []).map((row) => String(row?.id ?? '')).filter((id) => id !== '')
      } catch (error) {
        logger.warn?.(`ofm-addition: could not list providers (${error?.message ?? error})`)
      }
    }
    for (const provider of providers) {
      if (!providerInScope(scope, provider)) continue
      let advertised = []
      try {
        advertised = (await llm.listModels(provider)) ?? []
      } catch (error) {
        logger.warn?.(`ofm-addition: could not list models of "${provider}" (${error?.message ?? error})`)
        continue
      }
      for (const model of advertised) {
        const id = String(model?.id ?? '')
        if (id === '') continue
        const resolved = await factsFor(provider, id)
        models.push({
          key: entryKeyOf(provider, id),
          provider,
          model: id,
          name: typeof model?.name === 'string' && model.name !== '' ? model.name : id,
          description: typeof model?.description === 'string' ? model.description.slice(0, 400) : '',
          contextWindow: resolved?.contextWindow,
          defaultMaxTokens: resolved?.defaultMaxTokens,
          efforts: resolved?.efforts ?? [],
          defaultEffort: resolved?.defaultEffort ?? '',
          vision: resolved?.vision === true,
          resolved: resolved !== undefined,
        })
      }
    }
    models.sort((left, right) => left.provider === right.provider
      ? left.name.localeCompare(right.name)
      : left.provider.localeCompare(right.provider))
    const value = { scope, providers: [...new Set(models.map((row) => row.provider))], models, at: now }
    rosterCache = { at: now, value }
    return value
  }

  /** Clear the roster cache so the next read reflects a just-saved scope change. */
  function invalidateRoster() {
    rosterCache = { at: 0, value: undefined }
  }

  /**
   * Write the stored parameters for one route onto one request config.
   *
   * Called on the far side of `next()`, which is where the session's own model
   * picker has already had its say — so what this returns is what the request
   * actually carries, and the page's promise ("this is what the model runs
   * with") is true rather than aspirational.
   */
  async function applyStoredParams(config, signal) {
    if (config === null || config === undefined) return { config, applied: [], skipped: [] }
    const entry = params.get().entries[entryKeyOf(config.provider, config.model)]
    if (entry === undefined) return { config, applied: [], skipped: [] }
    const resolved = await factsFor(config.provider, config.model, signal)
    return applyPreset(entry, config, resolved)
  }

  /** Which route the tuning model should be asked on, if any. */
  function aiRoute() {
    const document = params.get()
    if (document.ai.provider !== '' && document.ai.model !== '') {
      return { provider: document.ai.provider, model: document.ai.model, source: 'stored' }
    }
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    try {
      const current = service?.currentSelection?.()
      if (typeof current?.provider === 'string' && current.provider !== ''
        && typeof current?.model === 'string' && current.model !== '') {
        return { provider: current.provider, model: current.model, source: 'default' }
      }
    } catch {
      // A selection that cannot be read is not a reason to refuse the feature.
    }
    return { provider: '', model: '', source: 'none' }
  }

  /**
   * Stream one tuning call and return its text.
   *
   * Deliberately not routed through a session: this is a plugin-internal call,
   * so it carries no `purpose` and is never written to a transcript.
   */
  async function askModel(route, prompt, maxTokens) {
    const llm = llmService()
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('the llm service is not mounted')
    }
    if (route.provider === '' || route.model === '') throw new Error('no model is available to fill parameters in')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('the tuning call timed out')), AI_TIMEOUT_MS)
    timer.unref?.()
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        system: prompt.system,
        maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        signal: controller.signal,
      }
      let text = ''
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'the tuning model call failed')
        }
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  /** The roster rows the parameter page renders, with each row's stored entry. */
  async function modelPage() {
    const document = params.get()
    const table = await roster()
    const route = aiRoute()
    return {
      version: VERSION,
      scope: document.scope,
      entries: document.entries,
      providers: table.providers,
      models: table.models.map((row) => ({
        ...row,
        entry: document.entries[row.key] ?? null,
        top: topPreset(row),
      })),
      ai: { ...document.ai, route },
      applied: appliedStats,
    }
  }

  /** Per-agent continuation state, keyed by the live agent itself. */
  const states = new Map()
  /** Armed quiet periods that have not fired yet, keyed by agent. */
  const timers = new Map()
  /**
   * Folded session logs, keyed by the session object and validated by log
   * length, so a transcript rebuild happens once per new event rather than once
   * per request.
   */
  const ledgers = new WeakMap()
  /** Set by the disposer so a late async callback cannot send after teardown. */
  let disposed = false

  function stateFor(agent) {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const created = createAgentState()
    states.set(agent, created)
    return created
  }

  /** Cancel an armed quiet period. */
  function cancel(agent) {
    const timer = timers.get(agent)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(agent)
    }
  }

  /** Forget one agent completely. */
  function forget(agent) {
    cancel(agent)
    states.delete(agent)
  }

  /**
   * Resolve the route that produced the truncated turn.
   *
   * The session's recorded request header is the honest answer — it is what the
   * last request actually ran on — and `agent.options` is the fallback for the
   * window before any request has been made.
   */
  function routeOf(agent) {
    let header
    try {
      header = agent.session?.requestHeader?.()
    } catch {
      header = undefined
    }
    const config = header?.config
    return {
      provider: typeof config?.provider === 'string' ? config.provider : String(agent.options?.provider ?? ''),
      model: typeof config?.model === 'string' ? config.model : String(agent.options?.model ?? ''),
    }
  }

  /** How much input is already waiting, without letting a cold projection throw. */
  function queuedOf(agent) {
    try {
      return {
        nextTurn: agent.inbox?.nextTurn?.length ?? 0,
        nextStep: agent.inbox?.nextStep?.length ?? 0,
      }
    } catch {
      return { nextTurn: 0, nextStep: 0 }
    }
  }

  /** The snapshot the pure decision reads. */
  function snapshot(agent) {
    return { status: agent.status, options: agent.options, session: agent.session, queued: queuedOf(agent) }
  }

  /**
   * Measure how close the next request would come to the routed model's window.
   *
   * Two harness services answer this, and neither is guaranteed to be mounted:
   *
   * - `tokenMeter.measure(session).totalTokens` is the harness's own price of
   *   the next prompt — the same number compaction decides on, so the guard and
   *   the compactor agree about what "nearly full" means;
   * - `llm.resolveModelInfo` supplies the adapter-owned window and the output the
   *   request reserves, which the prompt has to share the window with.
   *
   * Returns `{ known: false }` when either is missing, which the policy reads as
   * "no limit known" rather than as "no room" — an unmeasurable window must not
   * turn the feature off.
   */
  async function contextFact(agent, route) {
    const llm = ctx.get('llm')
    const meter = ctx.get('tokenMeter')
    if (llm === undefined || meter === undefined) return { known: false }
    if (typeof llm.resolveModelInfo !== 'function' || typeof meter.measure !== 'function') return { known: false }
    if (route.provider === '' || route.model === '') return { known: false }
    let info
    try {
      info = await llm.resolveModelInfo(route.provider, route.model)
    } catch (error) {
      logger.debug?.(`ofm-addition: could not resolve context for ${route.provider}/${route.model} (${error?.message ?? error})`)
      return { known: false }
    }
    const window = info?.context?.contextWindow
    if (!Number.isFinite(window) || window <= 0) return { known: false }
    let total
    try {
      total = meter.measure(agent.session)?.totalTokens
    } catch (error) {
      logger.debug?.(`ofm-addition: could not measure session "${agent.id}" (${error?.message ?? error})`)
      return { known: false }
    }
    if (!Number.isFinite(total)) return { known: false }
    // The output the request reserves shares the window with the prompt, so it
    // is subtracted before the prompt's own budget is priced. Same source the
    // compactor reads: the effective envelope's cap, else the adapter default.
    let headerMax
    try {
      headerMax = agent.session?.requestHeader?.()?.config?.maxTokens
    } catch {
      headerMax = undefined
    }
    const reserved = Number.isFinite(headerMax) ? headerMax : Number(info.defaultMaxTokens) || 0
    return { known: true, projectedTokens: total, contextWindow: window, reservedTokens: reserved }
  }

  /** Record one decision, whether or not it sent anything. */
  function note(agent, state, result, route) {
    recordOutcome(stats, {
      at: Date.now(),
      outcome: result.outcome,
      sessionId: agent.id,
      provider: route.provider,
      model: route.model,
      streak: state?.streak ?? 0,
      prompt: result.prompt ?? '',
      detail: result.detail ?? '',
    })
  }

  /**
   * Evaluate and, when everything still holds, send.
   *
   * `force` is the manual nudge from the settings page: it still refuses a busy
   * or already-driven session, but it does not need an armed truncation and it
   * ignores the per-episode budget, the route filters, and the context guard,
   * because a person clicking the button is a better authority than a policy.
   *
   * Async because the context guard has to ask the harness for a measurement.
   * Everything that measurement read is re-read on the far side of the await:
   * a lookup is not instant, and the session may have moved while it ran.
   */
  async function attempt(agent, { force = false } = {}) {
    if (disposed) return { ok: false, outcome: OUTCOME.DISPOSED }
    const live = ctx.agents.get(agent.id)
    if (live !== agent) return { ok: false, outcome: OUTCOME.AGENT_GONE }
    const state = stateFor(agent)
    const route = routeOf(agent)
    const current = settings.get()

    if (force) {
      // A manual nudge consumes the arming too, so a later idle edge cannot
      // re-send what the person just asked for by hand.
      state.pending = null
      if (current.enabled !== true) return { ok: false, outcome: OUTCOME.DISABLED }
      const view = snapshot(agent)
      if (view.status !== 'idle') return { ok: false, outcome: OUTCOME.AGENT_BUSY }
      if (view.queued.nextTurn + view.queued.nextStep > 0) return { ok: false, outcome: OUTCOME.USER_DRIVING }
      const prompt = resolvePrompt(current)
      const message = buildContinuation(prompt, current.messageMode)
      state.ours.add(message.id)
      agent.followup(message)
      note(agent, state, { outcome: OUTCOME.SENT, prompt }, route)
      logger.info?.(`ofm-addition: manual continuation sent to session "${agent.id}"`)
      return { ok: true, outcome: OUTCOME.SENT }
    }

    const context = await contextFact(agent, route)

    // Re-check the world the await could have changed before acting on it.
    if (disposed) return { ok: false, outcome: OUTCOME.DISPOSED }
    if (ctx.agents.get(agent.id) !== agent) return { ok: false, outcome: OUTCOME.AGENT_GONE }
    if (state.pending === null) return { ok: false, outcome: OUTCOME.NO_PENDING }

    const result = decide({
      agent: snapshot(agent),
      state,
      settings: current,
      route,
      context,
      disposed,
    })
    note(agent, state, result, route)
    // One armed truncation produces at most one attempt: whatever the answer is,
    // the arming is spent here. That is what makes a stale continuation
    // impossible — the session may already have moved on by the time a delayed
    // attempt runs.
    state.pending = null
    if (!result.ok) {
      // Info, not debug: a refusal that leaves no trace is a bug report waiting
      // to happen — this line is how "why did it not continue" gets answered.
      logger.info?.(
        `ofm-addition: no continuation for session "${agent.id}" (${result.outcome})`
        + `${result.detail === '' ? '' : ` — ${result.detail}`}`,
      )
      return result
    }

    const message = buildContinuation(result.prompt, current.messageMode)
    state.ours.add(message.id)
    state.fired += 1
    try {
      agent.followup(message)
    } catch (error) {
      // The queue refused it, so the budget it was charged must be given back —
      // otherwise a transient failure silently spends a continuation.
      state.ours.delete(message.id)
      state.fired -= 1
      logger.warn?.(`ofm-addition: could not queue a continuation for session "${agent.id}" (${error?.message ?? error})`)
      return { ok: false, outcome: OUTCOME.AGENT_GONE, detail: String(error?.message ?? error) }
    }
    logger.info?.(
      `ofm-addition: continuation ${state.fired} of ${describeBudget(current)} sent to session "${agent.id}"`
      + ` after ${state.streak} truncated turn(s)`,
    )
    return result
  }

  /** Arm the quiet period that carries an armed truncation into a send. */
  function schedule(agent) {
    if (disposed) return
    cancel(agent)
    const delay = resolveDelay(settings.get())
    if (delay <= 0) {
      void attempt(agent)
      return
    }
    const timer = setTimeout(() => {
      timers.delete(agent)
      void attempt(agent)
    }, delay)
    // A pending continuation is not a reason to keep a process alive.
    timer.unref?.()
    timers.set(agent, timer)
  }

  /**
   * What the transcript needs to fold this session and annotate it.
   *
   * Derived from the session log rather than from live bookkeeping, so a session
   * that finished before this plugin loaded still reads back correctly. The fold
   * is cached against the log length, which makes the cost one rebuild per new
   * event instead of one per request.
   *
   * Out of scope returns an empty report rather than an error: the browser half
   * then simply leaves the shipped transcript alone.
   */
  function reportFor(agent) {
    const empty = { scoped: false, fold: false, annotate: false, ids: [], turns: [], finals: [] }
    if (agent === undefined) return empty
    const current = settings.get()
    const route = routeOf(agent)
    if (!routeAllowed(current, route)) return empty
    const session = agent.session
    const log = Array.isArray(session?.log) ? session.log : []
    let index
    const cached = ledgers.get(session)
    if (cached !== undefined && cached.length === log.length) {
      index = cached.index
    } else {
      index = foldIndex(foldLog(log))
      if (session !== undefined && session !== null) ledgers.set(session, { length: log.length, index })
    }
    return {
      scoped: true,
      sessionId: agent.id,
      provider: route.provider,
      model: route.model,
      fold: current.foldContinuations === true,
      annotate: current.showContinueCount === true,
      ids: index.ids,
      turns: index.turns,
      finals: index.finals,
    }
  }

  // ── the arming half: durable session facts ────────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (disposed) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const state = stateFor(agent)
    switch (event.type) {
      case 'assistant/message':
        // Remember where the output stopped, so a truncation landing inside a
        // tool call can be told apart from one landing in prose.
        observeAssistantMessage(state, event.data?.message)
        return
      case 'user/message':
        if (observeUserMessage(state, event.data)) cancel(agent)
        return
      case 'turn/end': {
        // A run that dies on the context window is the end of the episode, and
        // it only deserves a line in the record when this plugin was the one
        // keeping the session going.
        const drove = state.fired > 0
        const armed = observeTurnEnd(state, event.data?.reason, { turn: event.data?.turn, now: event.time ?? Date.now() })
        if (armed !== null) return
        cancel(agent)
        if (drove && state.overflowed) {
          note(agent, state, { outcome: OUTCOME.CONTEXT_OVERFLOW }, routeOf(agent))
          logger.warn?.(`ofm-addition: session "${agent.id}" hit its context window; standing down`)
        }
        return
      }
      default:
        return
    }
  })

  // ── the sending half: the moment the driver has nothing left to do ────────
  ctx.on('agent/status', ({ agent, status }) => {
    if (disposed || status !== 'idle') return
    const state = states.get(agent)
    if (state?.pending === null || state?.pending === undefined) return
    schedule(agent)
  })

  ctx.on('agent/error', ({ agent }) => {
    const state = states.get(agent)
    if (state !== undefined) state.pending = null
    cancel(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => forget(agent))

  // ── the request seam: stored per-model parameters ─────────────────────────
  //
  // Registered on the root context, so it sees every agent's request — the
  // parameters belong to the route, not to one conversation, and a subagent
  // calling the same route should get the same treatment.
  //
  // The whole body is caught. This listener runs inside the loop's request
  // assembly, where a throw is not a lost feature but a failed turn, so an
  // unreachable capability lookup degrades to "the request goes out as it was".
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (disposed) return resolved
    const key = entryKeyOf(resolved?.provider, resolved?.model)
    try {
      const outcome = await applyStoredParams(resolved, payload?.signal)
      if (outcome.applied.length > 0) {
        appliedStats.count += 1
        appliedStats.lastAt = Date.now()
        appliedStats.lastKey = key
        appliedStats.lastApplied = [...outcome.applied]
        logger.debug?.(`ofm-addition: ${key} carries ${outcome.applied.join(', ')}`)
      }
      for (const skip of outcome.skipped) {
        appliedStats.skipped[skip.reason] = (appliedStats.skipped[skip.reason] ?? 0) + 1
        logger.debug?.(`ofm-addition: ${key} kept the session's ${skip.field} (${skip.reason})`)
      }
      return outcome.config
    } catch (error) {
      logger.warn?.(`ofm-addition: per-model parameters skipped for ${key} (${error?.message ?? error})`)
      return resolved
    }
  })

  // ── browser-facing API ────────────────────────────────────────────────────
  // `connection` may mount after this plugin applies, so resolve it per request;
  // the fence falls back to its structural copy while the service is absent.
  function connectionOf() {
    return typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  }

  /**
   * Live agents, newest state first, for the settings page's session list.
   *
   * Each row carries the session's most recent decision, because "why is it not
   * continuing" is answered by the last refusal, not by the counters.
   */
  function liveAgents() {
    const history = stats.get().history ?? []
    const out = []
    for (const [agent, state] of states) {
      if (ctx.agents.get(agent.id) !== agent) continue
      const route = routeOf(agent)
      const last = history.find((row) => row.sessionId === agent.id)
      out.push({
        sessionId: agent.id,
        provider: route.provider,
        model: route.model,
        status: agent.status,
        streak: state.streak,
        fired: state.fired,
        armed: state.pending !== null,
        armedAt: state.pending?.at ?? 0,
        overflowed: state.overflowed === true,
        lastOutcome: last?.outcome ?? '',
        lastOutcomeAt: last?.at ?? 0,
        queued: queuedOf(agent),
        subagent: isSubagent(agent),
      })
    }
    return out.reverse()
  }

  function publicSettings() {
    const current = settings.get()
    const limit = Math.max(0, Number(current.maxContinuations) || 0)
    return {
      enabled: current.enabled === true,
      maxContinuations: limit,
      /** Whether the budget has no ceiling, so the page can render `∞`. */
      unbounded: limit === 0,
      delayMs: resolveDelay(current),
      promptPreset: PROMPT_PRESETS[current.promptPreset] === undefined ? 'explicit' : current.promptPreset,
      prompt: typeof current.prompt === 'string' ? current.prompt : '',
      providers: normalizeList(current.providers),
      models: normalizeList(current.models),
      includeSubagents: current.includeSubagents === true,
      messageMode: current.messageMode === 'notice' ? 'notice' : 'user',
      skipOnTruncatedToolCall: current.skipOnTruncatedToolCall === true,
      contextGuard: current.contextGuard === true,
      contextRatio: resolveContextRatio(current),
      ofmOnly: current.ofmOnly === true,
      ofmProviders: normalizeList(current.ofmProviders).length > 0
        ? normalizeList(current.ofmProviders)
        : [...DEFAULT_SETTINGS.ofmProviders],
      foldContinuations: current.foldContinuations === true,
      showContinueCount: current.showContinueCount === true,
      effectivePrompt: resolvePrompt(current),
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/ofm-addition/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const rejection = rejectionFor(req, connectionOf())
    if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, {
          version: VERSION,
          settings: publicSettings(),
          stats: stats.get(),
          agents: liveAgents(),
          vocabulary: { outcomes: OUTCOME_ORDER, prompts: PROMPT_PRESET_ORDER, presets: PROMPT_PRESETS },
          dataDir,
        })
      }
      if (method === 'GET' && routePath === '/report') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        return send(200, reportFor(sessionId === '' ? undefined : ctx.agents.get(sessionId)))
      }
      if (method === 'POST' && routePath === '/settings') {
        const patch = await readJson(req)
        settings.update(sanitize(patch))
        settings.flush()
        return send(200, { ok: true, settings: publicSettings() })
      }
      if (method === 'POST' && routePath === '/nudge') {
        const body = await readJson(req)
        const wanted = String(body.sessionId ?? '')
        const target = wanted === ''
          ? [...states.keys()].reverse().find((agent) => ctx.agents.get(agent.id) === agent)
          : ctx.agents.get(wanted)
        if (target === undefined) return send(404, { ok: false, outcome: OUTCOME.AGENT_GONE })
        return send(200, await attempt(target, { force: true }))
      }
      if (method === 'GET' && routePath === '/models') {
        return send(200, await modelPage())
      }
      if (method === 'POST' && routePath === '/models/preset') {
        const body = await readJson(req)
        const key = String(body.key ?? '')
        const { provider, model } = splitKey(key)
        if (provider === '' || model === '') return send(400, { error: 'a route key is "provider|model"' })
        const document = params.get()
        if (body.remove === true) {
          const entries = { ...document.entries }
          delete entries[key]
          lastBulk = { at: Date.now(), entries: document.entries }
          params.update({ entries })
          params.flush()
          return send(200, { ok: true, removed: true, entry: null })
        }
        // The live capability list is passed in, so an effort the model does not
        // declare is refused here as well as at the wire.
        const resolved = await factsFor(provider, model)
        const { entry, problems } = sanitizeEntry({ ...(body.entry ?? {}), updatedAt: Date.now() }, resolved)
        lastBulk = { at: Date.now(), entries: document.entries }
        params.update({ entries: { ...document.entries, [key]: entry } })
        params.flush()
        return send(200, { ok: true, key, entry, problems })
      }
      if (method === 'POST' && routePath === '/models/bulk') {
        const body = await readJson(req)
        const table = await roster()
        const rows = new Map(table.models.map((row) => [row.key, row]))
        const previous = params.get().entries
        const entries = { ...previous }
        const problems = []
        let saved = 0
        for (const [key, raw] of Object.entries(body.entries ?? {})) {
          if (typeof key !== 'string' || key === '') continue
          const row = rows.get(key)
          if (row === undefined) {
            problems.push({ key, reason: 'unknown-route' })
            continue
          }
          const { entry, problems: found } = sanitizeEntry({ ...(raw ?? {}), updatedAt: Date.now() }, row)
          entries[key] = entry
          saved += 1
          for (const problem of found) problems.push({ key, reason: problem })
        }
        if (saved === 0) return send(400, { error: 'no known route in this batch', problems })
        lastBulk = { at: Date.now(), entries: previous }
        params.update({ entries })
        params.flush()
        invalidateRoster()
        return send(200, { ok: true, saved, problems, entries })
      }
      if (method === 'POST' && routePath === '/models/scope') {
        const body = await readJson(req)
        const scope = normalizeScope(body.scope)
        lastBulk = { at: Date.now(), entries: params.get().entries }
        params.update({ scope })
        params.flush()
        invalidateRoster()
        return send(200, { ok: true, scope })
      }
      if (method === 'POST' && routePath === '/models/undo') {
        if (lastBulk.entries === undefined) return send(409, { error: 'nothing to undo' })
        params.update({ entries: lastBulk.entries })
        params.flush()
        invalidateRoster()
        lastBulk = { at: 0, entries: undefined }
        return send(200, { ok: true })
      }
      if (method === 'POST' && routePath === '/models/top') {
        const body = await readJson(req)
        const table = await roster()
        const wanted = Array.isArray(body.keys) && body.keys.length > 0
          ? new Set(body.keys.map((value) => String(value)))
          : undefined
        const proposals = {}
        const skipped = []
        for (const row of table.models) {
          if (wanted !== undefined && !wanted.has(row.key)) continue
          const preset = topPreset(row)
          if (preset === null) {
            skipped.push({ key: row.key, reason: 'nothing-to-raise' })
            continue
          }
          proposals[row.key] = preset
        }
        return send(200, { ok: true, proposals, skipped })
      }
      if (method === 'POST' && routePath === '/models/ai') {
        const body = await readJson(req)
        const table = await roster()
        const document = params.get()
        const named = String(body.provider ?? '') !== '' && String(body.model ?? '') !== ''
        const asked = named
          ? { provider: String(body.provider), model: String(body.model), source: 'request' }
          : aiRoute()
        const route = (asked.provider === '' || asked.model === '') && table.models[0] !== undefined
          ? { provider: table.models[0].provider, model: table.models[0].model, source: 'roster' }
          : asked
        // The prompt carries what the page shows: the declared rungs, the
        // advertised ceiling, and whatever is stored today, so a re-run refines
        // rather than overwrites blind.
        const rows = table.models.map((row) => ({
          ...row,
          current: isConfigured(document.entries[row.key]) ? describeEntry(document.entries[row.key], row) : undefined,
        }))
        const prompt = buildAiPrompt({ models: rows, instruction: String(body.instruction ?? '').slice(0, 500) })
        const text = await askModel(route, prompt, document.ai.maxTokens)
        const { proposals, rejected, parsed } = parseAiProposals(text, rows)
        return send(200, { ok: true, route, proposals, rejected, parsed, text: text.slice(0, 4000) })
      }
      if (method === 'POST' && routePath === '/reset') {
        cancelAll()
        stats.update(initialStats())
        stats.flush()
        return send(200, { ok: true })
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      return send(500, { error: String(error?.message ?? error) })
    }
  }

  /** Only accept the fields the plugin actually owns, coerced to their types. */
  function sanitize(patch) {
    const out = {}
    if (patch.enabled !== undefined) out.enabled = patch.enabled === true
    if (patch.maxContinuations !== undefined) {
      const value = Number(patch.maxContinuations)
      // 0 is the documented "no ceiling"; anything unusable falls back rather
      // than silently becoming an unbounded run.
      out.maxContinuations = Number.isFinite(value)
        ? Math.min(Math.max(Math.round(value), 0), 1000)
        : DEFAULT_SETTINGS.maxContinuations
    }
    if (patch.delayMs !== undefined) out.delayMs = resolveDelay({ delayMs: Number(patch.delayMs) })
    if (patch.promptPreset !== undefined && PROMPT_PRESETS[patch.promptPreset] !== undefined) {
      out.promptPreset = patch.promptPreset
    }
    if (patch.prompt !== undefined) out.prompt = String(patch.prompt).slice(0, 4000)
    if (patch.providers !== undefined) out.providers = normalizeList(patch.providers).slice(0, 50)
    if (patch.models !== undefined) out.models = normalizeList(patch.models).slice(0, 50)
    if (patch.includeSubagents !== undefined) out.includeSubagents = patch.includeSubagents === true
    if (patch.messageMode !== undefined) out.messageMode = patch.messageMode === 'notice' ? 'notice' : 'user'
    if (patch.skipOnTruncatedToolCall !== undefined) {
      out.skipOnTruncatedToolCall = patch.skipOnTruncatedToolCall === true
    }
    if (patch.contextGuard !== undefined) out.contextGuard = patch.contextGuard === true
    if (patch.contextRatio !== undefined) out.contextRatio = resolveContextRatio({ contextRatio: Number(patch.contextRatio) })
    if (patch.ofmOnly !== undefined) out.ofmOnly = patch.ofmOnly === true
    if (patch.ofmProviders !== undefined) {
      const patterns = normalizeList(patch.ofmProviders).slice(0, 20)
      out.ofmProviders = patterns.length > 0 ? patterns : [...DEFAULT_SETTINGS.ofmProviders]
    }
    if (patch.foldContinuations !== undefined) out.foldContinuations = patch.foldContinuations === true
    if (patch.showContinueCount !== undefined) out.showContinueCount = patch.showContinueCount === true
    return out
  }

  function cancelAll() {
    for (const agent of [...timers.keys()]) cancel(agent)
    for (const state of states.values()) state.pending = null
  }

  // The web server mounts after the composition applies this plugin on a fresh
  // boot, so an eager `ctx.get('webServer')` reads undefined there and the
  // settings page loses its data source (the 2026-10-02 regression — it used to
  // work only because HMR had added this plugin to an already-running host).
  // `inject` waits for the service; a composition that never mounts one simply
  // never calls back, and the page degrades to its retry card while the
  // continuation feature itself keeps working.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      try {
        const registered = scope.webServer.register({
          kind: 'prefix', path: '/api/ofm-addition', handler: handle,
        })
        logger.info?.('ofm-addition: settings API registered on the web server')
        return registered
      } catch (error) {
        logger.warn?.(`ofm-addition: could not register the settings API (${error?.message ?? error})`)
        return undefined
      }
    }, 'ofm-addition: api routes')
  })

  ctx.effect(() => () => {
    disposed = true
    cancelAll()
    states.clear()
    settings.dispose()
    stats.dispose()
    params.dispose()
  }, 'ofm-addition: teardown')

  logger.debug?.(
    `ofm-addition: armed (enabled=${String(settings.get().enabled === true)},`
    + ` max=${String(settings.get().maxContinuations)},`
    + ` modelRows=${String(Object.keys(params.get().entries).length)}, data=${dataDir})`,
  )
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
