/**
 * Offline checks for the browser half.
 *
 * `client.js` is not a module — it hands a factory to the shell's loader — so
 * the rig stands up the same `window.__ModuleLoader__` seam the shell does, then
 * drives the factory with a stub React. That is enough to prove the section
 * registers with the right shape, that the copy is complete, and that the page
 * renders a real element tree from a real `/summary` payload.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── the stub shell ──────────────────────────────────────────────────────────

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout,
}
globalThis.document = undefined

/**
 * The hooks the section actually uses. `__overrides` lets a case hand a
 * component its loaded state directly — the section's first `useState` is the
 * fetched summary, so one entry is enough to render the real body without a
 * fetch.
 */
const stubReact = {
  __overrides: [],
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    const override = stubReact.__overrides.shift()
    const fallback = typeof initial === 'function' ? initial() : initial
    return [override === undefined ? fallback : override, () => {}]
  },
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

await import('../client.js')

function loadModule() {
  return loaded.factory((id) => {
    if (id === 'react') return stubReact
    throw new Error(`the browser half must not require "${id}"`)
  })
}

/** A slot registry that records what got registered. */
function fakeCtx() {
  const registrations = []
  const effects = []
  const dictionaries = []
  return {
    registrations,
    effects,
    dictionaries,
    slots: {
      inject(key, callback) {
        registrations.push({ key, result: callback() })
      },
      register(options, component) {
        return { options, component }
      },
    },
    get() {
      return undefined
    },
    effect(fn, label) {
      const result = fn()
      if (typeof result === 'function') effects.push(result)
      return result ?? { label }
    },
    locale: undefined,
    dictionaries,
  }
}

// ── cases ───────────────────────────────────────────────────────────────────

test('the loader entry names the package the patch mounts', () => {
  assert.equal(loaded.id, 'dsh-ofm-addition')
  assert.equal(typeof loaded.factory, 'function')
})

test('the browser half requires nothing but react', () => {
  const module = loadModule()
  assert.equal(module.name, 'ofm-addition')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
})

/** The registration for one settings section id, or undefined. */
function sectionOf(ctx, id) {
  return ctx.registrations.find((row) => row.key === 'settings.section' && row.result.options.id === id)
}

test('the sections register as list entries under Our Free Model', () => {
  const module = loadModule()
  const ctx = fakeCtx()
  module.apply(ctx)

  assert.equal(ctx.registrations.length, 3, 'two settings sections and the count badge')
  const registered = sectionOf(ctx, 'ofm-addition')
  const models = sectionOf(ctx, 'ofm-addition-models')
  const badge = ctx.registrations.find((row) => row.key === 'conversation.chat.assistant-actions')
  assert.notEqual(badge, undefined, 'the transcript seat must be registered')
  assert.notEqual(models, undefined, 'the parameter page registers its own section')

  const { options, component } = registered.result
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'ofm-addition', 'a list slot needs an id')
  assert.ok(options.order > 35, 'it must sort after Our Free Model (order 35)')
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof component, 'function')
  assert.equal(options.locale, undefined, 'without a locale service it declares none')

  assert.equal(models.result.options.order, 37, 'the parameter page sorts directly below it')
  assert.notEqual(models.result.options.id, options.id, 'two sections cannot share an id')
  assert.equal(typeof models.result.component, 'function')
})

test('both dictionaries cover the same keys, including every outcome', () => {
  const module = loadModule()
  const zh = Object.keys(module.DICT.zh).sort()
  const en = Object.keys(module.DICT.en).sort()
  assert.deepEqual(zh, en, 'a key in one dictionary and not the other renders as its own name')

  // The host half can report any of these; the page renders `outcome.<value>`.
  const outcomes = [
    'sent', 'disabled', 'no-pending', 'agent-gone', 'agent-busy',
    'user-driving', 'budget-spent', 'route-filtered', 'subagent-filtered',
    'tool-call-truncated', 'context-full', 'context-overflow', 'disposed',
  ]
  for (const outcome of outcomes) {
    assert.ok(zh.includes(`outcome.${outcome}`), `missing outcome.${outcome}`)
  }
})

