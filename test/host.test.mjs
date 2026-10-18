/**
 * Offline checks for the host half.
 *
 * A fake cordis context stands in for the harness: it records listeners, hands
 * back the plugins the host half reaches for, and lets the test replay exactly
 * the event sequence the agent loop emits around a truncation. Nothing here
 * boots DSH, so a broken rule is found before it can cost a real session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name, inject, VERSION } from '../index.js'

// ── the fake harness ────────────────────────────────────────────────────────

let tmpRoot = ''

/** A throwaway DSH home per case, seeded with the settings the case wants. */
function useHome(settings, modelParams) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-addition-'))
  fs.mkdirSync(path.join(tmpRoot, 'ofm-addition'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'ofm-addition', 'settings.json'), JSON.stringify(settings ?? {}))
  if (modelParams !== undefined) {
    fs.writeFileSync(path.join(tmpRoot, 'ofm-addition', 'params.json'), JSON.stringify(modelParams))
  }
  process.env.DSH_HOME = tmpRoot
  return tmpRoot
}

/** The stored parameter table, read back after teardown flushed it. */
function readParams() {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ofm-addition', 'params.json'), 'utf8'))
  } catch {
    return { entries: {} }
  }
}

/**
 * A model service with the shape the harness exposes.
 *
 * The catalog is deliberately wider than the scope so the scope filter is
 * exercised rather than assumed, and one route has no rung menu and one has no
 * capacity at all, which are the two shapes the page must not lie about.
 */
function fakeModels() {
  const catalog = {
    'our-free-model': [
      {
        id: 'space-bunny-free',
        name: 'Space Bunny',
        contextWindow: 1000000,
        defaultMaxTokens: 32768,
        efforts: [{ id: 'light', name: 'Light' }, { id: 'deep', name: 'Deep' }],
        defaultEffort: 'light',
        vision: true,
      },
      { id: 'mimo-flash-free', name: 'Mimo', contextWindow: 131072, defaultMaxTokens: 8192, efforts: [], vision: false },
      { id: 'no-capacity-free', name: 'No Capacity', contextWindow: 65536, defaultMaxTokens: undefined, efforts: [], vision: false },
    ],
    'our-free-model-region': [
      {
        id: 'region-free',
        name: 'Region',
        contextWindow: 200000,
        defaultMaxTokens: 16384,
        efforts: [{ id: 'balanced', name: 'Balanced' }],
        defaultEffort: 'balanced',
        vision: false,
      },
    ],
    'workbuddy-global': [
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', contextWindow: 1000000, defaultMaxTokens: 128000, efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high', vision: false },
    ],
  }
  const seen = []
  const service = {
    calls: seen,
    listProviders: () => Object.keys(catalog).map((id) => ({ id, name: id })),
    listModels: async (provider) =>
      (catalog[provider] ?? []).map((row) => ({
        provider,
        id: row.id,
        name: row.name,
        inputModalities: row.vision ? ['text', 'image'] : ['text'],
      })),
    resolveModelInfo: async (provider, model) => {
      const row = (catalog[provider] ?? []).find((candidate) => candidate.id === model)
      if (row === undefined) throw new Error('unknown model')
      return {
        provider,
        id: model,
        name: row.name,
        inputModalities: row.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow: row.contextWindow },
        ...(row.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: row.defaultMaxTokens }),
        ...(row.efforts.length === 0
          ? {}
          : { reasoning: { efforts: row.efforts, defaultEffort: row.defaultEffort } }),
      }
    },
    async *stream(options) {
      seen.push(options)
      yield { type: 'text-delta', index: 0, text: service.answer }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    answer: '{"entries":{}}',
  }
  return service
}

/** Drive the plugin's own request seam exactly the way the loop drives it. */
async function runRequest(harness, seed, agent) {
  const listeners = harness.listeners.get('agent/request') ?? []
  assert.equal(listeners.length, 1, 'the plugin registers exactly one request listener')
  const listener = listeners[0]
  return listener({ agent, turn: 1, step: 1, signal: undefined }, async () => seed)
}

/** A live agent with just enough surface for the plugin to read. */
class FakeAgent {
  constructor(id, { provider = 'our-free-model', model = 'space-bunny-free', subagent = false } = {}) {
    this.id = id
    this.status = 'idle'
    this.options = { provider, model, ...(subagent ? { subagentDepth: 1 } : {}) }
    this.session = {
      id,
      header: { id, origin: subagent ? 'subagent' : 'workspace' },
      requestHeader: () => ({ config: { provider, model } }),
    }
    this.inbox = { nextTurn: [], nextStep: [] }
    this.sent = []
    // The durable log the report derives from, as the real Session keeps one.
    this.session.log = []
  }

  followup(message) {
    if (this.refuse === true) throw new Error('inbox refused')
    this.sent.push(message)
  }
}

/** A `tokenMeter` that always prices the next prompt the same way. */
function fakeMeter(totalTokens) {
  return { measure: () => ({ totalTokens, nodes: [], baseline: { kind: 'estimated', tokens: totalTokens }, surfaceDeltaTokens: 0 }) }
}

