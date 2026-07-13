/**
 * API Configuration
 *
 * The API endpoint is configured via the VITE_API_URL environment variable.
 * - In development: Leave empty or use relative paths (vite dev server proxies requests)
 * - In production: Set to your deployed backend URL (e.g., https://api.example.com)
 */

export const getApiUrl = (): string => {
  // __API_URL__ is defined in vite.config.ts via the define option
  const baseUrl = __API_URL__ || "";

  // Remove trailing slash if present
  return baseUrl.replace(/\/$/, "");
};

export const API_ENDPOINTS = {
  ingest: () => `${getApiUrl()}/ingest`,
  sessions: (id: string) => `${getApiUrl()}/sessions/${id}`,
  live: () => {
    // Convert protocol for WebSocket
    const baseUrl = getApiUrl();
    if (!baseUrl) return "/live";
    return baseUrl.replace(/^https?/, baseUrl.startsWith("https") ? "wss" : "ws");
  },
  // Lecture-video streaming (see app/stream.py). `streamInfo` is plain HTTP;
  // `stream` is the WebSocket the VideoStreamClient pumps bytes over.
  streamInfo: (lectureId: string) => `${getApiUrl()}/stream/${lectureId}/info`,
  stream: (lectureId: string) => {
    const base = getApiUrl();
    // http -> ws, https -> wss (a WebSocket URL must be absolute).
    if (base) return `${base.replace(/^http/, "ws")}/stream/${lectureId}`;
    // Same-origin: dev via the Vite proxy, or prod single-origin. Build from
    // the current location since there is no configured base URL.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/stream/${lectureId}`;
  },
};
