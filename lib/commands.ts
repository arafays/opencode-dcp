/**
 * Registers user-facing slash commands. V2 commands expand templates into the
 * conversation; `$ARGUMENTS` receives whatever the user typed after the
 * command. `/dcp-compress` instructs the model to run a compression pass
 * immediately - the model then calls the `compress` tool itself, which keeps
 * permission handling and validation inside the tool.
 */

export function dcpCompressTemplate(): string {
  return [
    "<dcp-system-reminder>",
    "Manual context compression requested by the user.",
    "",
    "Immediately call the `compress` tool now on the largest CLOSED section of this",
    "conversation (research concluded, implementation verified, exploration exhausted).",
    'User focus for what to compress (may be empty): "$ARGUMENTS"',
    "Write an exhaustive technical summary per range. Do not summarize content still",
    "needed verbatim for in-progress work. After the tool confirms, continue with the",
    "user's pending work.",
    "</dcp-system-reminder>",
  ].join("\n")
}

export const DCP_COMPRESS_DESCRIPTION = "Trigger DCP manual compression with: /dcp-compress [focus]"

/** Minimal structural view of a command draft entry (client CommandInfo). */
interface CommandDraftLike {
  update(name: string, update: (command: { name?: string; template?: string; description?: string }) => void): void
}

/** Applies DCP command definitions to the command draft. */
export function registerCommands(draft: CommandDraftLike): void {
  draft.update("dcp-compress", (command) => {
    command.description = DCP_COMPRESS_DESCRIPTION
    command.template = dcpCompressTemplate()
  })
}
