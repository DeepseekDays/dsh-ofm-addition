/**
 * Offline checks for the per-model parameter table.
 *
 * The rules being checked are the ones that decide what reaches the wire: an
 * effort the model does not declare must never be sent (the harness rejects it
 * and the turn dies), a row that owns nothing must clear what a previous
 * request recorded, and the "maximum" preset must stay inside the capacity the
 * adapter itself advertises.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EFFORT_MODE,
  applyPreset,
  baseEntry,
  declaredEfforts,
  describeEntry,
  entryKeyOf,
  isConfigured,
  normalizeScope,
  providerInScope,
  sanitizeDocument,
  sanitizeEntry,
  splitKey,
  topEffort,
  topPreset,
} from '../src/model-params.js'
import { buildAiPrompt, extractJsonObject, parseAiProposals } from '../src/ai-fill.js'

/** One resolved model, shaped the way `llm.resolveModelInfo` answers. */
function facts(overrides = {}) {
  return {
    efforts: [{ id: 'light', name: 'Light' }, { id: 'balanced', name: 'Balanced' }, { id: 'deep', name: 'Deep' }],
    defaultEffort: 'balanced',
    contextWindow: 131072,
    defaultMaxTokens: 32768,
    name: 'Model',
    vision: false,
    ...overrides,
  }
}

const rowOf = (overrides = {}) => ({
  key: 'our-free-model|space-bunny-free',
  provider: 'our-free-model',
  model: 'space-bunny-free',
  name: 'Space Bunny',
  contextWindow: 131072,
  defaultMaxTokens: 32768,
  efforts: [{ id: 'light', name: 'Light' }, { id: 'deep', name: 'Deep' }],
  defaultEffort: 'light',
  vision: false,
  resolved: true,
  ...overrides,
})

test('a key round-trips through its provider/model halves', () => {
  assert.equal(entryKeyOf('our-free-model', 'space-bunny-free'), 'our-free-model|space-bunny-free')
  assert.deepEqual(splitKey('our-free-model|space-bunny-free'), { provider: 'our-free-model', model: 'space-bunny-free' })
  assert.deepEqual(splitKey('no-separator'), { provider: 'no-separator', model: '' })
})

test('an empty entry is storable, and is not "configured"', () => {
  const empty = baseEntry()
  assert.equal(isConfigured(empty), false)
  assert.equal(isConfigured({ ...empty, effort: 'deep' }), true)
  assert.equal(isConfigured({ ...empty, maxTokens: 4096 }), true)
  assert.equal(isConfigured({ ...empty, stop: ['x'] }), true)
  assert.equal(isConfigured(undefined), false)
})

test('sanitizeEntry keeps a declared rung and refuses one the model does not offer', () => {
  const kept = sanitizeEntry({ enabled: true, effort: 'deep' }, facts())
  assert.equal(kept.entry.effort, 'deep')
  assert.deepEqual(kept.problems, [])

  const refused = sanitizeEntry({ enabled: true, effort: 'max' }, facts())
  assert.equal(refused.entry.effort, '')
  assert.deepEqual(refused.problems, ['effort-not-declared'])
})

test('an unverifiable rung is kept and flagged, not silently deleted', () => {
  // The request seam re-checks membership, so a lookup that failed when the
  // page saved must not throw away what the person typed.
  const { entry, problems } = sanitizeEntry({ enabled: true, effort: 'max' }, undefined)
  assert.equal(entry.effort, 'max')
  assert.deepEqual(problems, ['effort-unverified'])
})

test('the ceiling is clamped to the model window, and the temperature to its range', () => {
  const over = sanitizeEntry({ enabled: true, maxTokens: 999999, temperature: 5 }, facts())
  assert.equal(over.entry.maxTokens, 131071)
  assert.equal(over.entry.temperature, 2)
  assert.deepEqual(over.problems.sort(), ['max-tokens-clamped', 'temperature-clamped'])

  const junk = sanitizeEntry({ enabled: true, maxTokens: -5, temperature: 'hot' }, facts())
  assert.equal(junk.entry.maxTokens, null)
  assert.equal(junk.entry.temperature, null)
  assert.deepEqual(junk.problems.sort(), ['max-tokens-invalid', 'temperature-invalid'])
})

test('stop sequences are trimmed to real, unique, bounded strings', () => {
  const { entry } = sanitizeEntry({ enabled: true, stop: ['a', '', 'a', 'b'] }, facts())
  assert.deepEqual(entry.stop, ['a', 'b'])
  const many = sanitizeEntry({ enabled: true, stop: Array.from({ length: 20 }, (_, index) => `s${index}`) }, facts())
  assert.equal(many.entry.stop.length, 8)
})

