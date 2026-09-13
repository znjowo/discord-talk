/**
 * Streams one Discord user's microphone to GPT-Live as it arrives (no end-of-utterance buffering).
 *
 * Discord only sends packets while the user speaks. GPT-Live's timeline is continuous, so between
 * packets we inject 20 ms silence frames — this keeps the model's sense of time/pauses intact and
 * lets it detect end-of-speech from actual silence rather than from a dropped stream.
 *
 * The filler is deficit-based, not gap-based: real frames go out the moment they arrive, and silence is
 * only added once the audio we've sent falls FILL_TOLERANCE_MS behind wall-clock time. A gap-based
 * filler ("no packet in the last 20 ms ⇒ silence") turns ordinary packet jitter into silence spliced
 * into the middle of words, which is what the model then hears.
 */
import { EndBehaviorType, VoiceReceiver } from "@discordjs/voice";
import prism from "prism-media";
import type { Readable } from "node:stream";
import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE, FRAME_MS, LIVE_FRAME_BYTES, discordToLive } from "../audio/pcm.js";
import { log } from "../log.js";

const LIVE_SILENCE = Buffer.alloc(LIVE_FRAME_BYTES);
/** How far behind wall-clock the sent audio may fall before silence is inserted. Absorbs packet jitter. */
const FILL_TOLERANCE_MS = 60;

export class LiveReceiver {
  private opusStream: Readable | null = null;
  private decoder: prism.opus.Decoder | null = null;
  private fillTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  /** Milliseconds of audio (real + silence) handed to onAudio since start. */
  private sentMs = 0;
  private speaking = false;
  private speakingStartedAt = 0;

  constructor(
    private readonly receiver: VoiceReceiver,
    private readonly userId: string,
    private readonly onAudio: (pcm24kMono: Buffer) => void,
    private readonly onSpeaking: (speaking: boolean, at: number) => void,
  ) {}

  start(): void {
    this.opusStream = this.receiver.subscribe(this.userId, { end: { behavior: EndBehaviorType.Manual } });
    this.decoder = new prism.opus.Decoder({ rate: DISCORD_SAMPLE_RATE, channels: DISCORD_CHANNELS, frameSize: 960 });
    this.decoder.on("data", (pcm48kStereo: Buffer) => {
      this.sentMs += FRAME_MS;
      this.onAudio(discordToLive(pcm48kStereo));
    });
    this.decoder.on("error", (err) => log.warn("opus decode error", err.message));
    this.opusStream.pipe(this.decoder);

    this.receiver.speaking.on("start", this.handleSpeakingStart);
    this.receiver.speaking.on("end", this.handleSpeakingEnd);

    // Silence filler: only once we've fallen behind real time by more than the jitter tolerance.
    this.startedAt = Date.now();
    this.fillTimer = setInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      while (this.sentMs < elapsed - FILL_TOLERANCE_MS) {
        this.sentMs += FRAME_MS;
        this.onAudio(LIVE_SILENCE);
      }
    }, FRAME_MS);
    log.info("receiver: subscribed to user", this.userId);
  }

  private handleSpeakingStart = (userId: string) => {
    if (userId !== this.userId || this.speaking) return;
    this.speaking = true;
    this.speakingStartedAt = Date.now();
    this.onSpeaking(true, this.speakingStartedAt);
  };

  private handleSpeakingEnd = (userId: string) => {
    if (userId !== this.userId || !this.speaking) return;
    this.speaking = false;
    this.onSpeaking(false, Date.now());
  };

  stop(): void {
    if (this.fillTimer) clearInterval(this.fillTimer);
    this.receiver.speaking.off("start", this.handleSpeakingStart);
    this.receiver.speaking.off("end", this.handleSpeakingEnd);
    this.opusStream?.destroy();
    this.decoder?.destroy();
    this.opusStream = null;
    this.decoder = null;
  }
}