/** An `llm` service exposing just the model metadata the guard reads. */
function fakeLlm(contextWindow, defaultMaxTokens) {
  return {
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    }),
  }
}

/** A cordis context that records wiring and can replay the loop's events. */
function makeCtx(agents, services = {}) {
  const listeners = new Map()
  const disposers = []
  const routes = []
  const logs = []
  const ctx = {
    logger: {
      debug: (line) => logs.push(['debug', line]),
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
    },
    agents: { get: (id) => agents.get(id) },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => listeners.set(event, bucket.filter((entry) => entry !== listener))
    },
    effect(fn) {
      const result = fn()
      if (typeof result === 'function') disposers.push(result)
      return result
    },
    get(service) {
      if (service === 'webServer') {
        return { register: (route) => { routes.push(route); return () => {} } }
      }
      return services[service]
    },
    // The harness models an already-mounted web server: the inject callback
    // runs synchronously against a child-like scope that exposes the service
    // as a property (as the real cordis scope does) and falls back to `get`.
    inject(deps, cb) {
      cb({ ...ctx, webServer: ctx.get('webServer') })
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
  return { ctx, listeners, disposers, routes, logs }
}

/** The event the agent loop appends when a turn ends. */
function endTurn(harness, agent, reason, turn = 1) {
  harness.ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    seq: turn * 10,
    time: 1_700_000_000_000 + turn,
    data: { turn, reason },
  })
}

/** The idle edge the loop publishes once the turn is over. */
async function goIdle(harness, agent) {
  agent.status = 'idle'
  harness.ctx.emit('agent/status', { agent, status: 'idle' })
  // The attempt asks the harness for a context measurement before it acts, so a
  // send lands a microtask after the edge rather than inline with it.
  await tick(0)
}

/** The assistant message the loop appends just before a truncation. */
function assistantMessage(harness, agent, content, turn = 1) {
  harness.ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    seq: turn * 10 - 1,
    time: 1_700_000_000_000 + turn,
    data: { turn, step: 1, message: { id: `m${turn}`, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } } },
  })
}

/** A durable user message, as the client controller would append it. */
function userMessage(harness, agent, message) {
  harness.ctx.emit('session/event', agent.session, {
    type: 'user/message',
    seq: 0,
    time: Date.now(),
    data: message,
  })
}

/** A minimal request/response pair for the plugin's own routes. */
function callRoute(harness, routePath, { method = 'GET', body } = {}) {
  const handler = harness.routes[0].handler
  const payload = body === undefined ? '' : JSON.stringify(body)
  const chunks = payload === '' ? [] : [Buffer.from(payload, 'utf8')]
  const req = Object.assign(
    (async function* request() {
      for (const chunk of chunks) yield chunk
    })(),
    { url: `/api/ofm-addition${routePath}`, method, headers: { host: '127.0.0.1:3000' } },
  )
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (value) => {
      text = value
    },
  }
  return handler(req, res).then(() => ({ status, body: text === '' ? {} : JSON.parse(text) }))
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Tear the plugin down — which is what flushes both stores — then read the
 * counters back. Asserting on the file before teardown would race the debounced
 * write, which is a property of the store rather than of the rule under test.
 */
function teardown(harness) {
  harness.disposers.forEach((dispose) => dispose())
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ofm-addition', 'stats.json'), 'utf8'))
    // A plugin that never recorded anything never wrote the document.
    return { sent: 0, history: [], ...parsed, outcomes: { ...(parsed.outcomes ?? {}) } }
  } catch {
    return { sent: 0, history: [], outcomes: {} }
  }
}

// ── cases ───────────────────────────────────────────────────────────────────

test('the module exports the shape a bundle patch mounts', () => {
  assert.equal(name, 'ofm-addition')
  assert.deepEqual(inject, ['agents', 'sessions'])
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})

test('a truncated turn is answered with one continuation prompt', async () => {
  useHome({ delayMs: 0, maxContinuations: 3 })
  const agent = new FakeAgent('sess-1')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  assert.equal(agent.sent.length, 0, 'nothing is sent before the session is idle')
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 1)
  const message = agent.sent[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.equal(message.source.ofmAddition, true)
  assert.deepEqual(message.content, [{ type: 'text', text: '继续 —— 上一条回答因达到输出上限被截断。请从中断处接着写，不要重述已经写过的内容，也不要重新开头。' }])
  assert.equal(typeof message.id, 'string')
  assert.equal(Object.isFrozen(message), true, 'messages are published frozen')

  harness.disposers.forEach((dispose) => dispose())
})

test('a normal finish never triggers anything', async () => {
  useHome({ delayMs: 0 })
  const agent = new FakeAgent('sess-2')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'completed' })
  await goIdle(harness, agent)
  assert.equal(agent.sent.length, 0)

  endTurn(harness, agent, { kind: 'aborted', reason: { kind: 'user' } })
  await goIdle(harness, agent)
  assert.equal(agent.sent.length, 0)

  harness.disposers.forEach((dispose) => dispose())
})

