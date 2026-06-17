/**
 * Floating status pill — shows current mode and last engagement score.
 *
 * Stays visible whenever a session is active so the user is always aware
 * the monitor is running. A one-click pause is intentionally not destructive:
 * the user can also revoke camera permission in the browser at any time.
 */

import type { Mode } from "../engagement/types";

export class StatusIndicator {
  private readonly dot: HTMLElement;
  private readonly text: HTMLElement;
  private readonly headerMode: HTMLElement;

  constructor() {
    this.dot = document.getElementById("status-dot")!;
    this.text = document.getElementById("status-text")!;
    this.headerMode = document.getElementById("header-mode")!;
  }

  setMode(mode: Mode, score?: number): void {
    this.dot.classList.remove("behavioral", "off");
    if (mode === "behavioral_only") this.dot.classList.add("behavioral");

    const label = mode === "camera" ? "Camera on" : "Behavioral-only";
    const scoreText = score === undefined ? "" : ` · score ${score.toFixed(2)}`;
    this.text.textContent = label + scoreText;
    this.headerMode.textContent = label;
  }

  setOff(): void {
    this.dot.classList.add("off");
    this.text.textContent = "Monitor paused";
    this.headerMode.textContent = "paused";
  }
}