/**
 * Render the registered section body with a given `/summary` payload.
 *
 * Applying the plugin gives back the apply-time lambda the slot registered; the
 * real component is its element type. One hook override hands it the payload it
 * would otherwise have fetched.
 */
function renderSection(module, summary) {
  return renderBody(module, summary, 'ofm-addition')
}

/** Render the model parameter section body with a given `/models` payload. */
function renderModels(module, payload) {
  return renderBody(module, payload, 'ofm-addition-models')
}

function renderBody(module, payload, id) {
  const ctx = fakeCtx()
  module.apply(ctx)
  const registered = sectionOf(ctx, id).result.component
  stubReact.__overrides = [payload]
  const outer = registered({ t: module.localT })
  stubReact.__overrides = [payload]
  return outer.type(outer.props)
}

test('the renderer produces a tree from a real summary payload', () => {
  const module = loadModule()

  // Shaped exactly like what `GET /api/ofm-addition/summary` returns.
  const summary = {
    version: '0.1.0',
    settings: {
      enabled: true,
      maxContinuations: 3,
      unbounded: false,
      delayMs: 350,
      promptPreset: 'explicit',
      prompt: '',
      providers: [],
      models: [],
      includeSubagents: false,
      messageMode: 'user',
      skipOnTruncatedToolCall: false,
      contextGuard: true,
      contextRatio: 0.9,
      effectivePrompt: '继续 —— 上一条回答因达到输出上限被截断。',
    },
    stats: {
      version: 1,
      sent: 4,
      outcomes: { sent: 4, 'budget-spent': 1 },
      history: [{ at: Date.now(), outcome: 'sent', sessionId: 'abcdefghijklmnop', provider: 'our-free-model', model: 'space-bunny-free', streak: 1, prompt: '继续', detail: '' }],
      lastSessionId: 'abcdefghijklmnop',
    },
    agents: [{ sessionId: 'abcdefghijklmnop', provider: 'our-free-model', model: 'space-bunny-free', status: 'idle', streak: 2, fired: 1, armed: true, armedAt: Date.now(), overflowed: false, queued: { nextTurn: 0, nextStep: 0 }, subagent: false }],
    vocabulary: { outcomes: [], prompts: ['explicit', 'simple'], presets: {} },
  }

  const tree = renderSection(module, summary)
  assert.equal(tree.type, stubReact.Fragment)

  const text = JSON.stringify(tree)
  assert.match(text, /OFM Addition/)
  assert.match(text, /继续/)
  assert.match(text, /space-bunny-free/)
  assert.match(text, /abcdefghijkl/, 'the session column is rendered')
})

test('a fresh install with nothing to report still renders', () => {
  const module = loadModule()
  const tree = renderSection(module, {
    version: '0.1.0',
    settings: {
      enabled: true,
      maxContinuations: 3,
      unbounded: false,
      delayMs: 350,
      promptPreset: 'explicit',
      prompt: '',
      providers: [],
      models: [],
      includeSubagents: false,
      messageMode: 'user',
      skipOnTruncatedToolCall: false,
      contextGuard: true,
      contextRatio: 0.9,
      effectivePrompt: '继续',
    },
    stats: { version: 1, sent: 0, outcomes: {}, history: [], lastSessionId: '' },
    agents: [],
    vocabulary: { outcomes: [], prompts: ['explicit', 'simple'], presets: {} },
  })
  const text = JSON.stringify(tree)
  assert.match(text, /Nothing recorded yet\./, 'the empty history state renders')
  assert.match(text, /No session is being tracked/)
})

