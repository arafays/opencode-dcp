/**
 * Prompt texts injected into model context, adapted to V2 transcript
 * semantics (wire messages instead of stored parts).
 */

export const SYSTEM = `
You manage your own context window. Your only context-management tool is \`prune\`: it replaces older conversation ranges with summaries you write, freeing tokens.

Prune completed work that is no longer relevant to the current task: finished research, verified implementations, exhausted explorations, dead ends, and stale previously-pruned sections. Keep everything still relevant to the current task - especially exact code, error messages, file contents, and user requirements - verbatim.

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

OUTPUT FORMAT
Call with topic (3-5 word label) and content: [{ startId, endId, summary }, ...].
`

export const CONTEXT_LIMIT_NUDGE = (usagePercent: number, maxLabel: string) => `<dcp-system-reminder>
Context at ~${usagePercent}% of budget (${maxLabel}). If a meaningfully sized closed section exists, call \`prune\` on it: summarize what still matters, drop completed work irrelevant to the current task, and omit (bN) placeholders for stale pruned blocks whose content can go. Keep anything needed verbatim. If nothing is worth pruning yet, continue working - do not prune trivial fragments.
</dcp-system-reminder>`

export const ITERATION_NUDGE = (messages: number) => `<dcp-system-reminder>
${messages} messages since the last user turn. If any completed work is no longer relevant to the current task, \`prune\` it.
</dcp-system-reminder>`
