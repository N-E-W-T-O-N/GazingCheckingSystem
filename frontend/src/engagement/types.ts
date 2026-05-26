/**
 * Shared types for the engagement pipeline.
 *
 * Keep these flat and JSON-serializable — they are sent over the network and
 * also passed across Web Worker boundaries.
 */

export type Mode = "camera" | "behavioral_only";

export interface FeatureVector {
  /** 1 if a face was detected this frame, 0 otherwise. */
  face_present: number;
  /** Soft Gaussian over yaw/pitch. See MATH.md §4.1. */
  head_aligned: number;
  /** Soft Gaussian over combined head + iris gaze angles. See MATH.md §5.3. */
  gaze_on_screen: number;
  /** 1 if document.visibilityState === "visible". */
  tab_visible: number;
  /** 1 if document.hasFocus(). */
  window_focused: number;
  /** EMA of mouse/keyboard events. See MATH.md §6.3. */
  input_activity: number;
}

export interface EngagementEvent {
  /** Epoch seconds (float) from the browser clock. */
  t: number;
  /** Smoothed engagement in [0, 1]. */
  score: number;
  features: FeatureVector;
  affect: null;
  drowsiness: null;
}

export interface EulerAngles {
  /** Left/right turn, radians. */
  yaw: number;
  /** Up/down nod, radians. */
  pitch: number;
  /** Head tilt, radians. */
  roll: number;
}