test('an unlimited budget renders as unlimited, with both brakes visible', () => {
  const module = loadModule()
  const tree = renderSection(module, {
    version: '0.1.0',
    settings: {
      enabled: true,
      maxContinuations: 0,
      unbounded: true,
      delayMs: 350,
      promptPreset: 'explicit',
      prompt: '',
      providers: [],
      models: [],
      includeSubagents: false,
      messageMode: 'user',
      skipOnTruncatedToolCall: false,
      contextGuard: true,
      contextRatio: 0.9,
      effectivePrompt: '继续',
    },
    stats: { version: 1, sent: 0, outcomes: {}, history: [], lastSessionId: '' },
    agents: [],
    vocabulary: { outcomes: [], prompts: ['explicit', 'simple'], presets: {} },
  })
  const text = JSON.stringify(tree)
  assert.match(text, /Unlimited/, 'the unlimited pill is offered')
  assert.match(text, /90%/, 'the guard threshold is shown while the guard is on')
  assert.doesNotMatch(text, /Keep at least one of the two brakes/, 'no warning while a brake is on')
})

test('unlimited with the guard off warns instead of staying silent', () => {
  const module = loadModule()
  const tree = renderSection(module, {
    version: '0.1.0',
    settings: {
      enabled: true,
      maxContinuations: 0,
      unbounded: true,
      delayMs: 350,
      promptPreset: 'explicit',
      prompt: '',
      providers: [],
      models: [],
      includeSubagents: false,
      messageMode: 'user',
      skipOnTruncatedToolCall: false,
      contextGuard: false,
      contextRatio: 0.9,
      effectivePrompt: '继续',
    },
    stats: { version: 1, sent: 0, outcomes: {}, history: [], lastSessionId: '' },
    agents: [],
    vocabulary: { outcomes: [], prompts: ['explicit', 'simple'], presets: {} },
  })
  const text = JSON.stringify(tree)
  assert.match(text, /Keep at least one of the two brakes/)
  assert.doesNotMatch(text, /90%/, 'the threshold is hidden once the guard is off')
})

test('the translation fallback fills placeholders and survives a missing key', () => {
  const module = loadModule()
  const text = module.localT('agents.round', { n: 3 })
  assert.match(text, /3/)
  assert.equal(module.localT('definitely.not.a.key'), 'definitely.not.a.key')
})

test('the stylesheet is shipped inline and is self-contained', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /const STYLE_ID = 'ofm-addition-settings-styles'/)
  // Every class the render body uses must exist in the sheet, or the page
  // silently renders unstyled.
  const used = new Set([...source.matchAll(/className: '([^']+)'/g)].flatMap((match) => match[1].split(/\s+/)))
  const declared = new Set([...source.matchAll(/\.(ofa_[a-z_]+)[{ ]/g)].map((match) => match[1]))
  for (const name of used) {
    if (name === '' || name.startsWith('${')) continue
    assert.ok(declared.has(name), `class "${name}" is used but never styled`)
  }
})


// ── the model parameter page ────────────────────────────────────────────────

/** Shaped exactly like what `GET /api/ofm-addition/models` returns. */
function modelPage(overrides = {}) {
  return {
    version: '0.4.0',
    scope: ['our-free-model*'],
    providers: ['our-free-model'],
    entries: {
      'our-free-model|space-bunny-free': {
        enabled: true, effort: 'deep', effortMode: 'preset', maxTokens: 32768, temperature: null, stop: [], note: '', updatedAt: 1,
      },
    },
    models: [
      {
        key: 'our-free-model|space-bunny-free',
        provider: 'our-free-model',
        model: 'space-bunny-free',
        name: 'Space Bunny',
        contextWindow: 1000000,
        defaultMaxTokens: 32768,
        efforts: [{ id: 'light', name: 'Light' }, { id: 'deep', name: 'Deep' }],
        defaultEffort: 'light',
        vision: true,
        resolved: true,
        entry: { enabled: true, effort: 'deep', effortMode: 'preset', maxTokens: 32768, temperature: null, stop: [], note: '' },
        top: { enabled: true, effort: 'deep', maxTokens: 32768 },
      },
      {
        key: 'our-free-model|mimo-flash-free',
        provider: 'our-free-model',
        model: 'mimo-flash-free',
        name: 'Mimo',
        contextWindow: 131072,
        defaultMaxTokens: 8192,
        efforts: [],
        defaultEffort: '',
        vision: false,
        resolved: true,
        entry: null,
        top: { enabled: true, effort: '', maxTokens: 8192 },
      },
    ],
    ai: { provider: '', model: '', maxTokens: 4096, route: { provider: 'our-free-model', model: 'mimo-flash-free', source: 'default' } },
    applied: { count: 3, lastAt: 1, lastKey: 'our-free-model|space-bunny-free', lastApplied: ['reasoningEffort'], skipped: {} },
    ...overrides,
  }
}

