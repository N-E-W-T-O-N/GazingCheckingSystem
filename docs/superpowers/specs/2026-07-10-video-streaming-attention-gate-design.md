# Design — Backend-streamed, attention-gated lecture video + multi-camera picker

- **Date:** 2026-07-10
- **Status:** Approved (design); pending spec review
- **Author:** kumar.amit@dotsquares.com (with Claude)
- **Branch:** `backend`

---

## 1. Summary

Three coordinated features on top of the existing engagement pipeline:

1. **The lecture video streams from the backend** instead of a hardcoded external URL.
2. **Playback is gated on attention** — the video does not play while the student is
   looking away or otherwise disengaged.
3. **A multi-camera picker** lets the user choose which webcam to use when more than one
   is present, both up front and live during a session.

The enforcement is **server-gated**: the server withholds video bytes while the browser
reports the student is not attentive. Because all camera perception must stay on-device
(privacy model), the *decision* to pause is computed in the browser; the *enforcement*
(withholding segments) is done by the server over a WebSocket.

---

## 2. Decisions recorded from brainstorming

| # | Decision | Choice |
|---|---|---|
| D1 | What counts as "not looking" | **Look-away OR score-drop** — pause if gaze is off-screen / no face **or** the fused engagement score `E` drops below threshold. |
| D2 | Behavioral-only mode (no camera) | **Pause on tab-hidden / window-blur** as the "looking" proxy; the score gate still applies. |
| D3 | Transport / who enforces the pause | **Server-gated via WebSocket + MSE** — server refuses to send segments while disengaged. (HTTP Range was the simpler alternative but cannot enforce a server-side gate.) |
| D4 | Camera picker placement | **Consent dialog + live switch in the status bar.** |
| D5 | Documentation | README.md and MATH.md are updated as part of this work. |
| D6 | How the server gets the video | **Auto-download at runtime**, not committed to git. On first run the backend fetches `VIDEO_SOURCE_URL` (default the Blender 720p `big_buck_bunny_720p_h264.mov`), fragments it to fMP4, and caches it locally (gitignored). Solves "what if someone clones" without an LFS/large-file push. Requires `ffmpeg` in the runtime image. |

---

## 3. Non-goals / scope limits (v1)

Consequences of the server-gated WebSocket+MSE choice, documented honestly:

