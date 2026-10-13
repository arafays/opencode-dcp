/**
 * Prompt texts injected into model context, adapted to V2 transcript
 * semantics (wire messages instead of stored parts).
 */

import { budgetClause, contextUsage, ZERO_GAIN_MIN_TOKENS, ZERO_GAIN_STANDING_SUMMARY_FRACTION } from "./constants"

export const SYSTEM = `
You manage your own context window. Your only context-management tool is \`prune\`: it replaces older conversation ranges with summaries you write, freeing tokens.

Prune completed work that is no longer relevant to the current task: finished research, verified implementations, exhausted explorations, and dead ends. Prefer messages not yet inside a compressed section - re-summarizing an already-compressed section frees nothing unless the replacement summary is substantially shorter, and dropping a dead section outright is the rare case that does help. Keep everything still relevant to the current task - especially exact code, error messages, file contents, and user requirements - verbatim.

Judging what to prune is a scan, not a task in itself: read the topic and age of each range once, decide with the checklist in the reminder, batch what qualifies, and move on. A summary you write is the work - pruning is the cheap default, deliberating over it is not.

Context pressure notes arrive as \`<dcp-system-reminder>\` messages re-measured on every dispatch: only the newest note's numbers are current. Never prune again over a figure from an older note - a completed prune is confirmed by its tool result and by the next reminder. Every note reports occupancy against your context window, the only size you can check yourself; a note that says the window is exceeded is reporting an over-estimate, not a larger window.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.
`

export const PRUNE_RANGE = `Replace one or more conversation ranges with your own dense summaries.

SUMMARIES
Keep decisions, file paths, signatures, constraints, findings, and current task state, including the latest mode/agent transition, preview URL, verification status, and unfinished work. Keep observed facts and their sources; never invent details or turn guesses into findings. Quote short user messages verbatim; never alter user intent, scope, constraints, priorities, or acceptance criteria. Drop noise: failed attempts, verbose tool output, back-and-forth exploration.

BOUNDARY IDS
Each range is { startId, endId, summary }; both endpoints are required, even for one block: { startId: "b10", endId: "b10", summary: "Obsolete research dropped." }. Copy IDs from currently visible <dcp-message-id> tags: mNNNN = raw messages, bN = previously pruned blocks. IDs must exist in context; startId must come before or equal endId. Batch independent non-overlapping ranges in one call, not parallel prune calls.
mNNNN IDs are renumbered every dispatch and strictly ascending in transcript order, so a lower number is ALWAYS an earlier message. Visible tags may have gaps: never infer missing IDs or reuse endpoints from earlier calls. After an unknown-ID error, use currently visible tags, not guessed increments or decrements. A range spanning the whole transcript is fine - m0001 to the last ID, when both tags are visible - if its summary preserves all still-needed information.

PREVIOUSLY PRUNED BLOCKS
A range may cover pruned block summaries (marked [Compressed conversation section] with a bN ID):
- Include \`(bN)\` exactly once in the summary to carry that block's full content forward; write surrounding text so it still reads after expansion.
- Omit \`(bN)\` to permanently drop that block's content. Do this when the work it describes no longer matters to the current task.
- Never emit \`(bN)\` text outside a placeholder; mention blocks in prose as plain text like \`pruned bN\`.
- A range covering ONLY already-compressed messages is rejected unless the replacement summary is at most ${(ZERO_GAIN_STANDING_SUMMARY_FRACTION * 100).toFixed(0)}% the size of the standing summary AND frees at least ${ZERO_GAIN_MIN_TOKENS} tokens. Placeholder-free drops of dead content may free less than ${ZERO_GAIN_MIN_TOKENS} tokens but must still halve the standing summary and save tokens. A same-size re-summarization is a no-op that costs a whole model turn.
- After a low-gain rejection, leave that block alone unless you can substantially shorten it. Continue the task if nothing else qualifies; the pruning budget is a housekeeping threshold, not proof the model window is full.

OUTPUT FORMAT
Call with topic (3-5 word label) and content: [{ startId, endId, summary }, ...].
`

/**
 * Pressure nudge. The measurement LEADS with the model window - the only
 * denominator the model can reason about - and the pruning budget follows as
 * a plain threshold, never as a percentage (see `contextUsage` in
 * constants.ts: a budget-first headline like "999% of the pruning budget"
 * reads as a catastrophe and drove panic-pruning at 12% real occupancy).
 * States that the number is re-estimated per dispatch so an older figure is
 * never acted on, and hands over a check-list judgement for WHAT to prune,
 * so deciding costs one scan rather than a deliberation (a model reasoning
 * its way to "maybe I should prune" burns the tokens it is trying to free).
 *
 * The trailing verdict is derived from the same budget comparison that
 * produced the clause, so the two can never contradict each other. The gate in
 * `maybeContextNudge` only calls this at or above budget, but the function is
 * exported and must not print "the budget is not reached - prune now" if it
 * is ever called below it.
 */
