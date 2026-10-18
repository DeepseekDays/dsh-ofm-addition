/**
 * OFM Addition — the prompt this plugin sends.
 *
 * `createUserMessage` is reimplemented rather than imported. It is ten lines
 * of value construction, and a plugin that loads in a composition without
 * `@deepseek-ai/dsh-llm` on its resolution path should still be able to speak;
 * the harness's own context plugins take the same route.
 *
 * @module src/message.js
 */

import { randomUUID } from 'node:crypto'

/** Bound for a `notice` summary, matching the harness's own 120-character rule. */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/** Bound one `notice` summary the way the harness bounds its own. */
export function boundContextSummary(summary) {
  const text = String(summary ?? '')
  return text.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/** Deep-freeze a value graph, leaving AbortSignals alone. */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof AbortSignal) return value
  if (seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return value
}

/**
 * Create one identified, immutable user-role message.
 * @param input - `{ content, source }`
 * @returns a detached user message with a fresh identity
 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/** The source tag that marks a message as this plugin's own. */
export const NOTICE_KIND = 'ofm-addition'

/**
 * Build the message a continuation sends.
 *
 * Two presentations, because both are defensible: `user` reads exactly like the
 * person typing "继续" (what the harness hint tells them to do, and what the
 * transcript should show), while `notice` marks the turn as automation-triggered
 * so nobody mistakes it for their own input. Either way the model sees the same
 * text — only the durable source differs.
 *
 * @param prompt - resolved prompt text
 * @param mode - `user` or `notice`
 * @returns an immutable user-role message
 */
export function buildContinuation(prompt, mode) {
  const content = [{ type: 'text', text: prompt }]
  if (mode === 'notice') {
    return createUserMessage({
      content,
      source: {
        kind: NOTICE_KIND,
        form: 'notice',
        summary: boundContextSummary(prompt),
      },
    })
  }
  // `ofmAddition` is a marker, not a harness field: it lets a cold read of the
  // log tell this apart from something a person typed, without pretending to be
  // a source kind the client would then have to render specially.
  return createUserMessage({ content, source: { kind: 'user', ofmAddition: true } })
}
