/**
 * Demo SPA entrypoint.
 *
 * Wires together:
 *   - ConsentDialog → asks for camera permission (and camera, if >1) or skip
 *   - VideoStreamClient → streams the lecture video from the backend (MSE)
 *   - EngagementMonitor → runs the perception cascade + the playback gate
 *   - PauseOverlay → explains an attention-gated pause (not a spinner)
 *   - EventSender → batches and POSTs events to FastAPI /ingest
 *   - StatusIndicator + DebugOverlay → UI (mode, playback, live camera picker)
 *
 * Open this file alongside MATH.md §8 to trace a frame end-to-end.
 */

import { EngagementMonitor } from "./engagement/EngagementMonitor";
import type { Mode } from "./engagement/types";
import { EventSender } from "./transport/EventSender";
import { VideoStreamClient } from "./transport/VideoStreamClient";
import { showConsentDialog } from "./ui/ConsentDialog";
import { DebugOverlay } from "./ui/DebugOverlay";
import { PauseOverlay } from "./ui/PauseOverlay";
import { StatusIndicator } from "./ui/StatusIndicator";
import { API_ENDPOINTS } from "./config";

const LECTURE_ID = "lec-101";
const CAMERA_KEY = "gaze.preferred_camera";

// Stable session id per page load; persists to sessionStorage so a reload
// continues the same conceptual session.
function getSessionId(): string {
  const KEY = "gaze.session_id";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

/** Dev/test: prompt for a video file to feed the detector in place of the webcam. */
function pickTestVideo(): Promise<string> {
  return new Promise(resolve => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    const h = document.createElement("h2");
    h.textContent = "Test camera mode";
    const p = document.createElement("p");
    p.textContent =
      "Pick a video of a person's face. It loops and drives face / gaze / score " +
      "in place of the webcam, so you can test detection without a live camera.";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      document.body.removeChild(backdrop);
      resolve(URL.createObjectURL(file));
    };
    modal.append(h, p, input);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  });
}

async function refreshCameraPicker(indicator: StatusIndicator, currentId?: string): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    indicator.setCameras(devices.filter(d => d.kind === "videoinput"), currentId);
  } catch {
    /* enumerateDevices may be unavailable; picker just stays hidden */
  }
}

async function main(): Promise<void> {
  const indicator = new StatusIndicator();
  const overlay = new DebugOverlay();

  const params = new URLSearchParams(location.search);
  // `let` because we may downgrade to behavioral-only if getUserMedia rejects.
  let mode: Mode;
  let cameraId: string | undefined;
  let testVideoUrl: string | undefined;
  if (params.has("testcam")) {
    // Dev/test: feed a looped video file to the detector instead of the webcam.
    testVideoUrl = await pickTestVideo();
    mode = "camera";
  } else {
    const consent = await showConsentDialog();
    mode = consent.mode;
    cameraId = consent.deviceId ?? localStorage.getItem(CAMERA_KEY) ?? undefined;
    if (cameraId) localStorage.setItem(CAMERA_KEY, cameraId);
  }
  indicator.setMode(mode);

  // ── Video: stream it from the backend, gated on attention ──────────────
  const video = document.getElementById("lecture-video") as HTMLVideoElement;
  const pauseOverlay = new PauseOverlay(video);
  const stream = new VideoStreamClient({
    video,
    infoUrl: API_ENDPOINTS.streamInfo(LECTURE_ID),
    wsUrl: API_ENDPOINTS.stream(LECTURE_ID),
    onError: msg => pauseOverlay.error(msg),
  });
  void stream.start();

  // ── Telemetry ──────────────────────────────────────────────────────────
  const sessionId = getSessionId();
  const sender = new EventSender({
    endpoint: API_ENDPOINTS.ingest(),
    sessionId,
    lectureId: LECTURE_ID,
    userId: "anonymous", // wire from your auth in real use
    mode,
  });
  sender.start();

  // ── Perception + playback gate ───────────────────────────────────────────
  const monitor = new EngagementMonitor({
    mode,
    deviceId: cameraId,
    testVideoUrl,
    onEvent: ev => {
      sender.enqueue(ev);
      // Read `mode` lazily so a runtime downgrade is reflected in the UI.
      indicator.setMode(mode, ev.score);
    },
    onDebug: (f, m, s) => overlay.update(f, m, s),
    onGateChange: (playing, reason) => {
      indicator.setPlayback(playing);
      if (playing) {
        pauseOverlay.hide();
        stream.resume();
      } else {
        pauseOverlay.show(reason);
        stream.pause();
      }
    },
  });

  try {
    await monitor.start();
  } catch (err) {
    // Camera-grant denied at the OS prompt, or no camera attached.
    console.warn("[main] camera unavailable, falling back to behavioral-only", err);
    mode = "behavioral_only";
    sender.setMode(mode);
    indicator.setMode(mode);
    await monitor.setMode(mode);
  }

  // ── Live camera picker (only meaningful with a real camera + ≥2 devices) ──
  if (mode === "camera" && !testVideoUrl) {
    indicator.onCameraChange = async deviceId => {
      localStorage.setItem(CAMERA_KEY, deviceId);
      try {
        await monitor.setCamera(deviceId);
      } catch (err) {
        console.warn("[main] camera switch failed", err);
      }
    };
    // Labels are populated now that permission is granted.
    await refreshCameraPicker(indicator, cameraId);
  }
}

void main();