test('the budget stops the loop instead of running forever', async () => {
  useHome({ delayMs: 0, maxContinuations: 2 })
  const agent = new FakeAgent('sess-3')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  // Five truncated turns in a row, each one exactly as the loop would emit it.
  for (let turn = 1; turn <= 5; turn += 1) {
    assistantMessage(harness, agent, [{ type: 'text', text: `part ${turn}` }], turn)
    endTurn(harness, agent, { kind: 'max-tokens' }, turn)
    await goIdle(harness, agent)
    // The loop claims the prompt, which appends the durable user message.
    const claimed = agent.sent[turn - 1]
    if (claimed !== undefined) userMessage(harness, agent, { id: claimed.id, role: 'user', source: { kind: 'user', ofmAddition: true }, content: claimed.content })
  }

  assert.equal(agent.sent.length, 2, 'exactly the configured number of prompts is sent')
  const stats = teardown(harness)
  assert.equal(stats.sent, 2)
  assert.equal(stats.outcomes['budget-spent'], 3, 'every later turn is refused, not silently dropped')
})

test('typing during the quiet period wins', async () => {
  useHome({ delayMs: 60, maxContinuations: 3 })
  const agent = new FakeAgent('sess-4')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  assert.equal(agent.sent.length, 0, 'the prompt waits out the quiet period')

  // The person types before the timer fires. In the real loop that is a
  // `followup`, which wakes the driver, so the session is running by the time
  // the quiet period ends.
  agent.inbox.nextTurn.push({ id: 'typed', role: 'user', source: { kind: 'user' }, content: [] })
  agent.status = 'running'
  await tick(120)

  assert.equal(agent.sent.length, 0, 'queued user input outranks the plugin')
  assert.equal(teardown(harness).outcomes['agent-busy'], 1)
})

test('input sitting in the inbox is enough to stand down', async () => {
  // `inject` (unlike `followup`) queues without waking the driver, so the
  // session stays idle with work already waiting — the other half of the
  // "somebody else got there first" guard.
  useHome({ delayMs: 60, maxContinuations: 3 })
  const agent = new FakeAgent('sess-4b')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  agent.inbox.nextStep.push({ id: 'injected', role: 'user', source: { kind: 'tool-jobs' }, content: [] })
  await tick(120)

  assert.equal(agent.sent.length, 0)
  assert.equal(teardown(harness).outcomes['user-driving'], 1)
})

test('real user input before the truncation resets the episode', async () => {
  useHome({ delayMs: 0, maxContinuations: 2 })
  const agent = new FakeAgent('sess-5')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  userMessage(harness, agent, { id: 'typed', role: 'user', source: { kind: 'user' }, content: [] })
  await goIdle(harness, agent)
  assert.equal(agent.sent.length, 0, 'the armed truncation was consumed by the person typing')

  harness.disposers.forEach((dispose) => dispose())
})

test('the route filter and the subagent switch both hold', async () => {
  useHome({ delayMs: 0, providers: ['opencode-go*'], ofmOnly: false })
  const main = new FakeAgent('sess-6')
  const child = new FakeAgent('sess-7', { subagent: true })
  const harness = makeCtx(new Map([[main.id, main], [child.id, child]]))
  apply(harness.ctx, {})

  endTurn(harness, main, { kind: 'max-tokens' })
  await goIdle(harness, main)
  assert.equal(main.sent.length, 0, 'an out-of-scope provider is left alone')

  endTurn(harness, child, { kind: 'max-tokens' })
  await goIdle(harness, child)
  assert.equal(child.sent.length, 0)

  const stats = teardown(harness)
  assert.equal(stats.outcomes['route-filtered'], 1)
  assert.equal(stats.outcomes['subagent-filtered'], 1)
})

