/**
 * Pre-flight camera-consent dialog.
 *
 * The brief: "Camera is need but may not be provided. Need to tell beforehand."
 *
 * Flow:
 *   1. Probe getUserMedia availability and the camera permission state.
 *   2. Show a modal explaining what we compute on-device vs. what we send.
 *   3. User picks: "Allow camera" (camera mode) or "Continue without" (behavioral-only).
 *   4. If the OS / browser has previously blocked the camera, surface a recovery message.
 */

import type { Mode } from "../engagement/types";

interface PermissionProbe {
  supported: boolean;
  state: PermissionState | "unknown";
}

async function probeCameraPermission(): Promise<PermissionProbe> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { supported: false, state: "denied" };
  }
  try {
    // The Permissions API is not available in all browsers, and the camera
    // PermissionName is not in every TS lib.dom version. Cast and recover.
    const status = await navigator.permissions.query({
      name: "camera" as PermissionName,
    });
    return { supported: true, state: status.state };
  } catch {
    return { supported: true, state: "unknown" };
  }
}

export interface ConsentResult {
  mode: Mode;
  /** Chosen camera, when the user picked one here. Undefined = browser default. */
  deviceId?: string;
}

async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  } catch {
    return [];
  }
}

export async function showConsentDialog(): Promise<ConsentResult> {
  const probe = await probeCameraPermission();
  const cameras = await listCameras();

  return new Promise<ConsentResult>(resolve => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";

    const title = document.createElement("h2");
    title.textContent = "Before the lecture starts";
    modal.appendChild(title);

    const explainer = document.createElement("p");
    explainer.innerHTML = `
      This lecture can measure how attentive you are by using your webcam.
      <strong>No video ever leaves your device.</strong> Only six numeric
      attention signals per second (head orientation, whether you appear to
      be looking at the screen, tab visibility, etc.) are sent to the server,
      and you can switch to behavioral-only mode at any time.
    `;
    modal.appendChild(explainer);

    if (!probe.supported) {
      const warn = document.createElement("p");
      warn.style.color = "#f0883e";
      warn.textContent =
        "Your browser does not support webcam access. You can still join the lecture in behavioral-only mode.";
      modal.appendChild(warn);
    } else if (probe.state === "denied") {
      const warn = document.createElement("p");
      warn.style.color = "#f0883e";
      warn.innerHTML = `
        Camera permission for this site is currently <strong>blocked</strong>
        at the browser or OS level. You can re-enable it in your browser's
        site settings, or continue in behavioral-only mode.
      `;
      modal.appendChild(warn);
    }

    // Camera picker. deviceId/labels are only exposed after permission, so we
    // show it when there are already ≥2 real cameras (a returning user).
    // Otherwise the live switcher in the status bar handles selection post-grant.
    let cameraSelect: HTMLSelectElement | null = null;
    if (probe.supported && cameras.length >= 2 && cameras.some(c => c.deviceId)) {
      const label = document.createElement("label");
      label.style.display = "block";
      label.style.margin = "0.75rem 0 0";
      label.style.fontSize = "0.85rem";
      label.textContent = "Camera: ";
      const select = document.createElement("select");
      select.style.marginLeft = "0.4rem";
      cameras.forEach((cam, i) => {
        const opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera ${i + 1}`;
        select.appendChild(opt);
      });
      label.appendChild(select);
      modal.appendChild(label);
      cameraSelect = select;
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const allowBtn = document.createElement("button");
    allowBtn.textContent =
      probe.state === "granted" ? "Use camera" : "Allow camera";
    allowBtn.disabled = !probe.supported || probe.state === "denied";
    allowBtn.onclick = () => {
      document.body.removeChild(backdrop);
      resolve({ mode: "camera", deviceId: cameraSelect?.value || undefined });
    };

    const skipBtn = document.createElement("button");
    skipBtn.className = "secondary";
    skipBtn.textContent = "Continue without camera";
    skipBtn.onclick = () => {
      document.body.removeChild(backdrop);
      resolve({ mode: "behavioral_only" });
    };

    actions.appendChild(allowBtn);
    actions.appendChild(skipBtn);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  });
}
