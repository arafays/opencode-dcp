/**
 * Registers user-facing slash commands. V2 commands contribute to the
 * conversation by re-prompting with assembled text via `ctx.session.prompt`.
 * `/dcp-prune` instructs the model to run a pruning pass immediately - the
 * model then calls the `prune` tool itself, which keeps permission handling
 * and validation inside the tool.
 */

import type { CommandDraft, CommandDefinition, CommandInvocation } from "@opencode-ai/plugin/promise/command"
import type { Plugin } from "@opencode-ai/plugin"

function dcpPruneTemplate(): string {
  return [
    "<dcp-system-reminder>",
    "Manual prune requested by the user. Immediately call the `prune` tool on the largest",
    "CLOSED section of this conversation, dropping completed work irrelevant to the current",
    'task. User focus (may be empty): "$ARGUMENTS"',
    "</dcp-system-reminder>",
  ].join("\n")
}

const DCP_PRUNE_DESCRIPTION = "Trigger DCP manual pruning with: /dcp-prune [focus]"

/**
 * Registers DCP command definitions on the command draft. The `dcp-prune`
 * command re-prompts the session with a reminder instructing the model to call
 * the `prune` tool; the user's trailing text becomes the optional focus.
 */
export function registerCommands(draft: CommandDraft, ctx: Plugin.Context): void {
  draft.add({
    name: "dcp-prune",
    description: DCP_PRUNE_DESCRIPTION,
    execute: async (input: CommandInvocation) => {
      const focus = typeof input.prompt.text === "string" ? input.prompt.text.trim() : ""
      const text = dcpPruneTemplate().replaceAll("$ARGUMENTS", focus)
      await ctx.session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text,
        delivery: input.delivery,
      } as Parameters<typeof ctx.session.prompt>[0])
    },
  } satisfies CommandDefinition)
}
