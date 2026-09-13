/**
 * One Discord call == one continuous GPT-Live session.
 *
 *   Discord VC ──(opus)──▶ LiveReceiver ──(pcm 24k)──▶ LiveClient ──▶ OpenAI Live API
 *   Discord VC ◀─(opus)── LivePlayer   ◀─(pcm 24k)── LiveClient ◀──
 *
 * Also owns the two latency metrics this project optimizes for:
 *   response_latency : user stops speaking  → first AI audio queued for playback
 *   interrupt_stop   : user starts speaking → AI audio stream actually stops
 */
import {
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { WavDump } from "../audio/dump.js";
import { isSilence } from "../audio/pcm.js";
import { config } from "../config.js";
import { LiveClient } from "../live/client.js";
import { log } from "../log.js";
import { LivePlayer } from "./player.js";
import { LiveReceiver } from "./receiver.js";

const INSTRUCTIONS = `あなたはDiscordのボイスチャットで、ユーザーと1対1で通話しているAIです。
音声での会話なので、テキストチャットよりずっと短く話してください。
- 返事は1〜2文。必要なら相手の反応を待ってから続きを話す
- 聞かれていない説明や前置きを始めない
- 相槌は短く自然に(「うん」「なるほど」など)
- 会話を独占せず、相手が話し始めたらすぐ譲る
- ユーザーの言語(基本は日本語)に合わせて話す
「文章として完璧な回答」より「話していて自然な返し」を優先してください。`;

/** Discord's speaking "end" fires ~100 ms after the last packet; subtract so the metric reflects real speech end. */
const SPEAKING_END_DELAY_MS = 100;
/**
 * GPT-Live streams output audio continuously at real-time pace, silence included (verified by Pipecat's
 * integration). So "is the AI talking" cannot be read from delta arrival — it has to come from the
 * samples. No audible output for this long ⇒ the model has stopped (Pipecat uses the same 350 ms).
 */
const VOICE_STOP_MS = 350;

export interface SessionStats {
  uptimeMs: number;
  queuedMs: number;
  underruns: number;
  lastResponseLatencyMs?: number;
  lastInterruptStopMs?: number;
}

export class VoiceSession {
  private connection: VoiceConnection | null = null;
  private live: LiveClient | null = null;
  private player: LivePlayer | null = null;
  private receiver: LiveReceiver | null = null;
  private destroyed = false;
  private dumpOut: WavDump | null = null;
  private dumpIn: WavDump | null = null;
  // arrival stats for output deltas (debug): bytes per delta and gaps between them
  private deltaCount = 0;
  private deltaBytes = 0;
  private lastDeltaAt = 0;
  private maxDeltaGapMs = 0;

  // metrics state
  private userSpeechEndedAt = 0;
  /** Last time an output delta contained audible signal (not the last delta — those never stop). */
  private lastVoiceAt = 0;
  private bargeInAt = 0;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private userTranscript = "";
  private aiTranscript = "";
  private readonly startedAt = Date.now();
  private lastResponseLatencyMs?: number;
  private lastInterruptStopMs?: number;

  constructor(
    readonly channel: VoiceBasedChannel,
    readonly userId: string,
    private readonly onEnd: () => void,
  ) {}

  async start(): Promise<void> {
    // 1. Live session first, so the model is ready the moment audio starts flowing.
    this.live = new LiveClient(config.openaiApiKey, {
      model: config.liveModel,
      voice: config.liveVoice,
      instructions: INSTRUCTIONS,
      delegationModel: config.liveDelegationModel,
    });
    this.live.on("audio", (d) => this.handleOutputAudio(d.pcm));
    this.live.on("inputTranscript", (t) => this.handleTranscript("user", t.delta));
    this.live.on("outputTranscript", (t) => this.handleTranscript("ai", t.delta));
    this.live.on("delegation", (id, target) => {
      // MVP has no client-side capabilities; tell the model so it doesn't stall waiting for us.
      if (target === "client") this.live?.appendThinking("現在この機能は使えません。その旨を短く伝えてください。", id);
    });
    this.live.on("closed", (reason) => {
      log.warn("session: live closed", reason);
      this.destroy();
    });
    this.live.on("error", (err) => log.error("session: live error", err.message));
    const sessionId = await this.live.connect();

    if (config.dumpAudioDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.dumpOut = new WavDump(`${config.dumpAudioDir}/${stamp}-${sessionId}-out.wav`, 24_000);
      this.dumpIn = new WavDump(`${config.dumpAudioDir}/${stamp}-${sessionId}-in.wav`, 24_000);
    }

    // 2. Join the voice channel.
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection.on("stateChange", (from, to) => log.debug("voice connection", from.status, "→", to.status));
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Reconnect race (channel move) vs. real disconnect.
        await Promise.race([
          entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        log.info("session: voice disconnected");
        this.destroy();
      }
    });
    this.connection.on("error", (err) => log.error("voice connection error", err));
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    // 3. Wire audio both ways.
    this.player = new LivePlayer();
    this.connection.subscribe(this.player.player);

    this.receiver = new LiveReceiver(
      this.connection.receiver,
      this.userId,
      (pcm) => {
        this.dumpIn?.write(pcm);
        this.live?.appendAudio(pcm);
      },
      (speaking, at) => this.handleUserSpeaking(speaking, at),
    );
    this.receiver.start();
    log.info("session: ready", { channel: this.channel.name, user: this.userId });
  }

  private get aiSpeaking(): boolean {
    return Date.now() - this.lastVoiceAt < VOICE_STOP_MS;
  }

  private handleOutputAudio(pcm: Buffer): void {
    if (!this.player) return;
    this.dumpOut?.write(pcm);
    this.trackDeltaArrival(pcm.length);
    this.player.write(pcm);
    if (isSilence(pcm)) return; // model silence: keep playing it, but it is not "speaking"

    const now = Date.now();
    const wasIdle = now - this.lastVoiceAt > VOICE_STOP_MS;
    this.lastVoiceAt = now;

    if (wasIdle && this.userSpeechEndedAt && now - this.userSpeechEndedAt < 10_000) {
      this.lastResponseLatencyMs = now - this.userSpeechEndedAt - SPEAKING_END_DELAY_MS;
      log.metric("response_latency", this.lastResponseLatencyMs, `queued=${this.player.queuedMs}ms`);
      this.userSpeechEndedAt = 0;
    }
    if (this.bargeInAt) this.armBargeInStopCheck();
  }

  private handleUserSpeaking(speaking: boolean, at: number): void {
    if (!this.player) return;
    if (speaking) {
      if (this.aiSpeaking) {
        this.bargeInAt = at;
        // Local flush is a safety net only: the model stops itself, and with real-time streaming the
        // queue holds ~1 frame, so this rarely drops anything meaningful (the log says how much).
        const dropped = this.player.flush();
        log.info(`barge-in: user started speaking while AI active (dropped ${dropped}ms queued audio)`);
        this.armBargeInStopCheck();
      }
      this.flushTranscript("ai");
    } else {
      this.userSpeechEndedAt = at;
      this.flushTranscript("user");
    }
  }

  /**
   * After a barge-in, wait for audible output to stop and report how long the model kept talking.
   * Re-armed by every audible delta (silence deltas don't count), so it fires VOICE_STOP_MS after the
   * last real speech.
   */
  private armBargeInStopCheck(): void {
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = setTimeout(() => {
      if (!this.bargeInAt) return;
      const stoppedAt = Math.max(this.lastVoiceAt, this.bargeInAt);
      this.lastInterruptStopMs = stoppedAt - this.bargeInAt;
      log.metric("interrupt_stop", this.lastInterruptStopMs);
      this.bargeInAt = 0;
    }, VOICE_STOP_MS);
  }

  /** Every 100 deltas, log how the output stream is arriving (size, worst gap). Debug level. */
  private trackDeltaArrival(bytes: number): void {
    const now = Date.now();
    if (this.lastDeltaAt) this.maxDeltaGapMs = Math.max(this.maxDeltaGapMs, now - this.lastDeltaAt);
    this.lastDeltaAt = now;
    this.deltaCount++;
    this.deltaBytes += bytes;
    if (this.deltaCount % 100 === 0) {
      const avgMs = this.deltaBytes / 100 / (24_000 * 2) * 1000;
      log.debug(
        `output stream: avg ${Math.round(avgMs)}ms/delta, worst gap ${this.maxDeltaGapMs}ms, ` +
          `queued ${this.player?.queuedMs ?? 0}ms, underruns ${this.player?.underruns ?? 0}`,
      );
      this.deltaBytes = 0;
      this.maxDeltaGapMs = 0;
    }
  }

  private handleTranscript(who: "user" | "ai", delta: string): void {
    if (who === "user") this.userTranscript += delta;
    else this.aiTranscript += delta;
  }

  private flushTranscript(who: "user" | "ai"): void {
    const text = who === "user" ? this.userTranscript : this.aiTranscript;
    if (!text.trim()) return;
    log.info(who === "user" ? "👤" : "🤖", text.trim());
    if (who === "user") this.userTranscript = "";
    else this.aiTranscript = "";
  }

  stats(): SessionStats {
    return {
      uptimeMs: Date.now() - this.startedAt,
      queuedMs: this.player?.queuedMs ?? 0,
      underruns: this.player?.underruns ?? 0,
      lastResponseLatencyMs: this.lastResponseLatencyMs,
      lastInterruptStopMs: this.lastInterruptStopMs,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.flushTranscript("user");
    this.flushTranscript("ai");
    this.receiver?.stop();
    this.player?.destroy();
    this.dumpOut?.close();
    this.dumpIn?.close();
    this.live?.close();
    this.connection?.destroy();
    log.info("session: destroyed");
    this.onEnd();
  }
}