test('a truncation inside a tool call is skipped when asked', async () => {
  useHome({ delayMs: 0, skipOnTruncatedToolCall: true })
  const agent = new FakeAgent('sess-8')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  assistantMessage(harness, agent, [{ type: 'text', text: 'let me read' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a' }])
  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 0)
  assert.equal(teardown(harness).outcomes['tool-call-truncated'], 1)
})

test('an arming is spent even when the attempt is refused', async () => {
  // The refusal is terminal by design, so a later idle edge with no new
  // truncation behind it cannot resurrect the same continuation.
  useHome({ delayMs: 0, providers: ['opencode-go'], ofmOnly: false, maxContinuations: 3 })
  const agent = new FakeAgent('sess-8b')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  assert.equal(agent.sent.length, 0)

  const afterRefusal = await callRoute(harness, '/summary')
  assert.equal(afterRefusal.body.agents[0].armed, false, 'the arming is consumed by the refusal')

  // The session cycles idle → running → idle, and now the route would match.
  agent.status = 'running'
  harness.ctx.emit('agent/status', { agent, status: 'running' })
  agent.options.provider = 'our-free-model'
  agent.session.requestHeader = () => ({ config: { provider: 'our-free-model', model: 'space-bunny-free' } })
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 0, 'nothing fires without a fresh truncation behind it')

  harness.disposers.forEach((dispose) => dispose())
})

test('an unlimited budget keeps sending while the context has room', async () => {
  useHome({ delayMs: 0, maxContinuations: 0, contextGuard: true, contextRatio: 0.9 })
  const agent = new FakeAgent('sess-20')
  const harness = makeCtx(new Map([[agent.id, agent]]), {
    tokenMeter: fakeMeter(100),
    llm: fakeLlm(1000, 100),
  })
  apply(harness.ctx, {})

  // Six truncated turns in a row: an unlimited budget must answer all of them.
  for (let turn = 1; turn <= 6; turn += 1) {
    assistantMessage(harness, agent, [{ type: 'text', text: `part ${turn}` }], turn)
    endTurn(harness, agent, { kind: 'max-tokens' }, turn)
    await goIdle(harness, agent)
    const claimed = agent.sent[turn - 1]
    if (claimed !== undefined) userMessage(harness, agent, { id: claimed.id, role: 'user', source: { kind: 'user', ofmAddition: true }, content: claimed.content })
  }

  assert.equal(agent.sent.length, 6)
  const stats = teardown(harness)
  assert.equal(stats.sent, 6)
  assert.equal(stats.outcomes['budget-spent'], undefined)
})

test('the context guard stops an unlimited budget', async () => {
  // Window 1000, reserved 200 ⇒ the prompt has 800; 90% of that is 720.
  const cases = [
    { projected: 719, sent: true, label: 'just inside' },
    { projected: 720, sent: false, label: 'exactly at the threshold' },
    { projected: 900, sent: false, label: 'well past it' },
  ]
  const seen = []
  for (const [index, testCase] of cases.entries()) {
    const home = useHome({ delayMs: 0, maxContinuations: 0, contextGuard: true, contextRatio: 0.9 })
    const agent = new FakeAgent(`sess-21-${index}`)
    const harness = makeCtx(new Map([[agent.id, agent]]), {
      tokenMeter: fakeMeter(testCase.projected),
      llm: fakeLlm(1000, 200),
    })
    apply(harness.ctx, {})

    endTurn(harness, agent, { kind: 'max-tokens' })
    await goIdle(harness, agent)

    assert.equal(agent.sent.length, testCase.sent ? 1 : 0, testCase.label)
    const stats = teardown(harness)
    seen.push(stats.outcomes['context-full'] ?? 0)
    assert.ok(home !== '')
  }
  assert.deepEqual(seen, [0, 1, 1], 'only the measured overflow bands refuse')
})

test('a composition with no way to measure still continues', async () => {
  // Neither service mounted: the guard must fail open, not switch the feature off.
  useHome({ delayMs: 0, maxContinuations: 0, contextGuard: true })
  const agent = new FakeAgent('sess-22')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 1)
  assert.equal(teardown(harness).outcomes['context-full'], undefined)
})

test('an adapter that declares no window is not treated as no room', async () => {
  useHome({ delayMs: 0, maxContinuations: 0, contextGuard: true })
  const agent = new FakeAgent('sess-23')
  const harness = makeCtx(new Map([[agent.id, agent]]), {
    tokenMeter: fakeMeter(999_999),
    llm: fakeLlm(undefined, undefined),
  })
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 1)
  assert.equal(teardown(harness).outcomes['context-full'], undefined)
})

test('a real overflow ending is recorded and clears the session', async () => {
  useHome({ delayMs: 0, maxContinuations: 0, contextGuard: true })
  const agent = new FakeAgent('sess-24')
  const harness = makeCtx(new Map([[agent.id, agent]]), {
    tokenMeter: fakeMeter(10),
    llm: fakeLlm(1000, 100),
  })
  apply(harness.ctx, {})

  // One continuation, then the session dies on the window.
  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  assert.equal(agent.sent.length, 1)

  endTurn(harness, agent, { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } }, 2)
  const armed = await callRoute(harness, '/summary')
  assert.equal(armed.body.agents[0].overflowed, true, 'the page reports why the run stopped')
  assert.equal(armed.body.agents[0].streak, 0)

  const stats = teardown(harness)
  assert.equal(stats.outcomes['context-overflow'], 1)

  // A plugin that never drove the episode does not claim the overflow.
  useHome({ delayMs: 0, maxContinuations: 0 })
  const idle = new FakeAgent('sess-25')
  const quiet = makeCtx(new Map([[idle.id, idle]]))
  apply(quiet.ctx, {})
  endTurn(quiet, idle, { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } })
  assert.equal(teardown(quiet).outcomes['context-overflow'], undefined)
})

