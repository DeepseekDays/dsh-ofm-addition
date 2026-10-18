/**
 * Offline checks for the run ledger — the thing that decides which rows the
 * transcript folds and where the count badge goes.
 *
 * Everything is derived from the durable session log, so these tests replay
 * event sequences exactly as the harness appends them and check the runs that
 * fall out. The expected values are written out by hand: a run opens at the
 * first continuation and closes at the first turn that ends on anything but a
 * truncation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyLogEvent, createLedgerState, foldIndex, foldLog } from '../src/ledger.js'
import { CONTEXT_EXCEEDED_CODE } from '../src/policy.js'

let seq = 0
const at = (minutes) => 1_790_000_000_000 + minutes * 60_000

const userMessage = (id, mine) => ({
  type: 'user/message',
  seq: (seq += 1),
  time: at((seq += 1) % 60),
  data: { id, role: 'user', source: mine === true ? { kind: 'user', ofmAddition: true } : { kind: 'user' }, content: [] },
})

const stepStart = (turn) => ({ type: 'step/start', seq: (seq += 1), time: at(seq % 60), data: { turn, step: 1 } })

const assistantMessage = (id, turn) => ({
  type: 'assistant/message',
  seq: (seq += 1),
  time: at(seq % 60),
  data: { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
})

const turnEnd = (turn, reason) => ({ type: 'turn/end', seq: (seq += 1), time: at(seq % 60), data: { turn, reason } })

/** A truncation answered by one continuation, inside one new turn. */
function truncationAndContinue(state, turn, id) {
  applyLogEvent(state, turnEnd(turn, { kind: 'max-tokens' }))
  applyLogEvent(state, stepStart(turn + 1))
  applyLogEvent(state, userMessage(id, true))
  applyLogEvent(state, assistantMessage(`a-${id}`, turn + 1))
}

test('one run: two continuations then a normal finish', () => {
  const state = createLedgerState()
  applyLogEvent(state, userMessage('person-1', false))
  applyLogEvent(state, stepStart(10))
  applyLogEvent(state, assistantMessage('a-1', 10))
  truncationAndContinue(state, 10, 'ours-1')
  truncationAndContinue(state, 11, 'ours-2')
  applyLogEvent(state, turnEnd(12, { kind: 'completed' }))

  assert.equal(state.runs.length, 1)
  const run = state.runs[0]
  assert.deepEqual(run.ids, ['ours-1', 'ours-2'])
  assert.equal(run.count, 2)
  assert.equal(run.final.messageId, 'a-ours-2', 'the badge lands on the run\'s last output')
  assert.equal(run.final.count, 2)
  assert.equal(run.final.endedBy, 'completed')
  assert.deepEqual(run.foldTurns, [10, 11], 'the truncations it answered fold away')
  assert.deepEqual(run.turns, [11, 12], 'the continuation inputs live in the turns they opened')
  // The person's own message is never part of a run.
  assert.equal(run.ids.includes('person-1'), false)
})

test('the context window ending a run is named as such', () => {
  const state = createLedgerState()
  truncationAndContinue(state, 1, 'ours-1')
  applyLogEvent(state, turnEnd(2, { kind: 'error', error: { code: CONTEXT_EXCEEDED_CODE, message: 'too long' } }))

  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].final.endedBy, 'context-overflow')
})

test('an ordinary error closes the run without pretending it overflowed', () => {
  const state = createLedgerState()
  truncationAndContinue(state, 1, 'ours-1')
  applyLogEvent(state, turnEnd(2, { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }))
  assert.equal(state.runs[0].final.endedBy, 'error')
})

test('the person typing closes the run they interrupted', () => {
  const state = createLedgerState()
  truncationAndContinue(state, 1, 'ours-1')
  applyLogEvent(state, turnEnd(2, { kind: 'completed' }))
  applyLogEvent(state, userMessage('person-2', false))
  applyLogEvent(state, stepStart(3))

  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].final.endedBy, 'completed')
  assert.equal(state.open, null, 'a fresh episode has not opened yet')
})

test('a truncation with no continuation behind it opens nothing', () => {
  const state = createLedgerState()
  applyLogEvent(state, turnEnd(1, { kind: 'max-tokens' }))
  applyLogEvent(state, turnEnd(2, { kind: 'completed' }))
  assert.equal(state.runs.length, 0)
  assert.equal(state.open, null)
  assert.equal(foldIndex(state).ids.length, 0)
})

test('a run still in flight is included in the fold but never annotated', () => {
  const state = createLedgerState()
  truncationAndContinue(state, 1, 'ours-1')
  const index = foldIndex(state)
  assert.deepEqual(index.ids, ['ours-1'], 'the in-flight input folds away')
  assert.deepEqual(index.finals, [], 'nothing is annotated before the run ends')
})

test('a log that starts mid-episode still yields a closed run', () => {
  const state = createLedgerState()
  applyLogEvent(state, userMessage('ours-late', true))
  applyLogEvent(state, stepStart(2))
  applyLogEvent(state, assistantMessage('a-late', 2))
  applyLogEvent(state, turnEnd(2, { kind: 'completed' }))
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].final.messageId, 'a-late')
})

test('foldLog reads the tail and stays bounded', () => {
  const events = []
  for (let index = 0; index < 3; index += 1) {
    events.push(turnEnd(100 + index, { kind: 'max-tokens' }))
    events.push(userMessage(`ours-${index}`, true))
    events.push(stepStart(101 + index))
    events.push(assistantMessage(`a-${index}`, 101 + index))
  }
  events.push(turnEnd(103, { kind: 'completed' }))
  const state = foldLog(events)
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].count, 3)
  assert.equal(foldLog(undefined).runs.length, 0)
  assert.equal(foldLog('nope').runs.length, 0)
})
