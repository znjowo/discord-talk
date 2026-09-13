/** Owns the active VoiceSessions. MVP: at most one call per guild. */
import type { VoiceBasedChannel } from "discord.js";
import { log } from "../log.js";
import { VoiceSession } from "./session.js";

export class SessionManager {
  private readonly sessions = new Map<string, VoiceSession>();

  get(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  has(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  async start(channel: VoiceBasedChannel, userId: string): Promise<VoiceSession> {
    const guildId = channel.guild.id;
    if (this.sessions.has(guildId)) throw new Error(`session already active in guild ${guildId}`);
    const session = new VoiceSession(channel, userId, () => {
      if (this.sessions.get(guildId) === session) this.sessions.delete(guildId);
    });
    this.sessions.set(guildId, session);
    try {
      await session.start();
    } catch (err) {
      session.destroy();
      throw err;
    }
    return session;
  }

  /** @returns false if there was nothing to stop */
  stop(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.destroy();
    return true;
  }

  stopAll(): void {
    for (const s of [...this.sessions.values()]) s.destroy();
    log.info("all sessions stopped");
  }
}