test('the routes accept the unlimited and guard settings', async () => {
  useHome({ delayMs: 0 })
  const harness = makeCtx(new Map())
  apply(harness.ctx, {})

  const before = await callRoute(harness, '/summary')
  assert.equal(before.body.settings.maxContinuations, 3)
  assert.equal(before.body.settings.unbounded, false)
  assert.equal(before.body.settings.contextGuard, true)
  assert.equal(before.body.settings.contextRatio, 0.9)

  const saved = await callRoute(harness, '/settings', {
    method: 'POST',
    body: { maxContinuations: 0, contextGuard: false, contextRatio: 5 },
  })
  assert.equal(saved.body.settings.maxContinuations, 0)
  assert.equal(saved.body.settings.unbounded, true)
  assert.equal(saved.body.settings.contextGuard, false)
  assert.equal(saved.body.settings.contextRatio, 1, 'an out-of-range fraction is clamped, not stored raw')

  const negative = await callRoute(harness, '/settings', { method: 'POST', body: { maxContinuations: -4 } })
  assert.equal(negative.body.settings.maxContinuations, 0)

  const huge = await callRoute(harness, '/settings', { method: 'POST', body: { maxContinuations: 99999 } })
  assert.equal(huge.body.settings.maxContinuations, 1000)

  harness.disposers.forEach((dispose) => dispose())
})

test('the notice presentation tags the turn as plugin-triggered', async () => {
  useHome({ delayMs: 0, messageMode: 'notice' })
  const agent = new FakeAgent('sess-9')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 1)
  assert.equal(agent.sent[0].source.kind, 'ofm-addition')
  assert.equal(agent.sent[0].source.form, 'notice')
  assert.equal(agent.sent[0].source.summary.length <= 120, true)

  harness.disposers.forEach((dispose) => dispose())
})

test('a refused queue does not silently spend a continuation', async () => {
  useHome({ delayMs: 0, maxContinuations: 3 })
  const agent = new FakeAgent('sess-10')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  agent.refuse = true
  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)

  agent.refuse = false
  endTurn(harness, agent, { kind: 'max-tokens' }, 2)
  await goIdle(harness, agent)

  assert.equal(agent.sent.length, 1, 'the failed send is retried on the next truncation')
  assert.equal(harness.logs.some(([, line]) => line.includes('could not queue')), true)

  harness.disposers.forEach((dispose) => dispose())
})

test('a disposed agent is forgotten and teardown sends nothing', async () => {
  useHome({ delayMs: 40, maxContinuations: 3 })
  const agents = new Map()
  const agent = new FakeAgent('sess-11')
  agents.set(agent.id, agent)
  const harness = makeCtx(agents)
  apply(harness.ctx, {})

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  harness.ctx.emit('agent/disposed', { agent })
  await tick(90)
  assert.equal(agent.sent.length, 0)

  endTurn(harness, agent, { kind: 'max-tokens' }, 2)
  await goIdle(harness, agent)
  harness.disposers.forEach((dispose) => dispose())
  await tick(90)
  assert.equal(agent.sent.length, 0, 'nothing is sent after the plugin is torn down')

  harness.disposers.forEach((dispose) => dispose())
})

test('the routes serve the settings page and can force one continuation', async () => {
  useHome({ delayMs: 0, maxContinuations: 3 })
  const agent = new FakeAgent('sess-12')
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].path, '/api/ofm-addition')

  const summary = await callRoute(harness, '/summary')
  assert.equal(summary.status, 200)
  assert.equal(summary.body.settings.enabled, true)
  assert.equal(summary.body.settings.maxContinuations, 3)
  assert.match(summary.body.settings.effectivePrompt, /^继续/)
  assert.deepEqual(summary.body.agents, [])

  const saved = await callRoute(harness, '/settings', { method: 'POST', body: { maxContinuations: 1, prompt: '', junk: 'ignored' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.maxContinuations, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ofm-addition', 'settings.json'), 'utf8')).junk, undefined)

  endTurn(harness, agent, { kind: 'max-tokens' })
  const afterArm = await callRoute(harness, '/summary')
  assert.equal(afterArm.body.agents.length, 1)
  assert.equal(afterArm.body.agents[0].armed, true)
  assert.equal(afterArm.body.agents[0].subagent, false)

  // The manual nudge works with the session idle, and reports its refusal once
  // the session is running instead of queueing a second prompt.
  const nudged = await callRoute(harness, '/nudge', { method: 'POST', body: { sessionId: agent.id } })
  assert.equal(nudged.body.ok, true)
  assert.equal(agent.sent.length, 1)
  agent.status = 'running'
  const refused = await callRoute(harness, '/nudge', { method: 'POST', body: { sessionId: agent.id } })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.outcome, 'agent-busy')

  const missing = await callRoute(harness, '/nudge', { method: 'POST', body: { sessionId: 'nope' } })
  assert.equal(missing.status, 404)

  const cleared = await callRoute(harness, '/reset', { method: 'POST' })
  assert.equal(cleared.status, 200)
  const clearedSummary = await callRoute(harness, '/summary')
  assert.equal(clearedSummary.body.stats.sent, 0)

  const unknown = await callRoute(harness, '/nope')
  assert.equal(unknown.status, 404)

  harness.disposers.forEach((dispose) => dispose())
})

