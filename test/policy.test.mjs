/**
 * Offline checks for the continuation policy.
 *
 * The decision core is pure, so these run with nothing but Node: no harness, no
 * install, no timers. The expected values here are written out independently of
 * the implementation — `expectStreak` counts the turns a person would count, it
 * does not call the function under test to find out what it thinks.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTEXT_EXCEEDED_CODE,
  routeAllowed,
  DEFAULT_SETTINGS,
  OUTCOME,
  PROMPT_PRESETS,
  budgetAllows,
  contextPressure,
  createAgentState,
  decide,
  describeBudget,
  isSubagent,
  matchesPattern,
  normalizeList,
  observeAssistantMessage,
  observeTurnEnd,
  observeUserMessage,
  resolveContextRatio,
  resolveDelay,
  resolvePrompt,
  routeMatches,
} from '../src/policy.js'

/** Settings with the fields a case cares about, everything else default. */
const settingsWith = (patch) => ({ ...DEFAULT_SETTINGS, ...patch })

/** A live-agent view shaped exactly like the host half's snapshot. */
const agentView = (patch) => ({
  status: 'idle',
  options: { provider: 'our-free-model', model: 'space-bunny-free' },
  session: { header: { origin: 'workspace' } },
  queued: { nextTurn: 0, nextStep: 0 },
  ...patch,
})

const route = { provider: 'our-free-model', model: 'space-bunny-free' }

test('a truncation arms the agent and counts one turn', () => {
  const state = createAgentState()
  const armed = observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 4, now: 111 })
  assert.notEqual(armed, null)
  assert.equal(state.streak, 1)
  assert.equal(armed.turn, 4)
  assert.equal(armed.at, 111)
  assert.equal(armed.truncatedToolCall, false)
})

test('three truncations in a row count three turns', () => {
  const state = createAgentState()
  for (let turn = 1; turn <= 3; turn += 1) observeTurnEnd(state, { kind: 'max-tokens' }, { turn, now: turn })
  assert.equal(state.streak, 3)
})

test('a normal finish ends the episode and clears both counters', () => {
  const state = createAgentState()
  observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  state.fired = 1
  assert.equal(observeTurnEnd(state, { kind: 'completed' }, { turn: 2, now: 2 }), null)
  assert.equal(state.streak, 0)
  assert.equal(state.fired, 0)
  assert.equal(state.pending, null)
})

test('an aborted turn ends the episode too', () => {
  const state = createAgentState()
  observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  observeTurnEnd(state, { kind: 'aborted', reason: { kind: 'user' } }, { turn: 2, now: 2 })
  assert.equal(state.streak, 0)
  assert.equal(state.pending, null)
})

test('a truncated tool call is remembered at the turn boundary', () => {
  const state = createAgentState()
  observeAssistantMessage(state, { content: [{ type: 'text', text: 'x' }, { type: 'tool-call', name: 'read' }] })
  const armed = observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  assert.equal(armed.truncatedToolCall, true)
  // A later prose-only message clears the classification for the next turn.
  observeAssistantMessage(state, { content: [{ type: 'text', text: 'y' }] })
  assert.equal(observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 2, now: 2 }).truncatedToolCall, false)
})

test('real user input restarts the episode', () => {
  const state = createAgentState()
  observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  state.fired = 2
  assert.equal(observeUserMessage(state, { id: 'u1', source: { kind: 'user' } }), true)
  assert.equal(state.streak, 0)
  assert.equal(state.fired, 0)
  assert.equal(state.pending, null)
})

test('injected context is not user input', () => {
  const state = createAgentState()
  observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  assert.equal(observeUserMessage(state, { id: 'c1', source: { kind: 'agent-instructions', form: 'instructions' } }), false)
  assert.equal(state.streak, 1, 'context injection must not spend the budget back')
})

test("the plugin's own continuation is not user input", () => {
  const state = createAgentState()
  state.ours.add('ours-1')
  observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  state.fired = 1
  assert.equal(observeUserMessage(state, { id: 'ours-1', source: { kind: 'user', ofmAddition: true } }), false)
  assert.equal(state.streak, 1)
  assert.equal(state.fired, 1, 'a self-sent prompt must not reset the budget it was charged to')
  assert.equal(state.ours.size, 0, 'the identity is consumed once')
})

