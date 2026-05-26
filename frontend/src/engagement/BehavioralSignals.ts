/**
 * Behavioral signals: visibility, focus, mouse/keyboard activity.
 *
 * Zero-cost, robust, and used both as a primary signal in behavioral-only
 * mode and as a confidence anchor when the camera is on.
 *
 * See MATH.md §6.
 */

export class BehavioralSignals {
  private activity = 0;
  private lastActivityUpdate = performance.now();
  /** Activity time constant in seconds — half-life ~ τ·ln(2). */
  private readonly tau = 20;

  constructor() {
    const bump = () => this.bumpActivity();
    window.addEventListener("mousemove", bump, { passive: true });
    window.addEventListener("mousedown", bump, { passive: true });
    window.addEventListener("keydown", bump, { passive: true });
    window.addEventListener("scroll", bump, { passive: true });
    window.addEventListener("touchstart", bump, { passive: true });
  }

  /** Apply the IIR decay and inject an impulse. */
  private bumpActivity(): void {
    this.decay();
    // Inject a bounded impulse so a rapid burst can't push activity > 1.
    this.activity = Math.min(1, this.activity + 0.25);
  }

  private decay(): void {
    const now = performance.now();
    const dt = (now - this.lastActivityUpdate) / 1000;
    this.lastActivityUpdate = now;
    // First-order low-pass: a_t = exp(-dt/τ) * a_{t-1}
    this.activity *= Math.exp(-dt / this.tau);
  }

  /**
   * Snapshot the current behavioral feature triple. Safe to call at any rate.
   */
  snapshot(): { tab_visible: number; window_focused: number; input_activity: number } {
    this.decay();
    return {
      tab_visible: document.visibilityState === "visible" ? 1 : 0,
      window_focused: document.hasFocus() ? 1 : 0,
      input_activity: this.activity,
    };
  }
}
