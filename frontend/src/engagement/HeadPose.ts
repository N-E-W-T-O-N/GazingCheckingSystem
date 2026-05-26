/**
 * Head pose extraction from MediaPipe's 4x4 facialTransformationMatrix.
 *
 * MediaPipe ships a 4x4 row-major matrix per detected face that maps the
 * canonical 3D face model into camera space. We pull the rotation submatrix
 * and convert to ZYX Tait-Bryan Euler angles (yaw / pitch / roll).
 *
 * See MATH.md §3.2 and §4 for the derivation and the gimbal-lock fallback.
 */

import type { EulerAngles } from "./types";

const GIMBAL_EPSILON = 1e-6;

/**
 * Extract Euler angles from a row-major 4x4 transform.
 * The input is the same shape MediaPipe returns: a Float32Array length 16.
 */
export function eulerFromMatrix(matrix: ArrayLike<number>): EulerAngles {
  // Row-major indexing: matrix[row*4 + col]
  const r11 = matrix[0]!;
  const r12 = matrix[1]!;
  const r21 = matrix[4]!;
  const r22 = matrix[5]!;
  const r31 = matrix[8]!;
  const r32 = matrix[9]!;
  const r33 = matrix[10]!;

  const cosPitch = Math.sqrt(r32 * r32 + r33 * r33);

  if (cosPitch < GIMBAL_EPSILON) {
    // Gimbal lock: pitch ≈ ±π/2. Yaw and roll become coupled; we collapse
    // by setting roll = 0 and reading yaw from the alternative pair.
    return {
      pitch: Math.atan2(-r31, cosPitch),
      yaw: Math.atan2(-r12, r22),
      roll: 0,
    };
  }

  return {
    pitch: Math.atan2(-r31, cosPitch),
    yaw: Math.atan2(r21, r11),
    roll: Math.atan2(r32, r33),
  };
}

const DEG = Math.PI / 180;
// Standard deviations of the "head aligned" Gaussian — see MATH.md §4.1.
const SIGMA_YAW = 25 * DEG;
const SIGMA_PITCH = 20 * DEG;

/** Returns a soft "head aligned with screen" indicator in [0, 1]. */
export function headAlignedScore(angles: EulerAngles): number {
  const ny = angles.yaw / SIGMA_YAW;
  const np = angles.pitch / SIGMA_PITCH;
  return Math.exp(-(ny * ny + np * np));
}