test('the report folds a run and stays out of scope elsewhere', async () => {
  useHome({ delayMs: 0, maxContinuations: 0 })
  const agent = new FakeAgent('sess-30')
  const harness = makeCtx(new Map([[agent.id, agent]]), { tokenMeter: fakeMeter(10), llm: fakeLlm(1000) })
  apply(harness.ctx, {})

  // A run, written the way the harness appends it: the person acts, the turn
  // truncates, the plugin continues, the model finishes.
  agent.session.log.push(
    { type: 'user/message', seq: 1, time: 1, data: { id: 'person', role: 'user', source: { kind: 'user' }, content: [] } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 7, reason: { kind: 'max-tokens' } } },
    { type: 'user/message', seq: 3, time: 3, data: { id: 'ours-1', role: 'user', source: { kind: 'user', ofmAddition: true }, content: [] } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 8, message: { id: 'a-final', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 8, reason: { kind: 'completed' } } },
  )

  const report = await callRoute(harness, '/report?sessionId=' + agent.id)
  assert.equal(report.body.scoped, true)
  assert.equal(report.body.fold, true)
  assert.equal(report.body.annotate, true)
  assert.deepEqual(report.body.ids, ['ours-1'])
  assert.deepEqual(report.body.turns, [7], 'the truncation it answered folds away')
  assert.equal(report.body.finals.length, 1)
  assert.equal(report.body.finals[0].messageId, 'a-final')
  assert.equal(report.body.finals[0].count, 1)
  assert.equal(report.body.finals[0].endedBy, 'completed')

  // A session on another provider gets an empty report, and the browser half
  // then leaves that transcript alone.
  const stranger = new FakeAgent('sess-31', { provider: 'opencode-go', model: 'x' })
  harness.ctx.agents = undefined
  const agentsMap = new Map([[agent.id, agent], [stranger.id, stranger]])
  harness.ctx.agents = { get: (id) => agentsMap.get(id) }
  stranger.session.log = agent.session.log
  const outOfScope = await callRoute(harness, '/report?sessionId=' + stranger.id)
  assert.equal(outOfScope.body.scoped, false)
  assert.deepEqual(outOfScope.body.ids, [])

  const missing = await callRoute(harness, '/report')
  assert.equal(missing.body.scoped, false)

  harness.disposers.forEach((dispose) => dispose())
})

test('the route fence refuses a non-loopback host', async () => {
  useHome({ delayMs: 0 })
  const harness = makeCtx(new Map())
  apply(harness.ctx, {})

  const handler = harness.routes[0].handler
  const req = Object.assign(
    (async function* request() {})(),
    { url: '/api/ofm-addition/summary', method: 'GET', headers: { host: 'evil.example.com' } },
  )
  let status = 0
  await handler(req, { writeHead: (code) => { status = code }, end: () => {} })
  assert.equal(status, 403)

  harness.disposers.forEach((dispose) => dispose())
})

// ── per-model request parameters ────────────────────────────────────────────

test('the model page lists every scoped route with its stored row and its maximum', async () => {
  useHome({}, {
    scope: ['our-free-model*'],
    entries: {
      'our-free-model|space-bunny-free': { enabled: true, effort: 'deep', effortMode: 'preset', maxTokens: 32768, temperature: null, stop: [], note: '', updatedAt: 1 },
    },
  })
  const agents = new Map()
  const models = fakeModels()
  const harness = makeCtx(agents, { llm: models })
  apply(harness.ctx, {})

  const { status, body } = await callRoute(harness, '/models')
  assert.equal(status, 200)
  assert.deepEqual(body.providers.sort(), ['our-free-model', 'our-free-model-region'])
  assert.equal(body.models.length, 4, 'three main routes and one region route')
  const bunny = body.models.find((row) => row.key === 'our-free-model|space-bunny-free')
  assert.equal(bunny.name, 'Space Bunny')
  assert.equal(bunny.entry.effort, 'deep')
  assert.equal(bunny.contextWindow, 1000000)
  assert.equal(bunny.defaultMaxTokens, 32768)
  assert.equal(bunny.vision, true)
  assert.deepEqual(bunny.efforts.map((effort) => effort.id), ['light', 'deep'])
  assert.equal(bunny.top.effort, 'deep', 'the maximum rung is offered before it is applied')
  assert.equal(body.models.some((row) => row.provider === 'workbuddy-global'), false, 'the scope filter holds')
  const noCapacity = body.models.find((row) => row.model === 'no-capacity-free')
  assert.equal(noCapacity.top, null, 'a model with no capacity proposes nothing')
  harness.disposers.forEach((dispose) => dispose())
})

test('a saved rung is checked against the live model, and the row survives a restart', async () => {
  useHome({}, undefined)
  const models = fakeModels()
  const harness = makeCtx(new Map(), { llm: models })
  apply(harness.ctx, {})

  const good = await callRoute(harness, '/models/preset', {
    method: 'POST',
    body: { key: 'our-free-model|space-bunny-free', entry: { enabled: true, effort: 'deep', maxTokens: 4096 } },
  })
  assert.equal(good.status, 200)
  assert.equal(good.body.entry.effort, 'deep')
  assert.deepEqual(good.body.problems, [])

  const bad = await callRoute(harness, '/models/preset', {
    method: 'POST',
    body: { key: 'our-free-model|space-bunny-free', entry: { enabled: true, effort: 'ultra' } },
  })
  assert.equal(bad.body.entry.effort, '')
  assert.deepEqual(bad.body.problems, ['effort-not-declared'])

  const unknown = await callRoute(harness, '/models/preset', { method: 'POST', body: { key: 'nope', entry: {} } })
  assert.equal(unknown.status, 400)

  harness.disposers.forEach((dispose) => dispose())
  const stored = readParams()
  assert.equal(stored.entries['our-free-model|space-bunny-free'].effort, '')
})

