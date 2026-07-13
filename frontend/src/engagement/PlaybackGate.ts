/**
 * Decides whether the lecture video should play, from the engagement signals.
 *
 * Rule (spec §7 / D1): pause when the student looks away OR the fused score
 * drops. Hysteresis (separate pause/resume thresholds) plus time-based debounce
 * keep a momentary glance from flickering playback. The result carries a
 * *reason* (not just a boolean) so the PauseOverlay can explain the pause.
 */
import type { FeatureVector, GateReason, Mode } from "./types";

export interface GateThresholds {
  FACE_MIN: number;
  GAZE_PAUSE: number;
  GAZE_RESUME: number;
  E_PAUSE: number;
  E_RESUME: number;
  PAUSE_DEBOUNCE_MS: number;
  RESUME_DEBOUNCE_MS: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  FACE_MIN: 0.5,
  GAZE_PAUSE: 0.35,
  GAZE_RESUME: 0.5,
  E_PAUSE: 0.4,
  E_RESUME: 0.5,
  PAUSE_DEBOUNCE_MS: 1500,
  RESUME_DEBOUNCE_MS: 500,
};

export interface GateResult {
  /** True only on the tick where the play/pause state actually flipped. */
  changed: boolean;
  playing: boolean;
  /** Reason playback is paused; null while playing. */
  reason: GateReason | null;
}

export class PlaybackGate {
  private playing = true;
  private reason: GateReason | null = null;
  private candidate: boolean | null = null;
  private candidateSince = 0;

  constructor(private readonly t: GateThresholds = DEFAULT_THRESHOLDS) {}

  /**
   * Feed the latest signals. `cameraOff` is true when the camera track is
   * muted/ended (lid/shutter). Returns whether the state changed this tick.
   */
  update(
    now: number,
    f: FeatureVector,
    score: number,
    mode: Mode,
    cameraOff: boolean,
  ): GateResult {
    const desired = this.evaluate(f, score, mode, cameraOff);

    if (desired.play === this.playing) {
      this.candidate = null; // stable; cancel any pending flip
      return { changed: false, playing: this.playing, reason: this.reason };
    }

    // A flip is desired — start (or continue) its debounce window.
    if (this.candidate !== desired.play) {
      this.candidate = desired.play;
      this.candidateSince = now;
      return { changed: false, playing: this.playing, reason: this.reason };
    }

    const debounce = desired.play ? this.t.RESUME_DEBOUNCE_MS : this.t.PAUSE_DEBOUNCE_MS;
    if (now - this.candidateSince < debounce) {
      return { changed: false, playing: this.playing, reason: this.reason };
    }

    // Debounce satisfied — commit the flip.
    this.playing = desired.play;
    this.reason = desired.play ? null : desired.reason;
    this.candidate = null;
    return { changed: true, playing: this.playing, reason: this.reason };
  }

  /** Reset to the initial "playing" state (e.g. after a mode switch). */
  reset(): void {
    this.playing = true;
    this.reason = null;
    this.candidate = null;
  }

  /**
   * Desired play state with hysteresis: thresholds are stricter to *resume*
   * than to *pause*, so the state has to clearly change before it flips.
   */
  private evaluate(
    f: FeatureVector,
    score: number,
    mode: Mode,
    cameraOff: boolean,
  ): { play: boolean; reason: GateReason | null } {
    // Resume needs the higher thresholds; while playing, use the pause ones.
    const gazeMin = this.playing ? this.t.GAZE_PAUSE : this.t.GAZE_RESUME;
    const scoreMin = this.playing ? this.t.E_PAUSE : this.t.E_RESUME;

    if (mode === "behavioral_only") {
      if (f.tab_visible < 1 || f.window_focused < 1) return { play: false, reason: "hidden" };
      if (score < scoreMin) return { play: false, reason: "low_score" };
      return { play: true, reason: null };
    }

    // camera mode — reasons in priority order.
    if (cameraOff) return { play: false, reason: "camera_off" };
    if (f.face_present < this.t.FACE_MIN || f.gaze_on_screen < gazeMin) {
      return { play: false, reason: "no_face" };
    }
    if (score < scoreMin) return { play: false, reason: "low_score" };
    return { play: true, reason: null };
  }
}
