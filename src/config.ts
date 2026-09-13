import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordGuildId: process.env.DISCORD_GUILD_ID || undefined,
  openaiApiKey: required("OPENAI_API_KEY"),
  liveModel: process.env.LIVE_MODEL || "gpt-live-1",
  liveVoice: process.env.LIVE_VOICE || "marin",
  liveDelegationModel: process.env.LIVE_DELEGATION_MODEL || undefined,
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info",
  /** Debug: directory to dump raw session audio (WAV) into. Unset = off. */
  dumpAudioDir: process.env.DUMP_AUDIO_DIR || undefined,
};
