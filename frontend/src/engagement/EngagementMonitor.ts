/**
 * Orchestrator: pulls frames, runs detection + behavioral snapshot, fuses
 * into a smoothed score, and emits one EngagementEvent per second.
 *
 * Decoupled from UI and from network transport — callers wire those up via
 * the `onEvent` callback.
 */

import { BehavioralSignals } from "./BehavioralSignals";
import { FaceProcessor } from "./FaceProcessor";
import { eulerFromMatrix, headAlignedScore } from "./HeadPose";
import { gazeOnScreenScore } from "./GazeHeuristic";
import { ScoreFusion } from "./ScoreFusion";
import type { EngagementEvent, FeatureVector, Mode } from "./types";

export interface MonitorOptions {
  mode: Mode;
  emitIntervalMs?: number;
  onEvent: (ev: EngagementEvent) => void;
  /** Optional debug stream — fires once per detection (~30 Hz). */
  onDebug?: (f: FeatureVector, mode: Mode, score: number) => void;
}

export class EngagementMonitor {
  private readonly behavioral = new BehavioralSignals();
  private readonly fusion = new ScoreFusion();
  private face: FaceProcessor | null = null;
  private rafId: number | null = null;
  private emitTimer: number | null = null;
  private latestFeatures: FeatureVector = {
    face_present: 0,
    head_aligned: 0,
    gaze_on_screen: 0,
    tab_visible: 0,
    window_focused: 0,
    input_activity: 0,
  };
  private latestScore = 0.5;
  private mode: Mode;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  constructor(private readonly opts: MonitorOptions) {
    this.mode = opts.mode;
  }

  async start(): Promise<void> {
    if (this.mode === "camera") {
      // Acquire camera stream and the FaceLandmarker model in parallel.
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, frameRate: 30 },
          audio: false,
        }),
        (async () => {
          this.face = new FaceProcessor();
          await this.face.init();
        })(),
      ]);
      this.stream = stream;
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      this.video = video;
      this.rafId = requestAnimationFrame(this.tick);
    }

    const interval = this.opts.emitIntervalMs ?? 1000;
    this.emitTimer = window.setInterval(this.emit, interval);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.emitTimer !== null) clearInterval(this.emitTimer);
    this.rafId = null;
    this.emitTimer = null;
    this.face?.close();
    this.face = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video = null;
  }

  /**
   * Switch modes at runtime. Used when the user revokes/grants camera
   * permission mid-session.
   */
  async setMode(mode: Mode): Promise<void> {
    if (mode === this.mode) return;
    this.stop();
    this.mode = mode;
    this.fusion.reset();
    await this.start();
  }

  private tick = (): void => {
    if (!this.face || !this.video) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    const ts = performance.now();
    const det = this.face.detect(this.video, ts);
    const beh = this.behavioral.snapshot();

    let face_present = 0;
    let head_aligned = 0;
    let gaze_on_screen = 0;

    if (det) {
      face_present = 1;
      const angles = eulerFromMatrix(det.matrix);
      head_aligned = headAlignedScore(angles);
      gaze_on_screen = gazeOnScreenScore(det.landmarks, angles);
    }

    this.latestFeatures = {
      face_present,
      head_aligned,
      gaze_on_screen,
      ...beh,
    };
    this.latestScore = this.fusion.update(this.latestFeatures, this.mode);

    this.opts.onDebug?.(this.latestFeatures, this.mode, this.latestScore);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private emit = (): void => {
    // In behavioral-only mode we have no RAF loop driving feature updates;
    // refresh the behavioral snapshot here so the emitted event is current.
    if (this.mode === "behavioral_only") {
      const beh = this.behavioral.snapshot();
      this.latestFeatures = {
        face_present: 0,
        head_aligned: 0,
        gaze_on_screen: 0,
        ...beh,
      };
      this.latestScore = this.fusion.update(this.latestFeatures, this.mode);
      this.opts.onDebug?.(this.latestFeatures, this.mode, this.latestScore);
    }

    const ev: EngagementEvent = {
      t: Date.now() / 1000,
      score: this.latestScore,
      features: this.latestFeatures,
      affect: null,
      drowsiness: null,
    };
    this.opts.onEvent(ev);
  };
}
