/**
 * Floating status pill — shows current mode, playback state, and last score,
 * and (when more than one camera exists) a dropdown to switch cameras live.
 *
 * Stays visible whenever a session is active so the user is always aware the
 * monitor is running and whether the lecture is playing or paused.
 */
import type { Mode } from "../engagement/types";

export class StatusIndicator {
  private readonly dot: HTMLElement;
  private readonly text: HTMLElement;
  private readonly headerMode: HTMLElement;
  private cameraSelect: HTMLSelectElement | null = null;
  private qualitySelect: HTMLSelectElement | null = null;

  private mode: Mode = "camera";
  private score: number | undefined;
  private playing = true;

  /** Wired by main.ts to hot-swap the camera. */
  onCameraChange?: (deviceId: string) => void;
  /** Wired by main.ts to switch the lecture-video rendition. */
  onQualityChange?: (id: string) => void;

  constructor() {
    this.dot = document.getElementById("status-dot")!;
    this.text = document.getElementById("status-text")!;
    this.headerMode = document.getElementById("header-mode")!;
  }

  setMode(mode: Mode, score?: number): void {
    this.mode = mode;
    if (score !== undefined) this.score = score;
    this.render();
  }

  /** Reflect the playback gate: playing (▶) vs paused (⏸). */
  setPlayback(playing: boolean): void {
    this.playing = playing;
    this.render();
  }

  /** Populate/refresh the live camera picker; hidden when < 2 cameras. */
  setCameras(cameras: MediaDeviceInfo[], currentId?: string): void {
    if (cameras.length < 2) {
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      return;
    }
    if (!this.cameraSelect) {
      const select = document.createElement("select");
      select.title = "Camera";
      select.style.fontSize = "0.72rem";
      select.style.maxWidth = "9rem";
      select.addEventListener("change", () => this.onCameraChange?.(select.value));
      document.getElementById("status")?.appendChild(select);
      this.cameraSelect = select;
    }
    const select = this.cameraSelect;
    select.style.display = "";
    select.innerHTML = "";
    cameras.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      select.appendChild(opt);
    });
    if (currentId) select.value = currentId;
  }

  /** Populate/refresh the lecture-video quality picker; hidden when < 2 options. */
  setQualities(renditions: { id: string; label: string }[], currentId: string): void {
    if (renditions.length < 2) {
      if (this.qualitySelect) this.qualitySelect.style.display = "none";
      return;
    }
    if (!this.qualitySelect) {
      const select = document.createElement("select");
      select.title = "Video quality";
      select.style.fontSize = "0.72rem";
      select.style.maxWidth = "6rem";
      select.addEventListener("change", () => this.onQualityChange?.(select.value));
      document.getElementById("status")?.appendChild(select);
      this.qualitySelect = select;
    }
    const select = this.qualitySelect;
    select.style.display = "";
    select.innerHTML = "";
    renditions.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.label;
      select.appendChild(opt);
    });
    select.value = currentId;
  }

  private render(): void {
    this.dot.classList.remove("behavioral", "off");
    if (!this.playing) this.dot.classList.add("off");
    else if (this.mode === "behavioral_only") this.dot.classList.add("behavioral");

    const label = this.mode === "camera" ? "Camera on" : "Behavioral-only";
    const glyph = this.playing ? "▶" : "⏸";
    const scoreText = this.score === undefined ? "" : ` · ${this.score.toFixed(2)}`;
    this.text.textContent = `${glyph} ${label}${scoreText}`;
    this.headerMode.textContent = label;
  }
}
