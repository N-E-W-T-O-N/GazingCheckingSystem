/**
 * Streams the lecture video from the backend into a <video> via Media Source
 * Extensions, over the gated WebSocket in app/stream.py.
 *
 * Flow (spec §6):
 *   1. GET /stream/{id}/info → { renditions:[{id,label,mimeCodec,size}], default }.
 *   2. Pick a rendition (preferred/auto → default → first), attach a MediaSource,
 *      add a SourceBuffer(mimeCodec).
 *   3. Open the WS (?q=<rendition>). Binary frames enter an append queue (one
 *      appendBuffer in flight); `pull` credits keep ~TARGET seconds buffered.
 *   4. `pause()`/`resume()` (from the engagement gate) send the control frame AND
 *      pause/play the element, so the server withholds bytes and the frame freezes.
 *
 * `switchQuality()` restarts the stream at a new rendition (the pump is linear —
 * there is no seek, so a switch replays from the start).
 */

export interface Rendition {
  id: string;
  label: string;
  mimeCodec: string;
  size?: number;
}

export interface VideoStreamClientOptions {
  video: HTMLVideoElement;
  infoUrl: string;
  /** Builds the WS URL for a given rendition id. */
  wsUrl: (quality: string) => string;
  /** Rendition to prefer if available (e.g. auto-picked by screen size). */
  preferredQuality?: string;
  /** How many seconds to keep buffered ahead of playback. */
  targetBufferSeconds?: number;
  onError?: (message: string) => void;
  /** Fires once renditions are known, so the UI can offer a quality picker. */
  onRenditions?: (renditions: Rendition[], currentId: string) => void;
}

const CREDIT_BURST = 8;
const MAX_OUTSTANDING = 8;

export class VideoStreamClient {
  private readonly video: HTMLVideoElement;
  private readonly target: number;

  private renditions: Rendition[] = [];
  private quality = "";
  private mimeCodec = "";

  // Per-connection state (reset on each open / quality switch).
  private ws: WebSocket | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private queue: ArrayBuffer[] = [];
  private outstanding = 0;
  private eof = false;
  private pendingPlay = false;

  private failed = false;

  constructor(private readonly opts: VideoStreamClientOptions) {
    this.video = opts.video;
    this.target = opts.targetBufferSeconds ?? 15;
    // Keep the buffer topped up as playback drains it.
    this.video.addEventListener("timeupdate", () => this.pump());
  }

  async start(): Promise<void> {
    let info: { renditions?: Rendition[]; default?: string };
    try {
      const res = await fetch(this.opts.infoUrl);
      if (!res.ok) throw new Error(`info ${res.status}`);
      info = await res.json();
    } catch {
      this.fail("Could not reach the lecture stream.");
      return;
    }

    this.renditions = info.renditions ?? [];
    if (!this.renditions.length) {
      this.fail("No lecture video is available yet.");
      return;
    }

    const has = (id?: string) => !!id && this.renditions.some(r => r.id === id);
    const quality = has(this.opts.preferredQuality)
      ? this.opts.preferredQuality!
      : has(info.default)
        ? info.default!
        : this.renditions[0]!.id;

    this.opts.onRenditions?.(this.renditions, quality);
    this.open(quality);
  }

  /** Switch rendition. Restarts playback from the start (the stream has no seek). */
  switchQuality(quality: string): void {
    if (this.failed || quality === this.quality) return;
    if (!this.renditions.some(r => r.id === quality)) return;
    this.pendingPlay = !this.video.paused;
    this.teardown();
    this.open(quality);
  }

  /** Engagement gate closed: withhold bytes and freeze the frame. */
  pause(): void {
    this.video.pause();
    this.send({ type: "pause" });
  }

  /** Engagement gate open: allow bytes and resume playback. */
  resume(): void {
    this.send({ type: "resume" });
    void this.video.play().catch(() => {});
    this.pump();
  }

  private open(quality: string): void {
    const r = this.renditions.find(x => x.id === quality) ?? this.renditions[0];
    if (!r) {
      this.fail("No lecture video is available yet.");
      return;
    }
    this.quality = r.id;
    this.mimeCodec = r.mimeCodec;

    if (!("MediaSource" in window) || !MediaSource.isTypeSupported(this.mimeCodec)) {
      this.fail("This browser can't play the lecture video format.");
      return;
    }

    this.eof = false;
    this.outstanding = 0;
    this.queue = [];

    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
    ms.addEventListener("sourceopen", () => this.onSourceOpen(), { once: true });
  }

  private teardown(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.queue = [];
    this.outstanding = 0;
    this.eof = false;
    this.video.removeAttribute("src");
    this.video.load();
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
    const ws = new WebSocket(this.opts.wsUrl(this.quality));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => this.pump());
    ws.addEventListener("message", ev => this.onMessage(ev));
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

  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.failed) return;

    const chunk = this.queue.shift();
    if (chunk) {
      try {
        sb.appendBuffer(chunk);
      } catch (e) {
        if ((e as DOMException)?.name === "QuotaExceededError") {
          this.queue.unshift(chunk); // buffer full — retry after playback frees it
        } else {
          this.fail("Playback buffer error.");
        }
        return;
      }
      if (this.pendingPlay) {
        this.pendingPlay = false;
        void this.video.play().catch(() => {});
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
    if (this.send({ type: "pull", n })) {
      this.outstanding = Math.min(MAX_OUTSTANDING, this.outstanding + n);
    }
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
