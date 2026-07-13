/**
 * Explicit "paused" overlay drawn over the lecture video.
 *
 * The point (spec §7.3 / D7): a server-gated stall would otherwise show the
 * browser's native buffering spinner, which is indistinguishable from network
 * lag. The client pauses the <video> (freezing the frame, no spinner) and this
 * overlay states *why* it paused and how to resume — so an intentional pause is
 * never mistaken for a bad connection.
 */
import type { GateReason } from "../engagement/types";

const MESSAGES: Record<GateReason, { title: string; body: string }> = {
  camera_off: {
    title: "Camera turned off",
    body: "The lecture is paused. Turn your camera back on, or reload and choose behavioral-only mode.",
  },
  no_face: {
    title: "Paused — we can't see you",
    body: "Face the screen and make sure your camera isn't covered.",
  },
  low_score: {
    title: "Paused",
    body: "You seemed away — it'll resume when you're back.",
  },
  hidden: {
    title: "Paused",
    body: "Return to this tab to continue the lecture.",
  },
};

export class PauseOverlay {
  private readonly el: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;

  /** Wraps `video` in a positioned container and overlays the message box. */
  constructor(video: HTMLVideoElement) {
    const parent = video.parentElement;
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.style.display = "block";
    if (parent) parent.insertBefore(wrap, video);
    wrap.appendChild(video);

    this.el = document.createElement("div");
    Object.assign(this.el.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "0.4rem",
      textAlign: "center",
      padding: "1rem",
      background: "rgba(13, 17, 23, 0.72)",
      color: "#e6edf3",
      borderRadius: "6px",
      backdropFilter: "blur(2px)",
      zIndex: "5",
    } as CSSStyleDeclaration);

    const icon = document.createElement("div");
    icon.textContent = "⏸";
    icon.style.fontSize = "2rem";

    this.titleEl = document.createElement("div");
    Object.assign(this.titleEl.style, { fontSize: "1.05rem", fontWeight: "600" } as CSSStyleDeclaration);

    this.bodyEl = document.createElement("div");
    Object.assign(this.bodyEl.style, {
      fontSize: "0.85rem",
      color: "#8b949e",
      maxWidth: "34ch",
      lineHeight: "1.4",
    } as CSSStyleDeclaration);

    this.el.append(icon, this.titleEl, this.bodyEl);
    wrap.appendChild(this.el);
  }

  show(reason: GateReason | null): void {
    const msg = MESSAGES[reason ?? "low_score"];
    this.titleEl.textContent = msg.title;
    this.bodyEl.textContent = msg.body;
    this.el.style.display = "flex";
  }

  hide(): void {
    this.el.style.display = "none";
  }

  /** Show a fatal error (e.g. stream unreachable / unsupported codec). */
  error(text: string): void {
    this.titleEl.textContent = "Video unavailable";
    this.bodyEl.textContent = text;
    this.el.style.display = "flex";
  }
}
