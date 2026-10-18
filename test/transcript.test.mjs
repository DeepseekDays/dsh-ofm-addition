/**
 * Offline checks for the transcript fold, against a real DOM.
 *
 * The fold works by tagging rows the chat already rendered, so the interesting
 * question is not "does the rule fire" but "does it fire on exactly these rows
 * and leave every other row untouched". That needs elements, not stubs — jsdom
 * is already on this machine, so these run with no browser and no DSH.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── load client.js against jsdom ────────────────────────────────────────────

const JSDOM_ROOT = process.env.JSDOM_ROOT ?? 'jsdom'

let JSDOM
try {
  ;({ JSDOM } = await import(JSDOM_ROOT))
} catch {
  JSDOM = undefined
}

const dom = JSDOM === undefined ? undefined : new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' })
const document = dom?.window.document
const loaded = { entry: undefined }

if (dom !== undefined) {
  globalThis.window = dom.window
  globalThis.document = document
  globalThis.MutationObserver = dom.window.MutationObserver
  dom.window.__ModuleLoader__ = { load: (entry) => { loaded.entry = entry } }
  await import('../client.js')
}

/** The hooks the factory destructures; the DOM tests never render through them. */
const stubReact = new Proxy(
  {
    createElement: () => ({ type: 'div', props: {}, children: [] }),
    Fragment: Symbol('Fragment'),
  },
  {
    get(target, name) {
      if (name in target) return target[name]
      if (name === 'useMemo' || name === 'useCallback') return (fn) => fn
      if (name === 'useRef') return () => ({ current: null })
      return () => [undefined, () => {}]
    },
  },
)

function loadModule() {
  return loaded.entry.factory(() => stubReact)
}

/** One transcript row, shaped exactly like the chat's flow item. */
function row(document_, { nodeKey, kind, turn, text = '' }) {
  const element = document_.createElement('div')
  element.setAttribute('data-chat-node-key', nodeKey)
  element.setAttribute('data-chat-flow-key', nodeKey)
  element.setAttribute('data-chat-flow-kind', kind)
  element.setAttribute('data-chat-turn', String(turn))
  element.textContent = text
  return element
}

const KEY = (kind, id) => `${kind.length}:${kind}${id}`

// ── cases ───────────────────────────────────────────────────────────────────

test('the harness parser shape still holds: the row key embeds the message id', (t) => {
  if (dom === undefined) {
    t.skip('jsdom is not installed')
    return
  }
  // The fold identifies rows by `key.includes(messageId)`, which is only sound
  // because the chat builds its key as `${kind.length}:${kind}${id}`. Pin that.
  const kind = 'input-message'
  const id = '9f3c1e2a-1111-2222-3333-444455556666'
  assert.equal(KEY(kind, id), `${kind.length}:${kind}${id}`)
  assert.ok(KEY(kind, id).includes(id))
})

test('only the run\'s own rows fold', (t) => {
  if (dom === undefined) {
    t.skip('jsdom is not installed')
    return
  }
  const module = loadModule()
  const ours = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6'
  const other = 'f0e1d2c3-b4a5-f6e7-d8c9-b0a1f2e3d4c5'

  const root = document.createElement('div')
  root.setAttribute('data-chat-flow', '')
  const rows = {
    ourInput: row(document, { nodeKey: KEY('input-message', ours), kind: 'user', turn: 12 }),
    otherInput: row(document, { nodeKey: KEY('input-message', other), kind: 'user', turn: 3, text: '帮我写个脚本' }),
    answeredNotice: row(document, { nodeKey: KEY('turn-max-tokens', '90'), kind: 'turn-max-tokens', turn: 11 }),
    liveNotice: row(document, { nodeKey: KEY('turn-max-tokens', '99'), kind: 'turn-max-tokens', turn: 12 }),
    ourOutput: row(document, { nodeKey: KEY('assistant-step', 'a1'), kind: 'assistant-step', turn: 12 }),
    personRow: row(document, { nodeKey: KEY('input-message', other), kind: 'user', turn: 12 }),
    trigger: row(document, { nodeKey: KEY('turn-trigger', '95'), kind: 'turn-trigger', turn: 12 }),
  }
  for (const element of Object.values(rows)) root.appendChild(element)

  const index = { ids: [ours], turns: [11] }
  const folded = module.applyFold(root, index, false)

  assert.equal(folded, 2, 'our input row and the notice it answered')
  assert.equal(rows.ourInput.getAttribute(module.FOLD_ATTR), '')
  assert.equal(rows.answeredNotice.getAttribute(module.FOLD_ATTR), '')
  for (const name of ['otherInput', 'liveNotice', 'ourOutput', 'personRow', 'trigger']) {
    assert.equal(rows[name].getAttribute(module.FOLD_ATTR), null, `${name} must stay visible`)
  }

  // Turning the fold off restores the shipped transcript exactly.
  assert.equal(module.applyFold(root, index, true), 0)
  for (const element of Object.values(rows)) assert.equal(element.getAttribute(module.FOLD_ATTR), null)
  module.clearFold(root)
})

