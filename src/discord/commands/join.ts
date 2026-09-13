import { SlashCommandBuilder, type GuildMember } from "discord.js";
import { type Command, UserError } from "./types.js";

export const join: Command = {
  data: new SlashCommandBuilder().setName("join").setDescription("あなたがいるVCにBotを呼んで通話を始める"),

  async execute(interaction, { sessions }) {
    const channel = (interaction.member as GuildMember | null)?.voice.channel;
    if (!interaction.guildId || !channel) throw new UserError("先にボイスチャンネルに入ってから /join してください。");
    if (sessions.has(interaction.guildId)) throw new UserError("このサーバーではすでに通話中です。/leave で終了できます。");

    await interaction.deferReply();
    await sessions.start(channel, interaction.user.id);
    await interaction.editReply(`${channel.name} に参加しました。そのまま話しかけてください。`);
  },
};
