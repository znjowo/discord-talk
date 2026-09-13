/**
 * Low-latency playback of GPT-Live audio into a Discord voice connection.
 *
 * Design: @discordjs/voice's AudioPlayer pulls one Opus packet every 20 ms from an AudioResource.
 * We hand it an objectMode Readable with highWaterMark 0 so *nothing* is pre-buffered inside Node
 * streams — the only buffer is our own `queue`, which we can inspect (latency) and drop (barge-in).
 * When the queue is empty we feed Opus silence frames so the stream never "ends".
 *
 * Jitter: GPT-Live sends audio at real-time pace but in chunks (one delta may hold 100–300 ms), Discord
 * pulls 20 ms at a time, and the network in between is not smooth. With zero buffering every late chunk
 * turns into a hole in the speech (audibly choppy). So after an underrun we hold playback (silence)
 * until enough is queued, then drain steadily. "Enough" is derived from the observed chunk size: the
 * queue must survive one whole inter-chunk gap plus jitter, or it underruns at every chunk boundary.
 * Cost: that much extra latency after each underrun — nothing while primed.
 */
// CJS module whose exports are assigned dynamically (node-pre-gyp), so ESM can't see named exports.
import opus from "@discordjs/opus";
import {
  AudioPlayer,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import { DISCORD_CHANNELS, DISCORD_FRAME_BYTES, DISCORD_SAMPLE_RATE, FRAME_MS, FrameChunker, LIVE_SAMPLE_RATE, liveToDiscord } from "../audio/pcm.js";
import { log } from "../log.js";

const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
/** Floor / ceiling for how much audio to accumulate before (re)starting playback after an underrun. */
const PRIME_MIN_MS = 120;
const PRIME_MAX_MS = 800;
/** Jitter allowance on top of one chunk. Each underrun adds another step, so repeated ones self-correct. */
const JITTER_MS = 60;
const UNDERRUN_STEP_MS = 40;
/** Queue beyond this means we're falling behind real time; warn so the latency is visible. */
const BACKLOG_WARN_MS = 500;

export class LivePlayer {
  readonly player: AudioPlayer;
  private readonly encoder = new opus.OpusEncoder(DISCORD_SAMPLE_RATE, DISCORD_CHANNELS);
  private readonly chunker = new FrameChunker(DISCORD_FRAME_BYTES);
  private readonly queue: Buffer[] = [];
  private readonly stream: Readable;
  private primed = false;
  /** Times the queue ran dry while primed (i.e. audible gaps we had to paper over). */
  underruns = 0;
  private lastBacklogWarnAt = 0;
  /** EMA of incoming chunk size (ms of audio per write). */
  private avgChunkMs = 0;
  /** Extra margin learned from underruns. */
  private extraMs = 0;

  constructor() {
    this.stream = new Readable({
      objectMode: true,
      highWaterMark: 0,
      read: () => this.stream.push(this.nextFrame()),
    });
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Number.MAX_SAFE_INTEGER },
    });
    this.player.on("error", (err) => log.error("player error", err));
    this.player.on("stateChange", (from, to) => {
      if (to.status !== AudioPlayerStatus.Playing) log.debug("player state", from.status, "→", to.status);
    });
    this.player.play(createAudioResource(this.stream, { inputType: StreamType.Opus }));
  }

  /** How much must be queued before playback (re)starts. */
  get primeMs(): number {
    const want = this.avgChunkMs + JITTER_MS + this.extraMs;
    return Math.min(PRIME_MAX_MS, Math.max(PRIME_MIN_MS, Math.round(want)));
  }

  /** Called every 20 ms by the AudioPlayer. */
  private nextFrame(): Buffer {
    if (!this.primed) {
      if (this.queuedMs < this.primeMs) return OPUS_SILENCE;
      this.primed = true;
    }
    const frame = this.queue.shift();
    if (frame) return frame;
    this.primed = false;
    this.underruns++;
    this.extraMs = Math.min(PRIME_MAX_MS, this.extraMs + UNDERRUN_STEP_MS);
    log.debug(`player: underrun #${this.underruns}, re-priming to ${this.primeMs}ms (chunk≈${Math.round(this.avgChunkMs)}ms)`);
    return OPUS_SILENCE;
  }

  /** Enqueue s16le 24 kHz mono PCM from GPT-Live. */
  write(pcm24kMono: Buffer): void {
    const chunkMs = pcm24kMono.length / (LIVE_SAMPLE_RATE * 2) * 1000;
    this.avgChunkMs = this.avgChunkMs ? this.avgChunkMs * 0.8 + chunkMs * 0.2 : chunkMs;
    const frames = this.chunker.push(liveToDiscord(pcm24kMono));
    for (const f of frames) this.queue.push(this.encoder.encode(f));
    const now = Date.now();
    if (this.queuedMs > BACKLOG_WARN_MS && now - this.lastBacklogWarnAt > 5_000) {
      this.lastBacklogWarnAt = now;
      log.warn(`player: ${this.queuedMs}ms queued — playback is behind real time`);
    }
  }

  /** Milliseconds of audio waiting to be played. Stale-audio-after-barge-in is bounded by this. */
  get queuedMs(): number {
    return this.queue.length * FRAME_MS;
  }

  /** Drop everything not yet sent to Discord. Returns how much audio (ms) was discarded. */
  flush(): number {
    const dropped = this.queuedMs;
    this.queue.length = 0;
    this.chunker.reset();
    this.primed = false;
    return dropped;
  }

  destroy(): void {
    this.flush();
    this.player.stop(true);
    this.stream.destroy();
  }
}
