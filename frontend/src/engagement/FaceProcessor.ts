/**
 * MediaPipe FaceLandmarker wrapper.
 *
 * Loads the WASM + model from the official CDN, runs detection at the rate
 * driven by the caller (typically requestAnimationFrame), and exposes a
 * simple `detect(video)` returning landmarks + 4x4 transformation matrix.
 *
 * We deliberately do not run the model in a Web Worker for v1 — MediaPipe's
 * GPU delegate already keeps work off the main thread. Move to OffscreenCanvas
 * + worker if you find the main thread frame budget tight.
 */

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface DetectionResult {
  /** Normalized 2D landmarks (478 points), x and y in [0, 1]. */
  landmarks: { x: number; y: number; z?: number }[];
  /** 4x4 row-major transformation matrix from canonical face to camera. */
  matrix: Float32Array;
}

export class FaceProcessor {
  private landmarker: FaceLandmarker | null = null;
  private ready = false;

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false, // reserved for affect module
      outputFacialTransformationMatrixes: true,
    });
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Run one detection. Returns null if no face is detected.
   * `timestampMs` should be monotonically increasing.
   */
  detect(video: HTMLVideoElement, timestampMs: number): DetectionResult | null {
    if (!this.landmarker) return null;
    const result = this.landmarker.detectForVideo(video, timestampMs);
    if (!result.faceLandmarks || result.faceLandmarks.length === 0) return null;
    const landmarks = result.faceLandmarks[0]!;
    const matrices = result.facialTransformationMatrixes;
    if (!matrices || matrices.length === 0) return null;
    return {
      landmarks,
      matrix: matrices[0]!.data as unknown as Float32Array,
    };
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.ready = false;
  }
}
