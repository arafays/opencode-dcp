/**
 * Registers user-facing slash commands. V2 commands expand templates into the
 * conversation; `$ARGUMENTS` receives whatever the user typed after the
 * command. `/dcp-prune` instructs the model to run a pruning pass
 * immediately - the model then calls the `prune` tool itself, which keeps
 * permission handling and validation inside the tool.
 */

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

/** Minimal structural view of a command draft entry (client CommandInfo). */
interface CommandDraftLike {
  update(name: string, update: (command: { name?: string; template?: string; description?: string }) => void): void
}

/** Applies DCP command definitions to the command draft. */
export function registerCommands(draft: CommandDraftLike): void {
  draft.update("dcp-prune", (command) => {
    command.description = DCP_PRUNE_DESCRIPTION
    command.template = dcpPruneTemplate()
  })
}