test('the parameter page renders every route with its stored row', () => {
  const module = loadModule()
  const tree = renderModels(module, modelPage())
  assert.equal(tree.type, stubReact.Fragment)
  const text = JSON.stringify(tree)
  assert.match(text, /OFM model parameters/)
  assert.match(text, /our-free-model\|space-bunny-free/)
  assert.match(text, /Mimo/)
  assert.match(text, /deep/, 'the configured rung reads back')
  assert.match(text, /2 models · 1 configured/)
  assert.match(text, /carried stored parameters on 3 requests/)
})

test('a page with nothing configured still renders and offers the empty state', () => {
  const module = loadModule()
  const tree = renderModels(module, modelPage({ models: [], entries: {}, providers: [] }))
  const text = JSON.stringify(tree)
  assert.match(text, /No model in this scope can be configured/)
  assert.match(text, /0 models · 0 configured/)
})

test('a model without a rung menu says so instead of offering a fake one', () => {
  const module = loadModule()
  const page = modelPage()
  const mimo = page.models[1]
  const opened = { ...page, models: [{ ...mimo, entry: { ...mimo.top } }] }
  // One row widget rendered directly, so the expanded body is reachable without
  // driving the section's own open state.
  const element = module.ModelRow({
    row: opened.models[0],
    t: module.localT,
    entry: opened.models[0].entry,
    open: true,
    busy: false,
    onToggle: () => {},
    onSave: () => {},
    onReset: () => {},
    onRemove: () => {},
  })
  const text = JSON.stringify(element)
  assert.match(text, /declares no thinking rungs/)
  assert.match(text, /Output ceiling/)
})

test('the summary line reads a stored row the way the page does', () => {
  const module = loadModule()
  assert.equal(module.kilos(32768), '32 K')
  assert.equal(module.kilos(1048576), '1 M')
  assert.equal(module.kilos(0), '—')
  assert.equal(module.entrySummary(null, module.localT), 'Not configured')
  assert.equal(module.entrySummary({ enabled: false, effort: '', maxTokens: null, temperature: null, stop: [] }, module.localT), 'Model defaults')
  assert.equal(
    module.entrySummary({ enabled: true, effort: 'deep', effortMode: 'session', maxTokens: 32768, temperature: 0.4, stop: ['x'] }, module.localT),
    'deep · ≤32 K · T=0.4 · stop×1 · Session pick wins',
  )
})

test('the filter keeps the configured-only switch and the query honest', () => {
  const module = loadModule()
  const rows = [
    { name: 'Space Bunny', key: 'our-free-model|space-bunny-free', provider: 'our-free-model', entry: {} },
    { name: 'Mimo', key: 'our-free-model|mimo-flash-free', provider: 'our-free-model', entry: null },
  ]
  assert.equal(module.visibleModels(rows, '', false).length, 2)
  assert.deepEqual(module.visibleModels(rows, '', true).map((row) => row.name), ['Space Bunny'])
  assert.deepEqual(module.visibleModels(rows, 'mimo', false).map((row) => row.name), ['Mimo'])
  assert.deepEqual(module.groupByProvider(module.visibleModels(rows, '', false)).map((group) => group.provider), ['our-free-model'])
})
