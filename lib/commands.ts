/**
 * Registers user-facing slash commands. V2 commands contribute to the
 * conversation by re-prompting the session via `ctx.session.prompt`, and that
 * text is STORED session history - so it may never carry DCP markup
 * (`<dcp-system-reminder>` / `<dcp-message-id>` are environment-injected
 * addressing metadata, and a stored copy renders verbatim in the TUI).
 *
 * `/dcp-prune` asks the model to run a pruning pass immediately. The stored
 * message is the user's own, human-readable request; the instruction to call
 * the `prune` tool travels OUTBOUND ONLY as a one-shot reminder, armed here and
 * consumed by the context hook (`injectNudges` in transform.ts) on the very
 * next dispatch - the one this prompt triggers. That keeps internal metadata
 * out of the transcript while permission handling and validation stay inside
 * the tool.
 */

import type {
  CommandEditor,
  CommandDefinition,
  CommandInvocation,
} from "@opencode/plugin/promise/command";
import type { Plugin } from "@opencode/plugin";

import { armManualPruneReminder, disarmManualPruneReminder } from "./nudges";
import { MANUAL_PRUNE_REMINDER, PRUNE_REQUEST_PREFIX } from "./prompts";
import { stripHallucinatedTags } from "./transcript/edit";

const DCP_PRUNE_DESCRIPTION = "Trigger DCP manual pruning with: /dcp-prune [focus]";

/**
 * The user turn `/dcp-prune` stores. Deliberately plain prose: this is the one
 * piece of the command the user sees in the TUI, so it carries the request and
 * the focus and nothing else. Never empty - a bare `/dcp-prune` still needs a
 * non-blank stored message to dispatch on.
 *
 * DCP markup is stripped from the focus because the file's own invariant is that
 * these tags never reach session history, and the focus is the one piece of the
 * turn the plugin does not author. Only the STORED text is scrubbed: the
 * outbound reminder keeps the focus verbatim (escaped), so the model still reads
 * exactly what the user typed. `stripHallucinatedTags` removes the tag SYNTAX
 * only, so a pasted `<dcp-message-id>m0001</dcp-message-id>` degrades to the bare
 * reference "m0001" - inert plain text, not markup - and a focus that strips to
 * nothing at all falls back to the bare request.
 */
export function storedPruneMessage(focus: string): string {
  const safe = stripHallucinatedTags(focus).trim();
  return safe ? `${PRUNE_REQUEST_PREFIX} Focus: ${safe}` : PRUNE_REQUEST_PREFIX;
}

/**
 * Registers DCP command definitions on the command draft. The `dcp-prune`
 * command stores a short human-readable request and re-prompts the session;
 * the user's trailing text becomes the optional focus, which is quoted into
 * the outbound-only reminder.
 */
export function registerCommands(editor: CommandEditor, ctx: Plugin.Context): void {
  editor.add({
    name: "dcp-prune",
    description: DCP_PRUNE_DESCRIPTION,
    execute: async (input: CommandInvocation) => {
      const focus = typeof input.prompt.text === "string" ? input.prompt.text.trim() : "";
      const stored = storedPruneMessage(focus);
      // JSON.stringify escapes quotes/newlines in the focus so they cannot
      // break out of the double-quoted focus slot in the reminder template.
      // Armed BEFORE the prompt: that prompt is the dispatch that consumes it.
      // The marker is THIS invocation's stored text, so an earlier
      // `/dcp-prune`'s still-visible stored turn cannot spend the reminder.
      armManualPruneReminder(input.sessionID, MANUAL_PRUNE_REMINDER(JSON.stringify(focus)), stored);
      try {
        await ctx.session.prompt({
          ...input.prompt,
          sessionID: input.sessionID,
          text: stored,
          delivery: input.delivery,
        } as Parameters<typeof ctx.session.prompt>[0]);
      } catch (error) {
        // The prompt failed, so no dispatch will ever consume the reminder.
        // Drop it instead of letting "prune now" misfire on a later prompt;
        // the failure itself still propagates to the caller.
        disarmManualPruneReminder(input.sessionID);
        throw error;
      }
    },
  } satisfies CommandDefinition);
}
