/**
 * Score fusion: weighted-logistic combination plus EMA smoothing.
 *
 * See MATH.md §7.
 *
 * Weights are kept here as a single source of truth. In behavioral-only mode
 * the camera-derived weights are zeroed and the rest are renormalized so the
 * bias still places the decision boundary at the same place.
 */

import type { FeatureVector, Mode } from "./types";

interface Weights {
  face_present: number;
  head_aligned: number;
  gaze_on_screen: number;
  tab_visible: number;
  window_focused: number;
  input_activity: number;
  bias: number;
}

const DEFAULT_WEIGHTS: Weights = {
  face_present: 1.2,
  head_aligned: 1.6,
  gaze_on_screen: 1.4,
  tab_visible: 1.2,
  window_focused: 0.8,
  input_activity: 0.4,
  bias: 2.5,
};

function sigmoid(z: number): number {
  // Numerically stable sigmoid.
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function weightsForMode(mode: Mode): Weights {
  if (mode === "camera") return DEFAULT_WEIGHTS;

  // Behavioral-only: zero out camera-derived terms, renormalize the rest so
  // total feature weight is preserved (keeps decision boundary similar).
  const cameraSum =
    DEFAULT_WEIGHTS.face_present +
    DEFAULT_WEIGHTS.head_aligned +
    DEFAULT_WEIGHTS.gaze_on_screen;
  const remainingSum =
    DEFAULT_WEIGHTS.tab_visible +
    DEFAULT_WEIGHTS.window_focused +
    DEFAULT_WEIGHTS.input_activity;
  const scale = (cameraSum + remainingSum) / remainingSum;

  return {
    face_present: 0,
    head_aligned: 0,
    gaze_on_screen: 0,
    tab_visible: DEFAULT_WEIGHTS.tab_visible * scale,
    window_focused: DEFAULT_WEIGHTS.window_focused * scale,
    input_activity: DEFAULT_WEIGHTS.input_activity * scale,
    bias: DEFAULT_WEIGHTS.bias,
  };
}

export class ScoreFusion {
  private smoothed = 0.5;
  /** EMA constant: α≈0.2 gives a ~5 s effective time constant at 1 Hz. */
  private readonly alpha = 0.2;

  /** Returns the smoothed score in [0, 1]. */
  update(f: FeatureVector, mode: Mode): number {
    const w = weightsForMode(mode);
    const z =
      w.face_present * f.face_present +
      w.head_aligned * f.head_aligned +
      w.gaze_on_screen * f.gaze_on_screen +
      w.tab_visible * f.tab_visible +
      w.window_focused * f.window_focused +
      w.input_activity * f.input_activity -
      w.bias;
    const raw = sigmoid(z);
    this.smoothed = this.alpha * raw + (1 - this.alpha) * this.smoothed;
    return this.smoothed;
  }

  reset(): void {
    this.smoothed = 0.5;
  }
}
