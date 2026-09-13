/**
 * PCM conversions between Discord's voice format and GPT-Live's.
 *
 * Discord (via prism opus decoder / encoder): s16le, 48 000 Hz, stereo, 20 ms frames = 3840 bytes
 * GPT-Live (Live API, WebSocket):             s16le, 24 000 Hz, mono,   20 ms       =  960 bytes
 *
 * Both directions use simple integer-ratio (2:1) conversion: cheap and zero-latency, which
 * matters more here than audiophile quality (see spec: "音声品質 < 会話テンポ").
 */

export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const LIVE_SAMPLE_RATE = 24_000;
export const FRAME_MS = 20;

export const DISCORD_FRAME_BYTES = (DISCORD_SAMPLE_RATE / 1000) * FRAME_MS * DISCORD_CHANNELS * 2; // 3840
export const LIVE_FRAME_BYTES = (LIVE_SAMPLE_RATE / 1000) * FRAME_MS * 2; // 960

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** 48 kHz stereo s16le → 24 kHz mono s16le. Averages L/R, then 2-tap box filter + decimate by 2. */
export function discordToLive(input: Buffer): Buffer {
  const inSamples = input.length >> 2; // stereo frames
  const outSamples = inSamples >> 1;
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = i * 8; // byte offset of stereo frame 2i
    const l0 = input.readInt16LE(a);
    const r0 = input.readInt16LE(a + 2);
    const l1 = input.readInt16LE(a + 4);
    const r1 = input.readInt16LE(a + 6);
    out.writeInt16LE(clamp16(Math.round((l0 + r0 + l1 + r1) / 4)), i * 2);
  }
  return out;
}

/** 24 kHz mono s16le → 48 kHz stereo s16le. Linear interpolation, duplicated to both channels. */
export function liveToDiscord(input: Buffer): Buffer {
  const inSamples = input.length >> 1;
  const out = Buffer.allocUnsafe(inSamples * 2 * 4);
  for (let i = 0; i < inSamples; i++) {
    const s0 = input.readInt16LE(i * 2);
    const s1 = i + 1 < inSamples ? input.readInt16LE(i * 2 + 2) : s0;
    const mid = clamp16((s0 + s1) >> 1);
    const o = i * 8;
    out.writeInt16LE(s0, o);
    out.writeInt16LE(s0, o + 2);
    out.writeInt16LE(mid, o + 4);
    out.writeInt16LE(mid, o + 6);
  }
  return out;
}

/**
 * Peak amplitude at or below this (int16) counts as silence. GPT-Live output is clean synthesis, not a
 * mic, so a tiny threshold is enough (same value Pipecat's OpenAILiveLLMService uses).
 */
const SILENCE_PEAK = 20;

/** True if an s16le buffer contains no audible signal. Odd trailing byte is ignored. */
export function isSilence(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i);
    if (v > SILENCE_PEAK || v < -SILENCE_PEAK) return false;
  }
  return true;
}

/** Re-chunks an arbitrary byte stream into fixed-size frames, carrying the remainder over. */
export class FrameChunker {
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly frameBytes: number) {}

  push(data: Buffer): Buffer[] {
    const buf = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const frames: Buffer[] = [];
    let off = 0;
    while (off + this.frameBytes <= buf.length) {
      frames.push(buf.subarray(off, off + this.frameBytes));
      off += this.frameBytes;
    }
    this.pending = buf.subarray(off);
    return frames;
  }

  /** Discard buffered remainder (used on interruption). */
  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}