test('the four-turn loop stays inside the budget', () => {
  // This is the regression that matters: if the plugin mistook its own prompt for
  // user input, the budget would reset every round and the session would never stop.
  const state = createAgentState()
  const settings = settingsWith({ maxContinuations: 2, delayMs: 0 })
  const sawOutcomes = []
  for (let turn = 1; turn <= 6; turn += 1) {
    observeTurnEnd(state, { kind: 'max-tokens' }, { turn, now: turn })
    const result = decide({ agent: agentView(), state, settings, route })
    sawOutcomes.push(result.outcome)
    if (!result.ok) break
    const sent = { id: `ours-${turn}`, source: { kind: 'user', ofmAddition: true } }
    state.ours.add(sent.id)
    observeUserMessage(state, sent)
    state.pending = null
    state.fired += 1
  }
  assert.deepEqual(sawOutcomes, [OUTCOME.SENT, OUTCOME.SENT, OUTCOME.BUDGET_SPENT])
})

test('an unlimited budget never runs out', () => {
  const settings = settingsWith({ maxContinuations: 0 })
  const state = createAgentState()
  for (let index = 0; index < 50; index += 1) {
    state.fired = index
    assert.equal(budgetAllows(settings, state), true, `refused at ${index}`)
  }
  assert.equal(describeBudget(settings), '∞')
  assert.equal(describeBudget(settingsWith({ maxContinuations: 3 })), '3')
})

test('an unlimited budget keeps the loop going inside the context', () => {
  const settings = settingsWith({ maxContinuations: 0, delayMs: 0 })
  const state = createAgentState()
  const outcomes = []
  for (let turn = 1; turn <= 6; turn += 1) {
    observeTurnEnd(state, { kind: 'max-tokens' }, { turn, now: turn })
    const result = decide({ agent: agentView(), state, settings, route })
    outcomes.push(result.outcome)
    if (!result.ok) break
    const sent = { id: `ours-${turn}`, source: { kind: 'user', ofmAddition: true } }
    state.ours.add(sent.id)
    observeUserMessage(state, sent)
    state.pending = null
    state.fired += 1
  }
  assert.deepEqual(outcomes, Array(6).fill(OUTCOME.SENT))
  assert.equal(state.fired, 6)
})

test('a measured context at the threshold stops the run', () => {
  const settings = settingsWith({ maxContinuations: 0, contextGuard: true, contextRatio: 0.9 })
  const armed = () => {
    const state = createAgentState()
    observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
    return state
  }
  // Budget for the prompt is 1000 − 200 = 800; 90% of it is 720.
  const measured = (projectedTokens) => ({ known: true, projectedTokens, contextWindow: 1000, reservedTokens: 200 })

  assert.equal(decide({ agent: agentView(), state: armed(), settings, route, context: measured(719) }).ok, true)
  const stopped = decide({ agent: agentView(), state: armed(), settings, route, context: measured(720) })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.outcome, OUTCOME.CONTEXT_FULL)
  assert.equal(stopped.detail, '720 / 720')
  assert.equal(contextPressure(settings, measured(720)).threshold, 720)
  assert.equal(contextPressure(settings, measured(720)).available, 800)
})

test('the guard stands down for an unknown or impossible measurement', () => {
  const settings = settingsWith({ contextGuard: true })
  // Guard off: the measurement never even matters.
  assert.equal(contextPressure(settingsWith({ contextGuard: false }), { known: true, projectedTokens: 10 ** 9, contextWindow: 1 }).limited, false)
  // No measurement at all, or a provider that declares no window: unknown, and
  // an unknown limit must not switch the feature off.
  for (const unknown of [undefined, null, { known: false }, { known: true, contextWindow: 0 }, { known: true, contextWindow: Number.NaN }]) {
    const verdict = contextPressure(settings, unknown)
    assert.equal(verdict.limited, false, JSON.stringify(unknown))
    assert.equal(verdict.unknown, true, JSON.stringify(unknown))
  }
  // A request whose reserved output alone already fills the window.
  const impossible = contextPressure(settings, { known: true, projectedTokens: 1, contextWindow: 1000, reservedTokens: 1000 })
  assert.equal(impossible.limited, true)
  assert.equal(impossible.threshold, 0)
})

