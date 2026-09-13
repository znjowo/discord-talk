/**
 * Minimal client for the OpenAI Live API (GPT-Live, full-duplex voice) over WebSocket.
 *
 * Protocol summary (see docs: developers.openai.com/api/docs/guides/live):
 *   client → server : session.start | session.input_audio.append {audio: base64 pcm16 24k mono}
 *                     | session.{instructions,thinking,commentary}.append | session.close
 *   server → client : session.started | session.output_audio.delta {delta} (continuous, silence included)
 *                     | session.{input,output}_transcript.delta {delta,start_ms,end_ms}
 *                     | session.delegation.created | response.event | session.usage.updated
 *                     | session.closed | error
 *
 * GPT-Live is full-duplex: it listens while speaking and stops on its own when the user talks.
 * There is no turn-detection config and no "response.cancel" — barge-in is the model's job; our job
 * is only to keep the local playback buffer tiny so stale audio can't linger (see voice/player.ts).
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../log.js";

// NB: "/v1/live" (no "/sessions") is a different, gated alpha endpoint that demands OpenAI-Alpha: quicksilver=v2
// and rejects session.start. The GA Live API lives at "/v1/live/sessions" with a plain bearer key.
const LIVE_WS_URL = "wss://api.openai.com/v1/live/sessions";
/** The server drains delegation/output work for up to 10 s after session.close before session.closed. */
const CLOSE_GRACE_MS = 10_000;

export interface LiveSessionConfig {
  model: string;
  voice: string;
  instructions: string;
  /** Responses model for server-side delegation. undefined → client delegation (no backend). */
  delegationModel?: string;
}

export interface OutputAudioDelta {
  pcm: Buffer; // s16le 24k mono
  /** Not sent by the API today (only transcript deltas carry timing); kept in case that changes. */
  startMs?: number;
  endMs?: number;
}

export interface TranscriptDelta {
  delta: string;
  startMs: number;
  endMs: number;
}

export interface LiveClientEvents {
  started: [sessionId: string];
  audio: [delta: OutputAudioDelta];
  inputTranscript: [delta: TranscriptDelta];
  outputTranscript: [delta: TranscriptDelta];
  delegation: [delegationId: string, target: string];
  closed: [reason: string];
  error: [err: Error];
}

export class LiveClient extends EventEmitter<LiveClientEvents> {
  private ws: WebSocket | null = null;
  private seq = 0;
  private closing = false;
  private loggedUnknownTypes = new Set<string>();