- **No seeking/scrubbing** beyond what is already buffered. Playback is linear. (HTTP Range
  would give free seeking; the server gate is the reason we don't use it.)
- **No mid-stream resume after a dropped socket.** On WS close/error the client surfaces an
  error and offers reload; it does not resume from the last byte offset.
- **No adaptive bitrate / multiple renditions.** Single file, single quality.
- **No DRM.** The gate discourages passive idle-watching; it is not anti-piracy.
- **Fragmentation happens once at runtime, not per-request.** The first run downloads +
  fragments the source and caches the result; subsequent runs reuse the cache. There is no
  per-request or adaptive transcoding.
- **First run is slow and network-dependent.** The default source is ~270 MB; the initial
  download + fragment must finish before the video is playable. On an ephemeral host (e.g. HF
  Spaces free tier) this repeats on every cold start unless the cache dir is on persistent
  storage. If the download fails (offline host), streaming is unavailable and the client
  shows an error — the rest of the app (engagement pipeline, ingest) still works.

---

## 4. Architecture

```
┌─ Browser ─────────────────────────────────────────────────────┐
│  Camera → FaceProcessor → features + smoothed score E          │
│                       │                                        │
│         ┌─────────────┴───────────────┐                        │
│         ▼                             ▼                         │
│   PlaybackGate (new)           EventSender (existing)          │
│   attentive = NOT(lookAway     POST /ingest (unchanged)        │
│                OR scoreDrop)                                    │
│         │ onGateChange(playing)                                │
│         ▼                                                      │
│   VideoStreamClient (new)                                      │
│   MediaSource + SourceBuffer ──► <video>                       │
│         │  WS control: pause/resume (gate), pull (credits)     │
└─────────┼──────────────────────────────────────────────────────┘
          │ WebSocket  /stream/{lecture_id}  (binary chunks + JSON)
          ▼
┌─ Backend (FastAPI) ────────────────────────────────────────────┐
│  GET /stream/{lecture_id}/info → { mimeCodec, size }           │
│  WS  /stream/{lecture_id}      → per-connection pump:          │
│      send next chunk  iff  gate==open AND credits>0 AND !EOF   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Backend — streaming module (`backend/app/stream.py`, new)

### 5.1 Endpoints

- `GET /stream/{lecture_id}/info` → `{ "mimeCodec": "video/mp4; codecs=\"...\"", "size": <bytes> }`.
  The client uses `mimeCodec` to construct the `SourceBuffer`; hardcoding it would break on
  a different source video.
- `WS /stream/{lecture_id}` — bidirectional streaming connection (protocol in §5.2).

For v1 there is a single configured video, served for any `lecture_id`. The path parameter is
kept so per-lecture videos can be added later without an API change.

### 5.2 WebSocket protocol

**Client → server (text JSON control frames):**
- `{"type":"pull","n":<int>}` — grant `n` credits (client can accept `n` more chunks). Backpressure.
- `{"type":"pause"}` — engagement gate closed (student not attentive). Stop sending.
- `{"type":"resume"}` — engagement gate open. Resume sending.

**Server → client:**
- **binary frame** — a media chunk. The fragmented MP4 is sent in file order (init segment
  `ftyp`+`moov` first, then `moof`/`mdat` fragments), so the client can append chunks in
  arrival order without box-boundary alignment.
- `{"type":"eof"}` — file exhausted; client calls `MediaSource.endOfStream()`.
- `{"type":"error","message":<str>}` — fatal; client tears down and surfaces the error.

**Pump rule (per connection):** maintain `gate` (open/closed, default open) and `credits`
(int, default 0). Loop: while `gate==open AND credits>0 AND not EOF`, read the next chunk
(default **128 KB**), send it as a binary frame, decrement `credits`. When blocked, `await`
an `asyncio.Event` that is set whenever a control frame arrives. File reads use
`loop.run_in_executor` (or `aiofiles`) so a large read never blocks the event loop.

Backpressure and the gate compose naturally: a paused `<video>` stops draining its buffer,
so the client stops issuing `pull` credits — and the explicit `pause` frame stops the pump
even if credits remain.

### 5.3 Config (`backend/app/config.py`)

Implemented (video provisioning — see §5.4):
- `VIDEO_SOURCE_URL` — env, source fetched on first run. Default the Blender
  `bbb_sunflower_1080p_60fps_normal.mp4.zip` (1080p60 H.264, ~355 MB `.zip`).
- `VIDEO_CACHE_DIR` — env, where the download + fragmented output are cached. Default
  `BASE_DIR/media` (gitignored).
- `VIDEO_PATH` — env, the stream-ready fragmented MP4. Default `VIDEO_CACHE_DIR/lecture.mp4`.
  If it already exists, provisioning is skipped.

Added with the stream module (§5.1–5.2), not yet implemented:
- `VIDEO_MIME_CODEC` — MSE codec string returned by `/info` (a sensible default,
  overridable; may be probed via `ffprobe`).
- `STREAM_CHUNK_BYTES` — default `131072` (128 KB).

`app/main.py` registers the stream router **before** the SPA static mount (same ordering
constraint as the existing routers).

### 5.4 Video provisioning (`backend/app/video.py`, new) — implemented

The video is **not committed to git** (that was the LFS/large-file problem). It is
provisioned two ways, both landing a stream-ready **fragmented** MP4 at `VIDEO_PATH`:

- **Build time (Docker):** the Dockerfile installs `ffmpeg`/`curl`/`unzip`, and a
  `RUN curl` step downloads `VIDEO_SOURCE_URL`, unzips it, and fragments it with
  `ffmpeg -c copy -movflags frag_keyframe+empty_moov+default_base_moof`. The image ships
  ready to stream.
- **Runtime (native/local, or a wiped ephemeral host):** `ensure_video()` runs on startup
  as a **non-blocking** background task and does the same when `VIDEO_PATH` is missing —
  download → (unzip if `.zip`) → fragment. Idempotent, lock-guarded, atomic (`.part` →
  rename). A failure is non-fatal: only streaming is affected.

ffmpeg is resolved by `_ffmpeg_bin()`: `FFMPEG_BINARY` env → system `ffmpeg` on PATH
(Docker's apt install) → the static binary from the `imageio-ffmpeg` pip package (so local
runs need no system ffmpeg). If `-c copy` can't mux the source audio into MP4, it retries
re-encoding audio to AAC.

Verified offline in `backend/tests/test_video.py` (stdlib `unittest`, no network): a tiny
clip served over `file://` drives the real `ensure_video()`, and the output is asserted to
be a fragmented MP4 (`moof` present).

---

## 6. Frontend — `VideoStreamClient.ts` (new, `transport/`)

Owns the MSE machinery, decoupled from engagement logic:

- Fetches `/stream/{lecture_id}/info`, checks `MediaSource.isTypeSupported(mimeCodec)`; if
  false, surfaces a clear unsupported-browser error and stops.
- Creates a `MediaSource`, sets `video.src = URL.createObjectURL(mediaSource)`, and on
  `sourceopen` adds a `SourceBuffer(mimeCodec)`.
- Opens `WS /stream/{lecture_id}`. Binary frames enter an **append queue**; only one
  `appendBuffer` is in flight at a time (next append fires on `updateend`).
- **Credit policy:** grants an initial burst (fill ~target buffer), then after each
  `updateend` sends `{"type":"pull","n":1}` while `buffered_ahead < TARGET_BUFFER_SECONDS`
  (default 15 s).
- Exposes `pause()` / `resume()` (called by the gate) that send the corresponding control
  frame **and** pause/play the `<video>` element.
- On `{"type":"eof"}` → `endOfStream()`. On socket error/close → error callback.

---

## 7. Frontend — playback gate (in `EngagementMonitor.ts`)

The gate lives inside `EngagementMonitor` because it already has every signal each tick. A
new `onGateChange(playing: boolean)` callback is emitted on transitions only.

### 7.1 Decision

```
attentive = NOT ( lookAway  OR  scoreDrop )
```

- **camera mode:** `lookAway = (face_present < FACE_MIN) OR (gaze_on_screen < GAZE_PAUSE)`
- **behavioral-only mode:** `lookAway = (tab_visible < 1) OR (window_focused < 1)`
- **both modes:** `scoreDrop = (E_smoothed < E_PAUSE)`

### 7.2 Hysteresis + debounce (anti-flicker)

Separate enter/exit thresholds and time windows:

| Constant | Default | Meaning |
|---|---|---|
| `FACE_MIN` | 0.5 | below → face considered absent |
| `GAZE_PAUSE` | 0.35 | gaze below → looking away |
| `GAZE_RESUME` | 0.50 | gaze must exceed to be "looking" again |
| `E_PAUSE` | 0.40 | score below → disengaged |
| `E_RESUME` | 0.50 | score must exceed to re-engage |
| `PAUSE_DEBOUNCE_MS` | 1500 | not-attentive must hold this long before pausing |
| `RESUME_DEBOUNCE_MS` | 500 | attentive must hold this long before resuming |

Evaluated on the per-frame tick (~30 Hz) using the current-frame face/gaze and the latest
smoothed `E`. Debounce timers convert momentary glances into no-ops.

### 7.3 Status surfacing

`StatusIndicator` gains a playback state — `▶ playing` vs `⏸ looking away` — so the pause is
legible rather than mysterious. (This also gives `StatusIndicator.setOff()`, currently dead,
a real purpose.)

---

## 8. Frontend — multi-camera picker

- Enumerate `navigator.mediaDevices.enumerateDevices()`, filter `kind === 'videoinput'`.
  **Picker is shown only when ≥ 2 video inputs exist.**
- **Consent dialog** (`ConsentDialog.ts`): a `<select>` of cameras. Device *labels* are only
  populated after permission is granted, so pre-grant entries show as `Camera 1 / Camera 2`.
  `showConsentDialog()` currently returns `Promise<Mode>`; its return type changes to
  `Promise<{ mode: Mode; deviceId?: string }>` so the chosen `deviceId` plumbs through
  `main.ts` → `MonitorOptions` → `getUserMedia({ video: { deviceId: { exact } } })`.
- **Status bar** (`StatusIndicator.ts`): the same dropdown, injected into the existing
  `#status` pill at runtime (the class already grabs `#status-*` nodes and builds DOM, so no
  `index.html` change is required). Selecting a new camera calls a new
  `EngagementMonitor.setCamera(deviceId)` that hot-swaps the track (stop old tracks →
  `getUserMedia` new device → reattach to the offscreen `<video>`) without tearing down the
  pipeline or the video stream.
- Chosen `deviceId` persisted in `localStorage` (`preferredCameraId`) and reused next session.

---

## 9. Wiring (`main.ts`)

- Remove the hardcoded external `video.src` ([main.ts:75-78](frontend/src/main.ts) — currently
  the deleted `BigBuckBunny_640x360.m4v` URL).
- Instantiate `VideoStreamClient` against `API_ENDPOINTS.stream(lectureId)` /
  `API_ENDPOINTS.streamInfo(lectureId)` (new entries in `src/config.ts`, mirroring the
  existing `live()` http→ws helper) and attach it to the `#lecture-video` element.
- `VideoStreamClient` must be created **before** the `EngagementMonitor` so `onGateChange`
  can call `client.pause()/resume()`.
- Keep the existing consent → mode → monitor → EventSender flow; thread the picker's
  `deviceId` into `MonitorOptions` and add camera selection into it.

---

## 10. Documentation updates (D5)

- **README.md:**
  - Update the architecture diagram to include `/stream` WS, MSE, and the playback gate.
  - Add the new files to the repo-layout tree.
  - Add to **API Surface**: `GET /stream/{lecture_id}/info` and `WS /stream/{lecture_id}`
    (with the control-frame protocol).
  - Add a **Video setup** subsection under Running It: `fragment_video.sh`, `VIDEO_PATH`,
    `VIDEO_MIME_CODEC`.
  - Note the new behavior in the intro/feature list (backend-streamed, attention-gated,
    multi-camera) and the v1 scope limits from §3.
- **MATH.md:**
  - New section (e.g. **§7.4 Playback gate**) deriving the gate boolean, the enter/exit
    thresholds, the hysteresis rationale, and the debounce windows — consistent with the
    document's promise to derive every number the system computes. Cross-reference the
    behavioral-only substitution (§2, §7.1).

---

## 11. Config / env summary

| Var | Where | Default | Purpose |
|---|---|---|---|
| `VIDEO_SOURCE_URL` | backend | Blender BBB 1080p60 `.zip` | source fetched on first run |
| `VIDEO_CACHE_DIR` | backend | `media` | download + fragmented-output cache |
| `VIDEO_PATH` | backend | `media/lecture.mp4` | stream-ready fragmented MP4 (skip provision if present) |
| `FFMPEG_BINARY` | backend | (auto) | override ffmpeg path; else PATH, else imageio-ffmpeg |
| `VIDEO_MIME_CODEC` | backend | (with stream module) | MSE codec string for `/info` |
| `STREAM_CHUNK_BYTES` | backend | `131072` | chunk size |
| `TARGET_BUFFER_SECONDS` | frontend const | `15` | how far ahead to buffer |
| gate thresholds | frontend const | see §7.2 | pause/resume tuning |

---

## 12. Testing strategy

- **Backend (`pytest`, new):** unit-test the pump as a pure state machine over a fake socket
  — assert no chunk sent while `gate==closed`, none sent without credits, EOF emitted at end,
  credit decrement. Test `/info` returns configured codec + real file size.
- **Frontend (`vitest`, new):** `PlaybackGate` extracted enough to test as a pure unit —
  feed timed feature sequences, assert transition timing honors debounce + hysteresis in both
  modes. `VideoStreamClient` append-queue/credit logic tested against a mock `SourceBuffer`.
- **Manual e2e:** run app → video streams and plays → look away ≥1.5 s → pauses and server
  stops sending → look back → resumes; toggle behavioral-only → tab-hide pauses; with 2
  cameras → picker appears, switching hot-swaps the feed without dropping playback.

> Note: the repo currently has no test tooling. This introduces `pytest` (backend) and
> `vitest` (frontend). `make typecheck` remains the fast gate.

---

## 13. Files touched

**New**
- `backend/app/video.py` — video provisioning (download + fragment) ✅ done
- `backend/tests/test_video.py` — offline provisioning test ✅ done
- `backend/app/stream.py` — gated WebSocket + `/info` ✅ done
- `backend/tests/test_stream.py` — WebSocket pump integration test ✅ done
- `frontend/src/transport/VideoStreamClient.ts` (pending)

**Edited**
- `backend/app/config.py` — video config + `STREAM_CHUNK_BYTES`/`VIDEO_MIME_CODEC` ✅ done
- `backend/app/main.py` — provision video on startup (background) + register stream router ✅ done
- `backend/requirements.txt` — `imageio-ffmpeg` for local ffmpeg ✅ done
- `Dockerfile` — install `ffmpeg`/`curl`/`unzip`; build-time download + fragment ✅ done
- `.gitignore` — ignore `*.mp4`/`*.m4v`/`backend/media/` ✅ done
- `frontend/src/engagement/EngagementMonitor.ts` — playback gate + `onGateChange` + `setCamera` + `deviceId` option
- `frontend/src/config.ts` — `stream()` + `streamInfo()` endpoints
- `frontend/src/ui/ConsentDialog.ts` — camera picker; return type → `{ mode, deviceId? }`
- `frontend/src/ui/StatusIndicator.ts` — camera picker + playback state
- `frontend/src/main.ts` — wire streaming + gate + picker; drop external URL
- `README.md`, `MATH.md` — documentation (§10)