test('the guard threshold is clamped into a usable fraction', () => {
  assert.equal(resolveContextRatio({ contextRatio: 0.9 }), 0.9)
  assert.equal(resolveContextRatio({ contextRatio: 0.1 }), 0.5)
  assert.equal(resolveContextRatio({ contextRatio: 9 }), 1)
  assert.equal(resolveContextRatio({ contextRatio: 'x' }), DEFAULT_SETTINGS.contextRatio)
  // At 100% only the literal limit stops it.
  const settings = settingsWith({ contextRatio: 1 })
  const context = { known: true, projectedTokens: 799, contextWindow: 1000, reservedTokens: 200 }
  assert.equal(contextPressure(settings, context).limited, false)
  assert.equal(contextPressure(settings, { ...context, projectedTokens: 800 }).limited, true)
})

test('a route refusal outranks a full context', () => {
  // Both are true; the actionable reason is the one a person can act on.
  const state = createAgentState()
  observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  const result = decide({
    agent: agentView(),
    state,
    settings: settingsWith({ providers: ['opencode-go'], ofmOnly: false, contextGuard: true }),
    route,
    context: { known: true, projectedTokens: 999, contextWindow: 1000, reservedTokens: 0 },
  })
  assert.equal(result.outcome, OUTCOME.ROUTE_FILTERED)
})

test('an overflow ending is recognized and ordinary failures are not', () => {
  const overflow = createAgentState()
  observeTurnEnd(overflow, { kind: 'error', error: { code: CONTEXT_EXCEEDED_CODE, message: 'too long' } }, { turn: 1, now: 1 })
  assert.equal(overflow.overflowed, true)
  assert.equal(overflow.pending, null)

  const other = createAgentState()
  observeTurnEnd(other, { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }, { turn: 1, now: 1 })
  assert.equal(other.overflowed, false)

  const truncated = createAgentState()
  observeTurnEnd(truncated, { kind: 'max-tokens' }, { turn: 1, now: 1 })
  assert.equal(truncated.overflowed, false)

  // A fresh truncation clears the sticky flag so the page stops reporting it.
  observeTurnEnd(overflow, { kind: 'max-tokens' }, { turn: 2, now: 2 })
  assert.equal(overflow.overflowed, false)
})

test('decide refuses in the documented order', () => {
  const armed = () => {
    const state = createAgentState()
    observeTurnEnd(state, { kind: 'max-tokens' }, { turn: 1, now: 1 })
    return state
  }
  const allow = settingsWith({ maxContinuations: 3 })

  assert.equal(decide({ agent: agentView(), state: armed(), settings: allow, route, disposed: true }).outcome, OUTCOME.DISPOSED)
  assert.equal(decide({ agent: agentView(), state: armed(), settings: settingsWith({ enabled: false }), route }).outcome, OUTCOME.DISABLED)
  assert.equal(decide({ agent: agentView(), state: createAgentState(), settings: allow, route }).outcome, OUTCOME.NO_PENDING)
  assert.equal(decide({ agent: undefined, state: armed(), settings: allow, route }).outcome, OUTCOME.AGENT_GONE)
  assert.equal(decide({ agent: agentView({ status: 'running' }), state: armed(), settings: allow, route }).outcome, OUTCOME.AGENT_BUSY)
  assert.equal(
    decide({ agent: agentView({ queued: { nextTurn: 1, nextStep: 0 } }), state: armed(), settings: allow, route }).outcome,
    OUTCOME.USER_DRIVING,
  )
  const spent = armed()
  spent.fired = 3
  assert.equal(decide({ agent: agentView(), state: spent, settings: allow, route }).outcome, OUTCOME.BUDGET_SPENT)
  assert.equal(
    decide({
      agent: agentView({ options: { provider: 'our-free-model', model: 'x', subagentDepth: 1 } }),
      state: armed(),
      settings: allow,
      route,
    }).outcome,
    OUTCOME.SUBAGENT_FILTERED,
  )
  assert.equal(
    decide({ agent: agentView(), state: armed(), settings: settingsWith({ providers: ['opencode-go'], ofmOnly: false }), route }).outcome,
    OUTCOME.ROUTE_FILTERED,
  )
  const toolCut = armed()
  toolCut.pending.truncatedToolCall = true
  assert.equal(
    decide({ agent: agentView(), state: toolCut, settings: settingsWith({ skipOnTruncatedToolCall: true }), route }).outcome,
    OUTCOME.TOOL_CALL_TRUNCATED,
  )
  assert.equal(
    decide({
      agent: agentView(),
      state: armed(),
      settings: settingsWith({ maxContinuations: 3, contextGuard: true }),
      route,
      context: { known: true, projectedTokens: 500, contextWindow: 500, reservedTokens: 0 },
    }).outcome,
    OUTCOME.CONTEXT_FULL,
  )
  assert.equal(decide({ agent: agentView(), state: armed(), settings: allow, route }).ok, true)
})

