/**
 * No-calibration gaze heuristic.
 *
 * Combines:
 *   - iris offset within each eye socket (MediaPipe landmarks 468–477)
 *   - head pose (yaw, pitch) from HeadPose.ts
 *
 * Output: a soft "gaze on screen" score in [0, 1]. See MATH.md §5.
 */

import type { EulerAngles } from "./types";

// MediaPipe FaceLandmarker landmark indices.
// Eye corners (inner / outer).
const LEFT_INNER = 133;
const LEFT_OUTER = 33;
const RIGHT_INNER = 362;
const RIGHT_OUTER = 263;
// Iris landmarks (4 per eye).
const LEFT_IRIS = [468, 469, 470, 471] as const;
const RIGHT_IRIS = [473, 474, 475, 476] as const;

// Empirical constant — how much iris offset contributes vs head pose.
// See MATH.md §5.2.
const IRIS_GAIN = 1.5;

// Screen angular half-extents at typical sitting distance (~60 cm, 15-in screen).
const DEG = Math.PI / 180;
const SCREEN_HALF_X = 15 * DEG;
const SCREEN_HALF_Y = 9 * DEG;

interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
}

function midpoint(a: NormalizedLandmark, b: NormalizedLandmark): NormalizedLandmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centroid(points: NormalizedLandmark[]): NormalizedLandmark {
  let sx = 0;
  let sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  return { x: sx / points.length, y: sy / points.length };
}

function dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function eyeOffset(
  landmarks: NormalizedLandmark[],
  innerIdx: number,
  outerIdx: number,
  irisIdxs: readonly number[],
): { ox: number; oy: number } {
  const inner = landmarks[innerIdx]!;
  const outer = landmarks[outerIdx]!;
  const irisPts = irisIdxs.map(i => landmarks[i]!);

  const eyeCenter = midpoint(inner, outer);
  const irisCenter = centroid(irisPts);
  const eyeWidth = dist(inner, outer) || 1e-6;

  return {
    ox: (irisCenter.x - eyeCenter.x) / eyeWidth,
    oy: (irisCenter.y - eyeCenter.y) / eyeWidth,
  };
}

/**
 * Compute a soft "gaze on screen" score in [0, 1].
 *
 * @param landmarks normalized 2D landmarks (x, y in [0, 1])
 * @param head     head pose Euler angles (radians)
 */
export function gazeOnScreenScore(
  landmarks: NormalizedLandmark[],
  head: EulerAngles,
): number {
  if (landmarks.length < 478) {
    // No iris landmarks — fall back to head pose only.
    const ny = head.yaw / SCREEN_HALF_X;
    const np = head.pitch / SCREEN_HALF_Y;
    return Math.exp(-(ny * ny + np * np));
  }

  const left = eyeOffset(landmarks, LEFT_INNER, LEFT_OUTER, LEFT_IRIS);
  const right = eyeOffset(landmarks, RIGHT_INNER, RIGHT_OUTER, RIGHT_IRIS);

  const ox = (left.ox + right.ox) / 2;
  const oy = (left.oy + right.oy) / 2;

  const gx = head.yaw + IRIS_GAIN * ox;
  const gy = head.pitch + IRIS_GAIN * oy;

  const ny = gx / SCREEN_HALF_X;
  const np = gy / SCREEN_HALF_Y;
  return Math.exp(-(ny * ny + np * np));
}
