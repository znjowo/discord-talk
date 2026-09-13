import { Events, MessageFlags, type Client } from "discord.js";
import { log } from "../../log.js";
import { commandMap } from "../commands/index.js";
import { type CommandContext, UserError } from "../commands/types.js";

export function registerInteractionHandler(client: Client, ctx: CommandContext): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = commandMap.get(interaction.commandName);
    if (!command) {
      log.warn("unknown command", interaction.commandName);
      return;
    }
    try {
      await command.execute(interaction, ctx);
    } catch (err) {
      const isUserError = err instanceof UserError;
      if (!isUserError) log.error(`/${interaction.commandName} failed`, err);
      const content = isUserError ? err.message : `エラー: ${(err as Error).message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(content);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  });
}