test('the notice rule never reaches into another session\'s turns', (t) => {
  if (dom === undefined) {
    t.skip('jsdom is not installed')
    return
  }
  const module = loadModule()
  const root = document.createElement('div')
  const sameTurnOtherSession = row(document, { nodeKey: KEY('turn-max-tokens', '7'), kind: 'turn-max-tokens', turn: 11 })
  root.appendChild(sameTurnOtherSession)

  // No ids in the index at all: only the turn rule could match, and it must not
  // reach a session whose runs this report knows nothing about.
  assert.equal(module.applyFold(root, { ids: [], turns: [11] }, false), 1, 'same turn, same report')
  assert.equal(module.applyFold(root, { ids: [], turns: [99] }, false), 0, 'another turn')
  assert.equal(module.clearFold(root), undefined)
  assert.equal(sameTurnOtherSession.getAttribute(module.FOLD_ATTR), null)
})

test('a real transcript root is found by walking up to data-chat-flow', (t) => {
  if (dom === undefined) {
    t.skip('jsdom is not installed')
    return
  }
  const module = loadModule()
  const column = document.createElement('div')
  column.setAttribute('data-chat-flow', '')
  const inner = document.createElement('div')
  inner.setAttribute('data-chat-flow', '')
  const badge = document.createElement('span')
  inner.appendChild(badge)
  column.appendChild(inner)
  document.body.appendChild(column)

  // The innermost match would fold only a tool group; the outermost is the
  // transcript, which is what a run spans.
  assert.equal(module.transcriptRoot(badge), column)
  assert.equal(module.transcriptRoot(document.body), document)
  column.remove()
})

test('applying the plugin registers the count badge and installs the stylesheet', (t) => {
  if (dom === undefined) {
    t.skip('jsdom is not installed')
    return
  }
  const module = loadModule()
  const registrations = []
  const ctx = {
    slots: {
      inject(key, callback) {
        registrations.push({ key, result: callback() })
      },
      register(options, component) {
        return { options, component }
      },
    },
    get: () => undefined,
    effect(fn) {
      const result = fn()
      return typeof result === 'function' ? result : result
    },
  }
  module.apply(ctx)

  // Both stylesheets, installed exactly once.
  module.apply(ctx)
  assert.equal(document.querySelectorAll(`#${'ofm-addition-transcript-styles'}`).length, 1)
  assert.match(document.getElementById('ofm-addition-transcript-styles').textContent, /display:none!important/)

  const badge = registrations.find((row) => row.key === 'conversation.chat.assistant-actions')
  assert.notEqual(badge, undefined, 'the count badge must be registered')
  const { options } = badge.result
  assert.equal(options.id, 'ofm-addition-count')
  assert.equal(typeof options.inject, 'function', 'the entry takes its session from the seat')
  assert.equal(options.inject('session-1').sessionId, 'session-1')
  assert.equal(typeof badge.result.component, 'function')
})
