/**
 * OFM Addition — local state.
 *
 * Two JSON documents under the harness home: the settings a person edits and
 * the counters the settings page reads back. Both are written through a temp
 * file plus rename, so a crash mid-write cannot leave a half document behind.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** Sibling of the Our Free Model data directory, never inside it. */
export const DATA_DIR_NAME = 'ofm-addition'

/** How many recent fixtures the stats document keeps for the settings page. */
export const HISTORY_LIMIT = 60

export class JsonStore {
  /**
   * @param file - absolute path
   * @param initial - value used when the file does not exist yet
   */
  constructor(file, initial) {
    this.file = file
    this.value = initial
    this.dirty = false
    this.timer = undefined
    this.disposed = false
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...this.value, ...parsed }
      }
    } catch {
      // Absent or unreadable: keep the initial value, the next write replaces it.
    }
  }

  get() {
    return this.value
  }

  /** Merge a patch in and schedule the write. Returns the new value. */
  update(patch) {
    if (this.disposed) return this.value
    this.value = { ...this.value, ...patch }
    this.schedule()
    return this.value
  }

  /** Mutate through a callback; used for read-modify-write on nested state. */
  edit(mutate) {
    if (this.disposed) return this.value
    const next = mutate(structuredClone(this.value))
    if (next !== undefined) this.value = next
    this.schedule()
    return this.value
  }

  schedule(delayMs = 500) {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    // Bookkeeping must never hold the process open.
    this.timer.unref?.()
  }

  flush() {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.value, undefined, 2), { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } catch {
      // Fail soft: the next mutation retries and nothing downstream depends on it.
    }
  }

  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // Persist what this generation changed, then lock the store so a late
    // callback from a hot-reloaded-away generation cannot write over its
    // successor's state.
    this.flush()
    this.disposed = true
    this.dirty = false
  }
}

/** The stats document a fresh install starts from. */
export function initialStats() {
  return {
    version: 1,
    /** Prompts this plugin has sent, ever. */
    sent: 0,
    /** Decisions that produced nothing, keyed by outcome. */
    outcomes: {},
    /** Newest-first record of what happened, for the settings page. */
    history: [],
    /** Session id of the most recent send, so the page can point at it. */
    lastSessionId: '',
  }
}

/**
 * Fold one decision into the stats document.
 *
 * @param store - the stats JsonStore
 * @param record - `{ outcome, sessionId, model, provider, streak, at, prompt, detail }`
 * @returns the updated stats
 */
export function recordOutcome(store, record) {
  return store.edit((state) => {
    const outcomes = { ...(state.outcomes ?? {}) }
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1
    const entry = {
      at: record.at,
      outcome: record.outcome,
      sessionId: record.sessionId ?? '',
      provider: record.provider ?? '',
      model: record.model ?? '',
      streak: record.streak ?? 0,
      prompt: record.prompt ?? '',
      detail: record.detail ?? '',
    }
    return {
      ...state,
      sent: (state.sent ?? 0) + (record.outcome === 'sent' ? 1 : 0),
      outcomes,
      history: [entry, ...(state.history ?? [])].slice(0, HISTORY_LIMIT),
      lastSessionId: record.outcome === 'sent' ? entry.sessionId : state.lastSessionId ?? '',
    }
  })
}
