import { SlashCommandBuilder } from "discord.js";
import { type Command, UserError } from "./types.js";

export const leave: Command = {
  data: new SlashCommandBuilder().setName("leave").setDescription("通話を終了してBotをVCから退出させる"),

  async execute(interaction, { sessions }) {
    if (!interaction.guildId || !sessions.stop(interaction.guildId)) throw new UserError("通話中ではありません。");
    await interaction.reply("通話を終了しました。");
  },
};