test('ofmOnly overrides the general allow-list instead of intersecting with it', () => {
  const ours = { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' }
  const theirs = { provider: 'opencode-go', model: 'x' }
  // On: our routes pass even with an unrelated allow-list, and theirs never do.
  assert.equal(routeAllowed(settingsWith({ ofmOnly: true, providers: ['opencode-go*'] }), ours), true)
  assert.equal(routeAllowed(settingsWith({ ofmOnly: true }), theirs), false)
  // A narrower "ours" list still narrows.
  assert.equal(routeAllowed(settingsWith({ ofmOnly: true, ofmProviders: ['our-free-model-region'] }), ours), false)
  // Off: the general allow-list takes over, both ways.
  assert.equal(routeAllowed(settingsWith({ ofmOnly: false, providers: ['opencode-go*'] }), theirs), true)
  assert.equal(routeAllowed(settingsWith({ ofmOnly: false }), ours), true)
  assert.equal(routeAllowed(settingsWith({ ofmOnly: false, providers: ['our-free-model'] }), theirs), false)
})

test('a subagent is recognized two ways', () => {
  assert.equal(isSubagent({ options: { subagentDepth: 2 }, session: { header: {} } }), true)
  assert.equal(isSubagent({ options: {}, session: { header: { origin: 'subagent' } } }), true)
  assert.equal(isSubagent({ options: {}, session: { header: { origin: 'workspace' } } }), false)
  assert.equal(isSubagent(undefined), false)
})

test('wildcards cover the provider family without covering everything', () => {
  assert.equal(matchesPattern('our-free-model*', 'our-free-model'), true)
  assert.equal(matchesPattern('our-free-model*', 'our-free-model-region-limited'), true)
  assert.equal(matchesPattern('our-free-model*', 'opencode-go'), false)
  assert.equal(matchesPattern('*', 'anything'), true)
  assert.equal(matchesPattern('mimo-*-free', 'mimo-v2.6-flash-free'), true)
  assert.equal(matchesPattern('mimo-*-free', 'mimo-v2.6-flash'), false)
  assert.equal(matchesPattern('exact', 'exact'), true)
  assert.equal(matchesPattern('exact', 'exactly'), false)
})

test('an empty allow-list means everything, a filled one means only those', () => {
  assert.equal(routeMatches(settingsWith({}), route), true)
  assert.equal(routeMatches(settingsWith({ providers: ['our-free-model*'] }), route), true)
  assert.equal(routeMatches(settingsWith({ providers: ['opencode-go'], ofmOnly: false }), route), false)
  assert.equal(routeMatches(settingsWith({ models: ['space-bunny-free'], ofmOnly: false }), route), true)
  assert.equal(routeMatches(settingsWith({ models: ['mimo*'], ofmOnly: false }), route), false)
})

test('a stored list tolerates newlines, commas, blanks, and repeats', () => {
  assert.deepEqual(normalizeList('a\nb, c\n\n a '), ['a', 'b', 'c'])
  assert.deepEqual(normalizeList(['x', ' x ', '', null]), ['x'])
  assert.deepEqual(normalizeList(undefined), [])
})

test('the custom prompt wins, an unknown preset falls back to explicit', () => {
  assert.equal(resolvePrompt({ prompt: '  接着写  ', promptPreset: 'simple' }), '接着写')
  assert.equal(resolvePrompt({ prompt: '   ', promptPreset: 'simple' }), PROMPT_PRESETS.simple)
  assert.equal(resolvePrompt({ promptPreset: 'nonsense' }), PROMPT_PRESETS.explicit)
  assert.equal(resolvePrompt({}), PROMPT_PRESETS.explicit)
})

test('a stored delay is clamped into something a timer can hold', () => {
  assert.equal(resolveDelay({ delayMs: 250 }), 250)
  assert.equal(resolveDelay({ delayMs: -5 }), DEFAULT_SETTINGS.delayMs)
  assert.equal(resolveDelay({ delayMs: 'abc' }), DEFAULT_SETTINGS.delayMs)
  assert.equal(resolveDelay({ delayMs: 10 ** 9 }), 30_000)
})
