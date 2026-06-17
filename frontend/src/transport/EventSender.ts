/**
 * Buffer engagement events and POST them in batches to /ingest.
 *
 * Batching keeps the request rate low (1 POST per few seconds) without losing
 * temporal resolution on the backend.
 */

import type { EngagementEvent, Mode } from "../engagement/types";

export interface EventSenderOptions {
  endpoint?: string;
  sessionId: string;
  lectureId: string;
  userId: string;
  mode: Mode;
  flushIntervalMs?: number;
}

export class EventSender {
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private buffer: EngagementEvent[] = [];
  private timer: number | null = null;
  private mode: Mode;

  constructor(private readonly opts: EventSenderOptions) {
    this.endpoint = opts.endpoint ?? "/ingest";
    this.flushIntervalMs = opts.flushIntervalMs ?? 3000;
    this.mode = opts.mode;
  }

  start(): void {
    this.timer = window.setInterval(this.flush, this.flushIntervalMs);
    // Flush remaining events when the page unloads.
    window.addEventListener("beforeunload", this.flushSync);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("beforeunload", this.flushSync);
    void this.flush();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  enqueue(ev: EngagementEvent): void {
    this.buffer.push(ev);
  }

  private flush = async (): Promise<void> => {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const body = JSON.stringify({
      session_id: this.opts.sessionId,
      lecture_id: this.opts.lectureId,
      user_id: this.opts.userId,
      mode: this.mode,
      events,
    });
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
    } catch (err) {
      // Network blip — put events back at the front so the next flush retries.
      this.buffer = events.concat(this.buffer);
      console.warn("[EventSender] flush failed, will retry", err);
    }
  };

  /**
   * Best-effort synchronous flush for `beforeunload`. Uses `sendBeacon` so
   * the browser ships the payload even after the page is gone.
   */
  private flushSync = (): void => {
    if (this.buffer.length === 0) return;
    const body = JSON.stringify({
      session_id: this.opts.sessionId,
      lecture_id: this.opts.lectureId,
      user_id: this.opts.userId,
      mode: this.mode,
      events: this.buffer,
    });
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(this.endpoint, blob);
    this.buffer = [];
  };
}
