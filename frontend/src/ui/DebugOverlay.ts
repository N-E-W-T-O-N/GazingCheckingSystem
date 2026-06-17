/**
 * Right-side debug panel — live per-signal values for visual verification.
 *
 * Useful while validating the math in MATH.md §8.
 */

import type { FeatureVector, Mode } from "../engagement/types";

function fmt(x: number): string {
  return x.toFixed(2);
}

export class DebugOverlay {
  private readonly el = {
    mode: document.getElementById("dbg-mode")!,
    face: document.getElementById("dbg-face")!,
    head: document.getElementById("dbg-head")!,
    gaze: document.getElementById("dbg-gaze")!,
    vis: document.getElementById("dbg-vis")!,
    foc: document.getElementById("dbg-foc")!,
    act: document.getElementById("dbg-act")!,
    score: document.getElementById("dbg-score")!,
  };

  update(f: FeatureVector, mode: Mode, score: number): void {
    this.el.mode.textContent = mode;
    this.el.face.textContent = fmt(f.face_present);
    this.el.head.textContent = fmt(f.head_aligned);
    this.el.gaze.textContent = fmt(f.gaze_on_screen);
    this.el.vis.textContent = fmt(f.tab_visible);
    this.el.foc.textContent = fmt(f.window_focused);
    this.el.act.textContent = fmt(f.input_activity);
    this.el.score.innerHTML = `<strong>${fmt(score)}</strong>`;
  }
}