test('a row that owns nothing clears what the session recorded', () => {
  // Without this, a value written by an earlier request comes back as the
  // session's own choice and "restore the model default" cannot be expressed.
  const session = { provider: 'our-free-model', model: 'm', reasoningEffort: 'deep', maxTokens: 1234, temperature: 0.7, stop: ['x'] }
  const { config, applied } = applyPreset(baseEntry(), session, facts())
  assert.deepEqual(config, { provider: 'our-free-model', model: 'm' })
  assert.deepEqual(applied.sort(), ['maxTokens', 'reasoningEffort', 'stop', 'temperature'])
  assert.deepEqual(session.reasoningEffort, 'deep', 'the input config is never mutated')
})

test('a stored rung is written even when the session picked one', () => {
  const entry = { ...baseEntry(), enabled: true, effort: 'light' }
  const session = { provider: 'p', model: 'm', reasoningEffort: 'deep' }
  const { config, applied, skipped } = applyPreset(entry, session, facts())
  assert.equal(config.reasoningEffort, 'light')
  assert.deepEqual(applied, ['reasoningEffort'])
  assert.deepEqual(skipped, [])
})

test('session-first mode defers to a rung the session already has', () => {
  const entry = { ...baseEntry(), enabled: true, effort: 'light', effortMode: EFFORT_MODE.SESSION }
  const { config, skipped } = applyPreset(entry, { provider: 'p', model: 'm', reasoningEffort: 'deep' }, facts())
  assert.equal(config.reasoningEffort, 'deep')
  assert.deepEqual(skipped, [{ field: 'reasoningEffort', reason: 'session-pick' }])

  const empty = applyPreset(entry, { provider: 'p', model: 'm' }, facts())
  assert.equal(empty.config.reasoningEffort, 'light', 'with nothing picked, the stored rung fills in')
})

test('a rung the model no longer declares is skipped, never sent', () => {
  const entry = { ...baseEntry(), enabled: true, effort: 'deep', maxTokens: 2048 }
  const stale = facts({ efforts: [{ id: 'light', name: 'Light' }] })
  const { config, applied, skipped } = applyPreset(entry, { provider: 'p', model: 'm' }, stale)
  assert.equal(config.reasoningEffort, undefined)
  assert.equal(config.maxTokens, 2048, 'the ceiling is not tied to the rung list')
  assert.deepEqual(applied, ['maxTokens'])
  assert.deepEqual(skipped, [{ field: 'reasoningEffort', reason: 'not-declared' }])
})

test('an unresolvable model skips the rung and keeps the rest', () => {
  const entry = { ...baseEntry(), enabled: true, effort: 'deep', temperature: 0.2 }
  const { config, skipped } = applyPreset(entry, { provider: 'p', model: 'm' }, undefined)
  assert.equal(config.reasoningEffort, undefined)
  assert.equal(config.temperature, 0.2)
  assert.deepEqual(skipped, [{ field: 'reasoningEffort', reason: 'model-unresolved' }])
})

test('a model with no rungs never receives an effort', () => {
  const entry = { ...baseEntry(), enabled: true, effort: 'high' }
  const { config, skipped } = applyPreset(entry, { provider: 'p', model: 'm' }, facts({ efforts: [] }))
  assert.equal(config.reasoningEffort, undefined)
  assert.deepEqual(skipped, [{ field: 'reasoningEffort', reason: 'no-effort-menu' }])
})

test('stop lists compare element-wise, so a same-length list still re-writes', () => {
  const entry = { ...baseEntry(), enabled: true, stop: ['b'] }
  const { config, applied } = applyPreset(entry, { provider: 'p', model: 'm', stop: ['a'] }, facts())
  assert.deepEqual(config.stop, ['b'])
  assert.deepEqual(applied, ['stop'])
})

test('the maximum preset picks the highest declared rung and the advertised ceiling', () => {
  const preset = topPreset(rowOf())
  assert.equal(preset.effort, 'deep')
  assert.equal(preset.maxTokens, 32768)
  assert.equal(preset.enabled, true)

  const rungs = facts({ efforts: [{ id: 'disabled' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }] })
  assert.equal(topEffort(declaredEfforts(rungs)), 'max')
  assert.equal(topEffort(['disabled']), '', 'an off-only menu has no top rung')
  assert.equal(topEffort(['made-up', 'high']), 'high', 'an unknown rung never outranks a known one')
})

