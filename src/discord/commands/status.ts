import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";

export const status: Command = {
  data: new SlashCommandBuilder().setName("status").setDescription("現在の通話状態を表示する"),

  async execute(interaction, { sessions }) {
    const session = interaction.guildId ? sessions.get(interaction.guildId) : undefined;
    if (!session) {
      await interaction.reply({ content: "通話中ではありません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const s = session.stats();
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: [
        `📞 ${session.channel.name} / <@${session.userId}>`,
        `経過: ${Math.round(s.uptimeMs / 1000)}s`,
        `再生待ち: ${s.queuedMs}ms / 音切れ(underrun): ${s.underruns}回`,
        s.lastResponseLatencyMs !== undefined ? `直近の応答遅延: ${s.lastResponseLatencyMs}ms` : "",
        s.lastInterruptStopMs !== undefined ? `直近の割り込み停止: ${s.lastInterruptStopMs}ms` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  },
};
