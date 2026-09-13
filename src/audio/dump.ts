/**
 * Debug: write raw s16le mono PCM to a WAV file as it streams, so the audio at a given point in the
 * pipeline can be listened to offline. Header is patched with the final length on close.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { log } from "../log.js";

export class WavDump {
  private fd: number | null;
  private bytes = 0;

  constructor(
    readonly path: string,
    private readonly sampleRate: number,
  ) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, this.header(0));
    log.info("dump: writing", path);
  }

  write(pcm: Buffer): void {
    if (this.fd === null) return;
    writeSync(this.fd, pcm);
    this.bytes += pcm.length;
  }

  close(): void {
    if (this.fd === null) return;
    writeSync(this.fd, this.header(this.bytes), 0, 44, 0);
    closeSync(this.fd);
    this.fd = null;
    log.info("dump: closed", this.path, `${Math.round(this.bytes / (this.sampleRate * 2) * 10) / 10}s`);
  }

  private header(dataBytes: number): Buffer {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + dataBytes, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // mono
    h.writeUInt32LE(this.sampleRate, 24);
    h.writeUInt32LE(this.sampleRate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(dataBytes, 40);
    return h;
  }
}
