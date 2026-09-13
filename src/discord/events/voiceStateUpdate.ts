import { Events, type Client } from "discord.js";
import { log } from "../../log.js";
import type { CommandContext } from "../commands/types.js";

/** End the call automatically when the user we're talking to leaves the channel. */
export function registerVoiceStateHandler(client: Client, { sessions }: CommandContext): void {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const session = sessions.get(oldState.guild.id);
    if (!session || oldState.id !== session.userId) return;
    if (oldState.channelId === session.channel.id && newState.channelId !== session.channel.id) {
      log.info("user left the voice channel, ending call");
      sessions.stop(oldState.guild.id);
    }
  });
}