  constructor(
    private readonly apiKey: string,
    private readonly cfg: LiveSessionConfig,
  ) {
    super();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(LIVE_WS_URL, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.ws = ws;

      const onStarted = (id: string) => {
        this.off("error", onError);
        resolve(id);
      };
      const onError = (err: Error) => {
        this.off("started", onStarted);
        reject(err);
      };
      this.once("started", onStarted);
      this.once("error", onError);

      ws.on("open", () => {
        log.info("live: websocket open, starting session", { model: this.cfg.model });
        this.send({
          type: "session.start",
          session: {
            model: this.cfg.model,
            instructions: this.cfg.instructions,
            audio: { output: { voice: this.cfg.voice } },
            delegation: this.cfg.delegationModel
              ? { type: "responses", responses: { model: this.cfg.delegationModel } }
              : { type: "client" },
          },
        });
      });
      ws.on("message", (raw) => this.handleMessage(raw.toString()));
      ws.on("error", (err) => {
        log.error("live: websocket error", err);
        this.emit("error", err);
      });
      ws.on("close", (code, reason) => {
        log.info("live: websocket closed", code, reason.toString());
        if (!this.closing) this.emit("closed", `transport closed (${code})`);
      });
    });
  }

  /** Send one chunk of s16le 24 kHz mono PCM. Even byte length required. */
  appendAudio(pcm: Buffer): void {
    if (!this.isOpen) return;
    this.send({ type: "session.input_audio.append", audio: pcm.toString("base64") }, /* trace */ false);
  }

  /** Quiet context the model may use later (e.g. delegation results, app state). */
  appendThinking(content: string, delegationId: string | null = null): void {
    this.send({ type: "session.thinking.append", delegation_id: delegationId, content });
  }

  /** Content the model should say aloud (it may paraphrase). */
  appendCommentary(content: string, delegationId: string | null = null): void {
    this.send({ type: "session.commentary.append", delegation_id: delegationId, content });
  }

  close(): void {
    if (!this.ws) return;
    this.closing = true;
    if (this.isOpen) {
      this.send({ type: "session.close" });
      // Wait for session.closed (final usage); handleMessage tears the transport down when it arrives.
      setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
          log.warn("live: timed out waiting for session.closed, terminating");
          this.ws.terminate();
        }
      }, CLOSE_GRACE_MS).unref();
    } else {
      this.ws.terminate();
    }
  }

  private send(event: Record<string, unknown>, trace = true): void {
    if (!this.isOpen) return;
    const payload = { event_id: `evt_${++this.seq}`, ...event };
    if (trace) log.debug("live →", event.type);
    this.ws!.send(JSON.stringify(payload));
  }

  private handleMessage(text: string): void {
    let ev: any;
    try {
      ev = JSON.parse(text);
    } catch {
      log.warn("live: non-JSON message", text.slice(0, 200));
      return;
    }
    switch (ev.type) {
      case "session.started": {
        const id = ev.session?.id ?? ev.session_id ?? "unknown";
        log.info("live: session started", id);
        this.emit("started", id);
        break;
      }
      case "session.output_audio.delta": {
        // Field is `delta` (verified); `audio` kept as a fallback. Streams continuously, silence included.
        const b64 = ev.delta ?? ev.audio;
        if (typeof b64 !== "string") {
          this.logUnknown("output_audio.delta(shape)", ev);
          break;
        }
        this.emit("audio", { pcm: Buffer.from(b64, "base64"), startMs: ev.start_ms, endMs: ev.end_ms });
        break;
      }
      case "session.input_transcript.delta":
        this.emit("inputTranscript", { delta: ev.delta, startMs: ev.start_ms, endMs: ev.end_ms });
        break;
      case "session.output_transcript.delta":
        this.emit("outputTranscript", { delta: ev.delta, startMs: ev.start_ms, endMs: ev.end_ms });
        break;
      case "session.delegation.created":
        log.info("live: delegation created", ev.delegation);
        this.emit("delegation", ev.delegation?.id, ev.delegation?.target);
        break;
      case "response.event":
        // Responses-delegation lifecycle. Not needed for MVP (no tools), but keep it visible.
        log.debug("live: response.event", ev.event?.type);
        break;
      case "session.usage.updated":
        log.debug("live: usage", ev.usage);
        break;
      case "session.updated":
      case "session.instructions.appended":
      case "session.thinking.appended":
      case "session.commentary.appended":
      case "session.input_audio.muted":
      case "session.input_audio.unmuted":
        log.debug("live ←", ev.type);
        break;
      case "session.closed":
        log.info("live: session closed", ev.reason, ev.usage);
        this.closing = true;
        this.emit("closed", ev.reason ?? "closed");
        // Server closes the transport shortly after this anyway; don't wait for it.
        this.ws?.terminate();
        break;
      case "error": {
        const msg = ev.error?.message ?? JSON.stringify(ev);
        log.error("live: server error", msg);
        this.emit("error", new Error(msg));
        break;
      }
      default:
        this.logUnknown(ev.type, ev);
    }
  }

  private logUnknown(type: string, ev: unknown): void {
    if (this.loggedUnknownTypes.has(type)) return;
    this.loggedUnknownTypes.add(type);
    log.warn("live: unhandled event", type, JSON.stringify(ev).slice(0, 400));
  }
}