test('a configured route carries its parameters on the next request', async () => {
  useHome({}, {
    entries: {
      'our-free-model|space-bunny-free': {
        enabled: true, effort: 'deep', effortMode: 'preset', maxTokens: 20000, temperature: 0.3, stop: ['\n\nEND'], note: '', updatedAt: 1,
      },
    },
  })
  const agent = new FakeAgent('sess-params')
  const harness = makeCtx(new Map([[agent.id, agent]]), { llm: fakeModels() })
  apply(harness.ctx, {})

  const seed = { provider: 'our-free-model', model: 'space-bunny-free', reasoningEffort: 'light' }
  const config = await runRequest(harness, seed, agent)
  assert.equal(config.reasoningEffort, 'deep', 'the stored rung wins over the seeded one')
  assert.equal(config.maxTokens, 20000)
  assert.equal(config.temperature, 0.3)
  assert.deepEqual(config.stop, ['\n\nEND'])
  assert.equal(seed.reasoningEffort, 'light', 'the config handed in is never mutated')

  harness.disposers.forEach((dispose) => dispose())
})

test('an unconfigured route is left exactly as it was', async () => {
  useHome({}, { entries: { 'our-free-model|space-bunny-free': { enabled: true, effort: 'deep' } } })
  const agent = new FakeAgent('sess-plain', { model: 'mimo-flash-free' })
  const harness = makeCtx(new Map([[agent.id, agent]]), { llm: fakeModels() })
  apply(harness.ctx, {})

  const seed = { provider: 'our-free-model', model: 'mimo-flash-free', reasoningEffort: 'high' }
  const config = await runRequest(harness, seed, agent)
  assert.deepEqual(config, seed, 'the plugin is inert for a route nobody configured')

  const other = await runRequest(harness, { provider: 'workbuddy-global', model: 'gpt-6-luna' }, agent)
  assert.deepEqual(other, { provider: 'workbuddy-global', model: 'gpt-6-luna' })
  harness.disposers.forEach((dispose) => dispose())
})

test('a rung the model stopped declaring never reaches the wire', async () => {
  useHome({}, { entries: { 'our-free-model|space-bunny-free': { enabled: true, effort: 'xhigh', maxTokens: 4096 } } })
  const agent = new FakeAgent('sess-stale')
  const harness = makeCtx(new Map([[agent.id, agent]]), { llm: fakeModels() })
  apply(harness.ctx, {})

  const config = await runRequest(harness, { provider: 'our-free-model', model: 'space-bunny-free' }, agent)
  assert.equal(config.reasoningEffort, undefined, 'the stale rung is dropped, not sent')
  assert.equal(config.maxTokens, 4096, 'the rest of the row still applies')
  harness.disposers.forEach((dispose) => dispose())
})

test('a row that owns nothing hands the fields back to the model', async () => {
  useHome({}, { entries: { 'our-free-model|space-bunny-free': { enabled: false } } })
  const agent = new FakeAgent('sess-reset')
  const harness = makeCtx(new Map([[agent.id, agent]]), { llm: fakeModels() })
  apply(harness.ctx, {})

  const seed = { provider: 'our-free-model', model: 'space-bunny-free', reasoningEffort: 'deep', maxTokens: 1000, temperature: 0.9 }
  const config = await runRequest(harness, seed, agent)
  assert.deepEqual(config, { provider: 'our-free-model', model: 'space-bunny-free' })
  harness.disposers.forEach((dispose) => dispose())
})

test('an unreachable model service is a missing feature, not a failed turn', async () => {
  useHome({}, { entries: { 'our-free-model|space-bunny-free': { enabled: true, effort: 'deep', maxTokens: 2048 } } })
  const agent = new FakeAgent('sess-nollm')
  // No `llm` service at all: the seam must still hand the loop a usable config.
  const harness = makeCtx(new Map([[agent.id, agent]]))
  apply(harness.ctx, {})

  const seed = { provider: 'our-free-model', model: 'space-bunny-free', reasoningEffort: 'light' }
  const config = await runRequest(harness, seed, agent)
  assert.equal(config.reasoningEffort, 'light', 'an unverifiable rung is left alone')
  assert.equal(config.maxTokens, 2048, 'the fields that need no capability check still apply')
  harness.disposers.forEach((dispose) => dispose())
})