export const CONTEXT_LIMIT_NUDGE = (usageTokens: number, budget: number, window: number) => `<dcp-system-reminder>
Context is ${contextUsage(usageTokens, window)}${budgetClause(usageTokens, budget)}${usageTokens >= budget ? " - prune now." : " - no pruning needed."} Re-measured on this dispatch, so it supersedes any earlier reminder - do not prune again over a stale number.

Decide in one pass over the boundary IDs, oldest first - do not deliberate. Prefer messages not yet inside a compressed section; a range qualifies when BOTH are true:
- its work is finished (research concluded, code verified, dead end, or its outcome is already stated in later messages), and
- the current task needs nothing from it verbatim (code, errors, file contents or requirements still referenced must stay).
An active compressed section (bN) qualifies only when its whole content is dead - drop it in a one-liner - or when you can replace its summary with a substantially shorter one; re-summarizing a section you already summarized frees nothing and is rejected.
When only one candidate exists, prune it; when in doubt between two, prune the older one. Batch every qualifier into a single \`prune\` call - one entry per range, 3-5 word topic, summary keeping decisions/paths/findings/constraints and dropping back-and-forth noise. If nothing qualifies, continue working: no fragments, no further analysis.
</dcp-system-reminder>`

/**
 * One-shot acknowledgement for the first dispatch after a successful prune:
 * resolves the previous pressure reminder (whose number predates the prune)
 * and says whether another pass is warranted, so the model is not pushed into
 * pruning again on a number it already acted on. Same window-first spelling as
 * the nudge - the two share `contextUsage`/`budgetClause`, so the
 * acknowledgement can never restate the occupancy in a different notation
 * from the reminder it resolves.
 */
export const POST_PRUNE_ACK = (
  usageTokens: number,
  budget: number,
  window: number,
  blockRef: string | undefined,
  stillOverBudget: boolean,
  messagesCovered: number | undefined,
) => `<dcp-system-reminder>
Prune applied${blockRef ? ` (${blockRef})` : ""}: the earlier context reminder is resolved - that number predates the prune, and this dispatch re-measures ${contextUsage(usageTokens, window)}${budgetClause(usageTokens, budget)}.
${stillOverBudget
    ? messagesCovered === 0
      ? "That pass covered no new messages - it only re-summarized an already-compressed section, so it must not be repeated: prune messages outside the active compressed sections."
      : "Still above the pruning budget: prune again only if another meaningfully sized closed section has appeared outside the active compressed sections; otherwise continue working."
    : "No further pruning needed - continue with the current task."}
</dcp-system-reminder>`

export const ITERATION_NUDGE = (messages: number) => `<dcp-system-reminder>
${messages} messages since the last user turn. If any completed work is no longer relevant to the current task, \`prune\` it.
</dcp-system-reminder>`

/**
 * The human-readable opener `/dcp-prune` stores as its user turn (see
 * `storedPruneMessage` in lib/commands.ts). Only a DEFAULT match target for the
 * context hook's release test: the command pins its reminder to the exact stored
 * line it produced, so a dispatch carrying that text is by definition the one
 * that shows the model the user's request. The prefix alone would also match an
 * EARLIER `/dcp-prune`'s still-visible stored turn and release the newer
 * reminder early (see `takeManualPruneReminder` in lib/nudges.ts).
 */
export const PRUNE_REQUEST_PREFIX = "Prune this conversation now.";

/**
 * Manual-prune reminder, armed by `/dcp-prune` (lib/commands.ts) and consumed
 * by the outbound dispatch that carries the command's stored turn.
 * OUTBOUND-ONLY by
 * construction: the command's STORED user message is plain prose, so this
 * markup never enters session history (where it would render verbatim in the
 * TUI).
 *
 * Unlike the pressure notes it carries no occupancy figure - the user asked,
 * they did not report a number - and says so, so the model does not go looking
 * for a measurement to justify the call. Same one-pass/no-deliberation shape as
 * `CONTEXT_LIMIT_NUDGE`, for the same reason: the summary is the work.
 *
 * `escapedFocus` must already be `JSON.stringify`ed by the caller: the focus
 * sits in a double-quoted slot, and a raw quote or newline in user input would
 * otherwise break out of it.
 */
export const MANUAL_PRUNE_REMINDER = (escapedFocus: string) => `<dcp-system-reminder>
Manual prune requested by the user: immediately call the \`prune\` tool on the largest CLOSED section of this conversation, dropping completed work irrelevant to the current task. User focus (may be empty): ${escapedFocus}
This is an explicit request, not a pressure estimate - no occupancy figure is attached and none is needed. Decide in one pass over the boundary IDs, oldest first; batch every qualifying range into a single \`prune\` call (3-5 word topic, summaries as usual). If nothing qualifies, say so in one line and continue with the current task.
</dcp-system-reminder>`
