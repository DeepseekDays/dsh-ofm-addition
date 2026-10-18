/**
 * OFM Addition — what one auto-continued run looked like.
 *
 * A "run" is the stretch between a person acting and the model finally
 * finishing: it opens at the first continuation this plugin sent and closes at
 * the first turn that ends on anything but a truncation. Two things downstream
 * need it — the transcript folds the run's own rows away, and the run's last
 * output carries the count.
 *
 * Everything here is derived from the durable session log rather than kept as
 * live bookkeeping, so the transcript of a session that finished before this
 * plugin was even loaded reads back correctly, and there is no second source of
 * truth to drift.
 *
 * @module src/ledger.js
 */

import { CONTEXT_EXCEEDED_CODE } from './policy.js'

/** How far back a rebuild reads. Runs are recent; older history is not worth the scan. */
export const MAX_SCAN_EVENTS = 20_000

/** A fresh fold state. */
export function createLedgerState() {
  return {
    /** Closed runs, oldest first. */
    runs: [],
    /** The run still in progress, or null. */
    open: null,
    /** Turn of the most recent truncation, which the next continuation answers. */
    lastMaxTokensTurn: null,
    /** Most recent assistant output seen, whatever turn it belonged to. */
    lastAssistant: null,
    /** Turn the log is currently inside, tracked from `step/start`. */
    currentTurn: null,
    /** How many events have folded in, so a rebuild can report progress. */
    seen: 0,
  }
}

function newRun(at) {
  return {
    count: 0,
    ids: [],
    seqs: [],
    /** Turns that hold one of this run's continuation inputs. */
    turns: [],
    /** Turns whose truncation notice this run already answered. */
    foldTurns: [],
    startedAt: at,
    final: null,
  }
}

/** Close an open run, freezing the output it ended on. */
function closeRun(state, endedBy, at) {
  const run = state.open
  if (run === null) return
  state.open = null
  run.endedBy = endedBy
  run.endedAt = at
  run.final = state.lastAssistant === null
    ? null
    : {
        messageId: state.lastAssistant.messageId,
        seq: state.lastAssistant.seq,
        time: state.lastAssistant.time,
        turn: state.lastAssistant.turn,
        count: run.count,
        endedBy,
      }
  state.runs.push(run)
}

/**
 * Fold one durable session event into the state.
 *
 * Recognizes exactly four event types; anything else is irrelevant to a run.
 * @param state - ledger state, mutated in place
 * @param event - one session event, in log order
 */
export function applyLogEvent(state, event) {
  if (event === null || typeof event !== 'object') return
  state.seen += 1
  switch (event.type) {
    case 'step/start':
      state.currentTurn = event.data?.turn ?? state.currentTurn
      return
    case 'assistant/message': {
      const id = event.data?.message?.id
      state.lastAssistant = {
        messageId: typeof id === 'string' ? id : '',
        seq: event.seq,
        time: event.time,
        turn: event.data?.turn ?? state.currentTurn,
      }
      return
    }
    case 'user/message': {
      const source = event.data?.source
      if (source?.ofmAddition === true) {
        // This plugin's own continuation: it opens a run, or extends the one
        // already in flight.
        state.open ??= newRun(event.time)
        const run = state.open
        run.count += 1
        if (typeof event.data?.id === 'string') run.ids.push(event.data.id)
        run.seqs.push(event.seq)
        if (state.currentTurn !== null) run.turns.push(state.currentTurn)
        if (state.lastMaxTokensTurn !== null) run.foldTurns.push(state.lastMaxTokensTurn)
        return
      }
      // A real person typing ends whatever run was in flight: their action is
      // the start of the next episode, so the next count belongs to it.
      if (source?.kind === 'user') closeRun(state, 'user-input', event.time)
      return
    }
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'max-tokens') {
        state.lastMaxTokensTurn = event.data?.turn ?? null
        return
      }
      if (state.open === null) return
      const overflow = reason?.kind === 'error' && reason?.error?.code === CONTEXT_EXCEEDED_CODE
      closeRun(state, overflow ? 'context-overflow' : String(reason?.kind ?? 'unknown'), event.time)
      return
    }
    default:
  }
}

/**
 * What the transcript needs to fold a session and annotate it.
 *
 * @param state - a folded ledger state
 * @returns `{ ids, turns, finals }` — the message ids and truncation turns to
 *   fold away, plus one annotation per closed run
 */
export function foldIndex(state) {
  const ids = []
  const turns = []
  const finals = []
  const open = state.open === null ? [] : [state.open]
  for (const run of [...state.runs, ...open]) {
    for (const id of run.ids) if (!ids.includes(id)) ids.push(id)
    for (const turn of run.foldTurns) if (!turns.includes(turn)) turns.push(turn)
  }
  for (const run of state.runs) {
    if (run.final !== null && run.final.messageId !== '') finals.push(run.final)
  }
  return { ids, turns, finals }
}

/**
 * Fold a whole event log, reading only the recent tail.
 *
 * @param events - the session log, oldest first
 * @returns a folded ledger state
 */
export function foldLog(events) {
  const list = Array.isArray(events) ? events : []
  const state = createLedgerState()
  const from = Math.max(0, list.length - MAX_SCAN_EVENTS)
  // A truncated head can start mid-episode; begin at the first truncation so a
  // run is never opened by a continuation whose truncation was cut off.
  for (let index = from; index < list.length; index += 1) applyLogEvent(state, list[index])
  return state
}