test('the maximum preset covers every route it can raise', async () => {
  useHome({}, undefined)
  const harness = makeCtx(new Map(), { llm: fakeModels() })
  apply(harness.ctx, {})

  const { body } = await callRoute(harness, '/models/top', { method: 'POST', body: {} })
  assert.equal(body.proposals['our-free-model|space-bunny-free'].effort, 'deep')
  assert.equal(body.proposals['our-free-model|space-bunny-free'].maxTokens, 32768)
  assert.equal(body.proposals['our-free-model|mimo-flash-free'].effort, '', 'a menu-less model gets no rung')
  assert.equal(body.proposals['our-free-model|mimo-flash-free'].maxTokens, 8192)
  assert.equal('our-free-model|no-capacity-free' in body.proposals, false)
  assert.deepEqual(body.skipped, [{ key: 'our-free-model|no-capacity-free', reason: 'nothing-to-raise' }])
  assert.equal('workbuddy-global|gpt-6-luna' in body.proposals, false, 'out of scope')
  harness.disposers.forEach((dispose) => dispose())
})

test('a batch is written at once, and one undo takes it back', async () => {
  useHome({}, { entries: { 'our-free-model|region-free': { enabled: true, effort: 'balanced' } } })
  const harness = makeCtx(new Map(), { llm: fakeModels() })
  apply(harness.ctx, {})

  const applied = await callRoute(harness, '/models/bulk', {
    method: 'POST',
    body: {
      entries: {
        'our-free-model|space-bunny-free': { enabled: true, effort: 'deep', maxTokens: 32768 },
        'workbuddy-global|gpt-6-luna': { enabled: true, effort: 'high' },
      },
    },
  })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.saved, 1, 'a route outside the scope is refused')
  assert.deepEqual(applied.body.problems, [{ key: 'workbuddy-global|gpt-6-luna', reason: 'unknown-route' }])

  const undone = await callRoute(harness, '/models/undo', { method: 'POST' })
  assert.equal(undone.status, 200)
  harness.disposers.forEach((dispose) => dispose())
  const stored = readParams()
  assert.equal('our-free-model|space-bunny-free' in stored.entries, false, 'undo restored the earlier table')
  assert.equal(stored.entries['our-free-model|region-free'].effort, 'balanced')
})

test('undo with nothing to undo says so instead of guessing', async () => {
  useHome({}, undefined)
  const harness = makeCtx(new Map(), { llm: fakeModels() })
  apply(harness.ctx, {})
  const { status, body } = await callRoute(harness, '/models/undo', { method: 'POST' })
  assert.equal(status, 409)
  assert.match(body.error, /nothing to undo/)
  harness.disposers.forEach((dispose) => dispose())
})

test('a scope change re-reads the registry', async () => {
  useHome({}, undefined)
  const harness = makeCtx(new Map(), { llm: fakeModels() })
  apply(harness.ctx, {})

  const widened = await callRoute(harness, '/models/scope', { method: 'POST', body: { scope: 'workbuddy*' } })
  assert.deepEqual(widened.body.scope, ['workbuddy*'])
  const page = await callRoute(harness, '/models')
  assert.deepEqual(page.body.providers, ['workbuddy-global'])
  assert.equal(page.body.models[0].key, 'workbuddy-global|gpt-6-luna')
  harness.disposers.forEach((dispose) => dispose())
})

test('the tuning model is asked on the configured route and its answer is validated', async () => {
  useHome({}, undefined)
  const models = fakeModels()
  models.answer = '{"entries":{"our-free-model|space-bunny-free":{"effort":"deep","maxTokens":32768,"reason":"top rung"},"ghost|x":{"effort":"high"}}}'
  const harness = makeCtx(new Map(), { llm: models, agentDefaultModel: { currentSelection: () => ({ provider: 'our-free-model', model: 'mimo-flash-free' }) } })
  apply(harness.ctx, {})

  const { status, body } = await callRoute(harness, '/models/ai', { method: 'POST', body: {} })
  assert.equal(status, 200)
  assert.deepEqual(body.route, { provider: 'our-free-model', model: 'mimo-flash-free', source: 'default' })
  assert.equal(body.proposals['our-free-model|space-bunny-free'].effort, 'deep')
  assert.deepEqual(body.rejected, [{ key: 'ghost|x', reason: 'unknown-route' }])
  const call = models.calls[0]
  assert.equal(call.provider, 'our-free-model')
  assert.match(call.messages[0].content[0].text, /our-free-model\|space-bunny-free/)
  assert.equal(call.maxTokens, 4096)
  harness.disposers.forEach((dispose) => dispose())
})

test('a model that answers with prose is reported, and nothing is written', async () => {
  useHome({}, undefined)
  const models = fakeModels()
  models.answer = 'I cannot help with that.'
  const harness = makeCtx(new Map(), { llm: models })
  apply(harness.ctx, {})

  const { body } = await callRoute(harness, '/models/ai', { method: 'POST', body: {} })
  assert.equal(body.parsed, false)
  assert.deepEqual(body.proposals, {})
  harness.disposers.forEach((dispose) => dispose())
  assert.deepEqual(readParams().entries, {}, 'a failed suggestion writes nothing')
})
