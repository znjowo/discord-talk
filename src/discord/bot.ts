import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { SessionManager } from "../voice/manager.js";
import { commands } from "./commands/index.js";
import type { CommandContext } from "./commands/types.js";
import { registerInteractionHandler } from "./events/interactionCreate.js";
import { registerVoiceStateHandler } from "./events/voiceStateUpdate.js";

export interface Bot {
  client: Client;
  sessions: SessionManager;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createBot(): Bot {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const sessions = new SessionManager();
  const ctx: CommandContext = { sessions };

  client.once(Events.ClientReady, async (c) => {
    log.info(`logged in as ${c.user.tag}`);
    await registerCommands(c);
  });
  client.on(Events.Error, (err) => log.error("discord client error", err));
  registerInteractionHandler(client, ctx);
  registerVoiceStateHandler(client, ctx);

  return {
    client,
    sessions,
    start: async () => {
      await client.login(config.discordToken);
    },
    shutdown: async () => {
      sessions.stopAll();
      await client.destroy();
    },
  };
}

async function registerCommands(client: Client<true>): Promise<void> {
  const data = commands.map((c) => c.data.toJSON());
  if (config.discordGuildId) {
    await client.application.commands.set(data, config.discordGuildId);
    log.info(`registered ${data.length} commands to guild ${config.discordGuildId}`);
  } else {
    await client.application.commands.set(data);
    log.info(`registered ${data.length} commands globally (may take up to 1h to appear)`);
  }
}
