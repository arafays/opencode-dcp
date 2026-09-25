/**
 * Prompt texts injected into model context, adapted to V2 transcript
 * semantics (wire messages instead of stored parts).
 */

import { percentOf, tokenLabel, windowClause } from "./constants"

export const SYSTEM = `
You manage your own context window. Your only context-management tool is \`prune\`: it replaces older conversation ranges with summaries you write, freeing tokens.

Prune completed work that is no longer relevant to the current task: finished research, verified implementations, exhausted explorations, and dead ends. Prefer messages not yet inside a compressed section - re-summarizing an already-compressed section frees nothing unless the replacement summary is substantially shorter, and dropping a dead section outright is the rare case that does help. Keep everything still relevant to the current task - especially exact code, error messages, file contents, and user requirements - verbatim.

Judging what to prune is a scan, not a task in itself: read the topic and age of each range once, decide with the checklist in the reminder, batch what qualifies, and move on. A summary you write is the work - pruning is the cheap default, deliberating over it is not.

Context pressure notes arrive as \`<dcp-system-reminder>\` messages re-measured on every dispatch: only the newest note's numbers are current. Never prune again over a percentage from an older note - a completed prune is confirmed by its tool result and by the next reminder.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.
`

export const PRUNE_RANGE = `Replace one or more conversation ranges with your own dense summaries.

SUMMARIES
Keep decisions, file paths, signatures, constraints, findings, and current task state. Quote short user messages verbatim; never alter user intent, scope, constraints, priorities, or acceptance criteria. Drop noise: failed attempts, verbose tool output, back-and-forth exploration.

BOUNDARY IDS
Each range is { startId, endId, summary }. Use IDs from <dcp-message-id> tags: mNNNN = raw messages, bN = previously pruned blocks. IDs must exist in context; startId must come before endId. Batch independent non-overlapping ranges as separate entries in one call's content array.

PREVIOUSLY PRUNED BLOCKS
A range may cover pruned block summaries (marked [Compressed conversation section] with a bN ID):
- Include \`(bN)\` exactly once in the summary to carry that block's full content forward; write surrounding text so it still reads after expansion.
- Omit \`(bN)\` to permanently drop that block's content. Do this when the work it describes no longer matters to the current task.
- Never emit \`(bN)\` text outside a placeholder; mention blocks in prose as plain text like \`pruned bN\`.
- A range covering ONLY already-compressed messages is rejected when it would free fewer than max(32, 1/4 of the standing summary) tokens: same-size re-summarization is a no-op. Prune uncovered messages instead, or fold/drop a block only with a substantially shorter summary.

OUTPUT FORMAT
Call with topic (3-5 word label) and content: [{ startId, endId, summary }, ...].
`

/**
 * Pressure nudge. Names absolute tokens first, then both denominators
 * explicitly (budget, and window when it differs), states that the number is
 * re-estimated per dispatch so an older percentage is never acted on - and
 * hands over a check-list judgement for WHAT to prune, so deciding costs one
 * scan rather than a deliberation (a model reasoning its way to "maybe I
 * should prune" burns the tokens it is trying to free).
 */
export const CONTEXT_LIMIT_NUDGE = (usageTokens: number, budget: number, window: number) => `<dcp-system-reminder>
Context is ~${tokenLabel(usageTokens)} tokens: ${percentOf(usageTokens, budget)}% of the ${tokenLabel(budget)}-token pruning budget${windowClause(usageTokens, budget, window)}. Re-measured on this dispatch, so it supersedes any earlier reminder - do not prune again over a stale number.

Decide in one pass over the boundary IDs, oldest first - do not deliberate. Prefer messages not yet inside a compressed section; a range qualifies when BOTH are true:
- its work is finished (research concluded, code verified, dead end, or its outcome is already stated in later messages), and
- the current task needs nothing from it verbatim (code, errors, file contents or requirements still referenced must stay).
An active compressed section (bN) qualifies only when its whole content is dead - drop it in a one-liner - or when you can replace its summary with a substantially shorter one; re-summarizing a section you already summarized frees nothing and is rejected.
When only one candidate exists, prune it; when in doubt between two, prune the older one. Batch every qualifier into a single \`prune\` call - one entry per range, 3-5 word topic, summary keeping decisions/paths/findings/constraints and dropping back-and-forth noise. If nothing qualifies, continue working: no fragments, no further analysis.
</dcp-system-reminder>`

/**
 * One-shot acknowledgement for the first dispatch after a successful prune:
 * resolves the previous pressure reminder (whose percentage predates the
 * prune) and says whether another pass is warranted, so the model is not
 * pushed into pruning again on a number it already acted on.
 */
export const POST_PRUNE_ACK = (
  usageTokens: number,
  budget: number,
  window: number,
  blockRef: string | undefined,
  stillOverBudget: boolean,
  messagesCovered: number | undefined,
) => `<dcp-system-reminder>
Prune applied${blockRef ? ` (${blockRef})` : ""}: the earlier context reminder is resolved - that percentage predates the prune, and this dispatch re-measures ~${tokenLabel(usageTokens)} tokens: ${percentOf(usageTokens, budget)}% of the ${tokenLabel(budget)}-token pruning budget${windowClause(usageTokens, budget, window)}.
${stillOverBudget
    ? messagesCovered === 0
      ? "That pass covered no new messages - it only re-summarized an already-compressed section, so it must not be repeated: prune messages outside the active compressed sections."
      : "Still above the pruning budget: prune again only if another meaningfully sized closed section has appeared outside the active compressed sections; otherwise continue working."
    : "No further pruning needed - continue with the current task."}
</dcp-system-reminder>`

export const ITERATION_NUDGE = (messages: number) => `<dcp-system-reminder>
${messages} messages since the last user turn. If any completed work is no longer relevant to the current task, \`prune\` it.
</dcp-system-reminder>`
