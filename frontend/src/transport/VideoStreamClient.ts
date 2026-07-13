/**
 * Streams the lecture video from the backend into a <video> via Media Source
 * Extensions, over the gated WebSocket in app/stream.py.
 *
 * Flow (spec §6):
 *   1. GET /stream/{id}/info → { mimeCodec, size }; bail if unsupported.
 *   2. Attach a MediaSource, add a SourceBuffer(mimeCodec).
 *   3. Open the WS. Binary frames enter an append queue (one appendBuffer in
 *      flight at a time). We grant `pull` credits to keep ~TARGET seconds
 *      buffered ahead — that is the backpressure.
 *   4. `pause()`/`resume()` (called by the engagement gate) send the control
 *      frame AND pause/play the element, so the server withholds bytes and the
 *      element freezes on its last frame (no spinner).
 */

export interface VideoStreamClientOptions {
  video: HTMLVideoElement;
  infoUrl: string;
  wsUrl: string;
  /** How many seconds to keep buffered ahead of playback. */
  targetBufferSeconds?: number;
  /** Fatal-error callback (unsupported codec, socket failure, …). */
  onError?: (message: string) => void;
}

const CREDIT_BURST = 8;
const MAX_OUTSTANDING = 8;

export class VideoStreamClient {
  private readonly video: HTMLVideoElement;
  private readonly target: number;

  private ws: WebSocket | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private mimeCodec = "";
  private readonly queue: ArrayBuffer[] = [];
  private outstanding = 0;
  private eof = false;
  private failed = false;

  constructor(private readonly opts: VideoStreamClientOptions) {
    this.video = opts.video;
    this.target = opts.targetBufferSeconds ?? 15;
  }

  async start(): Promise<void> {
    let info: { mimeCodec?: string };
    try {
      const res = await fetch(this.opts.infoUrl);
      if (!res.ok) throw new Error(`info ${res.status}`);
      info = await res.json();
    } catch {
      this.fail("Could not reach the lecture stream.");
      return;
    }

    const mimeCodec = info.mimeCodec ?? "";
    if (!("MediaSource" in window) || !MediaSource.isTypeSupported(mimeCodec)) {
      this.fail("This browser can't play the lecture video format.");
      return;
    }
    this.mimeCodec = mimeCodec;

    const ms = new MediaSource();
    this.mediaSource = ms;
    this.video.src = URL.createObjectURL(ms);
    ms.addEventListener("sourceopen", () => this.onSourceOpen(), { once: true });
    // Keep the buffer topped up as playback drains it.
    this.video.addEventListener("timeupdate", () => this.pump());
  }

  /** Engagement gate closed: withhold bytes and freeze the frame. */
  pause(): void {
    this.video.pause();
    this.send({ type: "pause" });
  }

  /** Engagement gate open: allow bytes and resume playback. */
  resume(): void {
    this.send({ type: "resume" });
    void this.video.play().catch(() => {
      /* autoplay policy may block until a user gesture; harmless */
    });
    this.pump();
  }

  private onSourceOpen(): void {
    const ms = this.mediaSource;
    if (!ms) return;
    try {
      const sb = ms.addSourceBuffer(this.mimeCodec);
      this.sourceBuffer = sb;
      sb.addEventListener("updateend", () => this.pump());
    } catch {
      this.fail("Could not initialise the video buffer.");
      return;
    }
    this.openSocket();
  }

  private openSocket(): void {
    const ws = new WebSocket(this.opts.wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => this.pump());
    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("error", () => this.fail("Lecture stream connection error."));
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "eof") {
          this.eof = true;
          this.pump();
        } else if (msg.type === "error") {
          this.fail(msg.message || "Lecture stream error.");
        }
      } catch {
        /* ignore malformed control frames */
      }
      return;
    }
    // Binary media chunk.
    this.outstanding = Math.max(0, this.outstanding - 1);
    this.queue.push(ev.data as ArrayBuffer);
    this.pump();
  }

  /** Append a queued chunk, or (when drained) ask for more / finish. */
  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.failed) return;

    const chunk = this.queue.shift();
    if (chunk) {
      try {
        sb.appendBuffer(chunk);
      } catch (e) {
        if ((e as DOMException)?.name === "QuotaExceededError") {
          // Buffer full — put it back and retry on the next updateend/timeupdate.
          this.queue.unshift(chunk);
        } else {
          this.fail("Playback buffer error.");
        }
      }
      return;
    }

    if (this.eof) {
      this.endStream();
      return;
    }
    this.maybeCredit();
  }

  private maybeCredit(): void {
    if (this.eof || this.outstanding > 0) return;
    if (this.bufferedAhead() < this.target) this.credit(CREDIT_BURST);
  }

  private credit(n: number): void {
    if (this.send({ type: "pull", n })) this.outstanding = Math.min(MAX_OUTSTANDING, this.outstanding + n);
  }

  private bufferedAhead(): number {
    const b = this.video.buffered;
    if (!b.length) return 0;
    return b.end(b.length - 1) - this.video.currentTime;
  }

  private endStream(): void {
    const ms = this.mediaSource;
    const sb = this.sourceBuffer;
    if (ms && sb && !sb.updating && this.queue.length === 0 && ms.readyState === "open") {
      try {
        ms.endOfStream();
      } catch {
        /* already ended */
      }
    }
  }

  private send(msg: object): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.opts.onError?.(message);
  }
}
