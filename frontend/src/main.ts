/**
 * Demo SPA entrypoint.
 *
 * Wires together:
 *   - ConsentDialog → asks the user for camera permission (or skip)
 *   - EngagementMonitor → runs the perception cascade
 *   - EventSender → batches and POSTs events to FastAPI /ingest
 *   - StatusIndicator + DebugOverlay → UI
 *
 * Open this file alongside MATH.md §8 to trace a frame end-to-end.
 */

import { EngagementMonitor } from "./engagement/EngagementMonitor";
import type { Mode } from "./engagement/types";
import { EventSender } from "./transport/EventSender";
import { showConsentDialog } from "./ui/ConsentDialog";
import { DebugOverlay } from "./ui/DebugOverlay";
import { StatusIndicator } from "./ui/StatusIndicator";
import { API_ENDPOINTS } from "./config";

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

async function main(): Promise<void> {
  const indicator = new StatusIndicator();
  const overlay = new DebugOverlay();

  // `let` because we may downgrade to behavioral-only at runtime if
  // getUserMedia rejects after the user already clicked "Allow camera".
  let mode: Mode = await showConsentDialog();
  indicator.setMode(mode);

  const sessionId = getSessionId();
  const sender = new EventSender({
    endpoint: API_ENDPOINTS.ingest(),
    sessionId,
    lectureId: "lec-101",
    userId: "anonymous", // wire from your auth in real use
    mode,
  });
  sender.start();

  const monitor = new EngagementMonitor({
    mode,
    onEvent: ev => {
      sender.enqueue(ev);
      // Read `mode` lazily so a runtime downgrade is reflected in the UI.
      indicator.setMode(mode, ev.score);
    },
    onDebug: (f, m, s) => overlay.update(f, m, s),
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

  // Hook a placeholder lecture video. In a real deployment this is your
  // existing video player; the monitor runs independently.
  const video = document.getElementById("lecture-video") as HTMLVideoElement;
  // Public Big Buck Bunny — a small free sample so the demo plays out of the box.
  video.src =
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
}

void main();