test('a model with neither rungs nor a ceiling proposes nothing', () => {
  assert.equal(topPreset({ efforts: [], defaultMaxTokens: undefined }), null)
})

test('scope patterns are normalized, deduped, and matched with wildcards', () => {
  assert.deepEqual(normalizeScope('our-free-model*\n\n our-free-model* , x'), ['our-free-model*', 'x'])
  assert.deepEqual(normalizeScope(''), ['our-free-model*'])
  assert.equal(providerInScope(['our-free-model*'], 'our-free-model-region'), true)
  assert.equal(providerInScope(['our-free-model*'], 'workbuddy-global'), false)
  assert.equal(providerInScope(['*'], 'anything'), true)
  assert.equal(providerInScope(['our-free-model'], 'our-free-model'), true)
  assert.equal(providerInScope(['our-free-model'], 'our-free-model-region'), false)
})

test('a stored document is read defensively', () => {
  const document = sanitizeDocument({
    scope: ['a*'],
    entries: {
      'p|m': { enabled: true, effort: 'high', maxTokens: 100, temperature: 0.3, stop: ['q'] },
      'junk': { enabled: true },
      'p|m2': 'not an object',
    },
    ai: { provider: 'x', model: 'y', maxTokens: 999999 },
    applied: { count: 'nope' },
  })
  assert.deepEqual(document.scope, ['a*'])
  assert.deepEqual(Object.keys(document.entries), ['p|m', 'p|m2'])
  assert.equal(document.entries['p|m'].effort, 'high', 'an effort survives a cold read')
  assert.equal(document.entries['p|m2'].effort, '')
  assert.equal(document.ai.maxTokens, 32000)
  assert.equal('applied' in document, false, 'process-local counters are not stored')
})

test('describeEntry reads like the page, and says when the session wins', () => {
  assert.equal(describeEntry(baseEntry()), 'model defaults')
  assert.match(describeEntry({ ...baseEntry(), enabled: true, effort: 'deep', maxTokens: 32768 }), /effort deep, max 32768/)
  assert.match(describeEntry({ ...baseEntry(), enabled: true, effort: 'deep', effortMode: 'session' }), /session pick wins/)
})

test('the tuning prompt states the roster and the schema once', () => {
  const prompt = buildAiPrompt({ models: [rowOf()] })
  assert.match(prompt.user, /our-free-model\|space-bunny-free/)
  assert.match(prompt.user, /efforts=light\/deep/)
  assert.match(prompt.user, /\{"entries"/)
  assert.match(prompt.system, /JSON/)
})

test('a model answer is parsed, fenced or not, and checked against the roster', () => {
  const models = [rowOf()]
  const answer = 'Sure!\n```json\n{"entries":{"our-free-model|space-bunny-free":{"effort":"deep","maxTokens":32768,"reason":"top rung"},"elsewhere|x":{"effort":"high"}}}\n```'
  const { proposals, rejected, parsed } = parseAiProposals(answer, models)
  assert.equal(parsed, true)
  assert.equal(proposals['our-free-model|space-bunny-free'].effort, 'deep')
  assert.equal(proposals['our-free-model|space-bunny-free'].note, 'top rung')
  assert.deepEqual(rejected, [{ key: 'elsewhere|x', reason: 'unknown-route' }])
})

test('an invented rung is dropped instead of stored', () => {
  const models = [rowOf()]
  const answer = '{"entries":{"our-free-model|space-bunny-free":{"effort":"ultra"}}}'
  const { proposals, rejected } = parseAiProposals(answer, models)
  assert.deepEqual(proposals, {})
  assert.deepEqual(rejected, [{ key: 'our-free-model|space-bunny-free', reason: 'effort-not-declared' }])
})

test('prose with no JSON is reported as unparsed, not as an empty suggestion', () => {
  const { parsed, proposals } = parseAiProposals('I would rather not.', [rowOf()])
  assert.equal(parsed, false)
  assert.deepEqual(proposals, {})
})

test('the JSON reader survives braces inside strings and trailing prose', () => {
  const value = extractJsonObject('here: {"entries":{"a|b":{"reason":"a { brace } and a \\" quote"}}} done')
  assert.equal(value.entries['a|b'].reason, 'a { brace } and a " quote')
  assert.equal(extractJsonObject('nothing here'), undefined)
})
