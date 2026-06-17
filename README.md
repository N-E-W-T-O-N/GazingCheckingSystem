---
title: GazingEngageMent
emoji: 👀
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Browser-side engagement detection for video lectures.
---

# GazingEngageMent

A privacy-respecting engagement detection layer for a video lecturing system.

The camera-side perception runs entirely in the browser using MediaPipe Tasks Vision. Only small numeric feature vectors leave the user's machine. The backend ingests those vectors, persists them in SQLite, and serves a live instructor dashboard plus per-session reports.

> **Read `MATH.md`** for full derivations of every signal computed by this system, plus a numbered inventory of every assumption it makes.

---

## Signal Priority (per project brief)

| Tier | Signals | Status in v1 |
|---|---|---|
| Priority | Visual attention: face presence, head pose, gaze heuristic, tab visibility, window focus, input activity | **Implemented** |
| Mid | Affect from facial blendshapes | Schema reserved (`affect: null`), classifier stub |
| Good-to-have | Drowsiness (EAR + PERCLOS) | Schema reserved (`drowsiness: null`) |

The fusion model (`ScoreFusion.ts` + `MATH.md §7`) collapses the visual-attention bundle into a single `E ∈ [0,1]` engagement score per frame.

---

## Camera-Aware Onboarding

The brief says: *camera is needed but may not be provided — need to tell beforehand.* The flow is:

1. **Pre-flight probe** on first page load: check `navigator.mediaDevices.getUserMedia`, query the camera permission state, never auto-prompt.
2. **Consent dialog** explains exactly what is computed locally vs. what is sent. The user picks one of:
   - **Allow camera** → full visual-attention pipeline.
   - **Behavioral-only mode** → tab/focus/activity signals only, no video access requested.
3. **Status indicator** is always visible while a lecture is in progress, showing camera state and last engagement score. The indicator has a one-click pause.

If the user previously denied permission, the system refuses to silently retry and instead surfaces a clear "camera was blocked at the OS or browser level — here's how to re-enable" panel.

---

## Architecture

```
┌────────────────────────────── Browser ──────────────────────────────┐
│                                                                     │
│   Webcam ──► MediaPipe FaceLandmarker (WebGL/WebGPU)                │
│                       │                                             │
│                       ▼                                             │
│   Page Visibility  ─► FeatureEmitter (1 Hz)                         │
│   Window Focus     ──┘    │                                         │
│   Mouse/Keyboard   ───────┤                                         │
│                           ▼                                         │
│                     ScoreFusion ──► smoothed E_t                    │
│                           │                                         │
│                           ▼                                         │
│                     EventSender (POST /ingest, batched)             │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ JSON over HTTPS
                                  ▼
┌────────────────────────────── Backend (FastAPI) ────────────────────┐
│   POST /ingest          ──► SQLite (SQLAlchemy)                     │
│   GET  /sessions/{id}/report                                        │
│   WS   /live/{lecture_id} ──► instructor dashboard                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Repo Layout

```
GazingEngageMent/
├── README.md
├── MATH.md
├── Makefile
├── .gitignore
├── .dockerignore
├── .devcontainer/
│   ├── devcontainer.json
│   ├── docker-compose.yml
│   └── Dockerfile
├── backend/
│   ├── requirements.txt
│   ├── run.sh
│   └── app/
│       ├── main.py          ← FastAPI app, CORS, routes
│       ├── db.py            ← SQLAlchemy engine + session
│       ├── models.py        ← Session, EngagementEvent ORM
│       ├── schemas.py       ← Pydantic request/response models
│       ├── ingest.py        ← POST /ingest + WS /live broadcaster
│       ├── reports.py       ← GET /sessions/{id}/report
│       └── config.py
└── frontend/
    ├── index.html           ← demo SPA: video player + monitor
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/
        ├── main.ts          ← bootstraps the demo
        ├── engagement/
        │   ├── types.ts
        │   ├── FaceProcessor.ts        ← MediaPipe FaceLandmarker wrapper
        │   ├── HeadPose.ts             ← rotation matrix → Euler
        │   ├── GazeHeuristic.ts        ← iris offset + head pose
        │   ├── BehavioralSignals.ts    ← visibility, focus, input
        │   ├── ScoreFusion.ts          ← weighted-logistic + EMA
        │   └── EngagementMonitor.ts    ← orchestrator
        ├── ui/
        │   ├── ConsentDialog.ts
        │   ├── StatusIndicator.ts
        │   └── DebugOverlay.ts
        └── transport/
            └── EventSender.ts
```

---

## Running It

### Option A — Devcontainer (recommended)

The project ships with a VS Code-compatible devcontainer that contains both Python 3.12 and Node 20. Crucially, `backend/.venv` and `frontend/node_modules` are mounted as **named Docker volumes**, so they exist inside the container but never appear in your project folder on the host.

If you use VS Code, the "Reopen in Container" command picks up `.devcontainer/devcontainer.json` automatically and runs `make install` on first build.

If you'd rather drive Docker by hand, the Makefile wraps everything:

```bash
make container-up        # build + start the container in the background
make container-shell     # bash into it
# inside the container:
make dev                 # backend (:8000) + frontend (:5173) together
```

Open http://localhost:5173. Grant camera permission when the consent dialog appears, or click "Continue without camera" for behavioral-only mode. The page contains a placeholder lecture video, the engagement status indicator, and a debug overlay showing live per-signal values so you can visually verify the math from `MATH.md §8`.

To wipe the dependency volumes and start fresh:

```bash
make container-reset
```

### Option B — Native (no Docker)

#### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

This creates `engagement.db` (SQLite) in the backend folder on first run.

#### Frontend demo SPA

```bash
cd frontend
npm install
npm run dev
```

### Option C — Hugging Face Spaces (Docker SDK)

The repo root contains a multi-stage `Dockerfile` and the README YAML frontmatter Spaces needs. Push the repo to a new Docker-SDK Space and it builds automatically:

```bash
# create a new Docker space at https://huggingface.co/new-space (SDK: Docker)
git remote add space https://huggingface.co/spaces/<your-username>/<space-name>
git push space main
```

What the build does:

1. Stage 1 (`node:20`) runs `npm ci && npm run build`, producing `frontend/dist/`.
2. Stage 2 (`python:3.12-slim`) installs `backend/requirements.txt`, copies the backend source and the built SPA, and starts uvicorn on port 7860.
3. FastAPI mounts the SPA at `/` (only when `STATIC_DIR` exists), so the API at `/ingest`, `/sessions/...`, and `/live/{lecture_id}` share the origin with the frontend. CORS, mixed-content, and getUserMedia issues disappear because HF serves the Space over HTTPS.

**Storage policy.** SQLite lives inside the container's writable layer. It resets whenever the Space rebuilds or restarts — that is intentional. If you ever need durability, either enable HF Persistent Storage and point `DB_PATH` at `/data/engagement.db`, or swap the SQLAlchemy URL to a hosted DB (Turso / Neon).

To build and run the image locally exactly as Spaces will:

```bash
docker build -t gazing-engagement .
docker run --rm -p 7860:7860 gazing-engagement
# open http://localhost:7860
```

### Makefile cheatsheet

Run `make help` to list every target. The most common ones:

| Target | Where | Purpose |
|---|---|---|
| `make container-up` | host | Build and start the devcontainer |
| `make container-shell` | host | Open bash inside the container |
| `make container-reset` | host | Recreate the named volumes (wipes deps + DB) |
| `make container-down` | host | Stop the container (keeps volumes) |
| `make install` | container | Install backend + frontend deps |
| `make dev` | container | Run backend and frontend together |
| `make backend` | container | Backend only |
| `make frontend` | container | Frontend only |
| `make typecheck` | container | `tsc --noEmit` + Python `compileall` |
| `make clean` | container | Remove build artifacts (not deps) |

---

## API Surface

### `POST /ingest`

Accepts a batch of per-second engagement events.

```json
{
  "session_id": "uuid-...",
  "lecture_id": "lec-101",
  "user_id": "kumar.amit@dotsquares.com",
  "mode": "camera" | "behavioral_only",
  "events": [
    {
      "t": 1716623400.0,
      "score": 0.91,
      "features": {
        "face_present": 1,
        "head_aligned": 0.87,
        "gaze_on_screen": 0.66,
        "tab_visible": 1,
        "window_focused": 1,
        "input_activity": 0.15
      },
      "affect": null,
      "drowsiness": null
    }
  ]
}
```

### `GET /sessions/{session_id}/report`

Returns aggregate stats for the session — `mean_E`, `percent_attentive`, `percent_disengaged`, `longest_drop_seconds`.

### `WS /live/{lecture_id}`

Server pushes `{user_id, score, t}` messages to subscribed instructor clients as ingest events arrive.

---

## Privacy and Ethics

- All face analysis is computed **on-device**. Raw video never leaves the browser.
- Only feature vectors (six floats per second) are transmitted.
- The user can switch to behavioral-only mode at any time.
- The score must not be used for grading or punitive action. See `MATH.md §10` and Appendix B for the explicit limits of what this system can know.

---

## Next Steps

1. Wire the `affect` classifier into `FaceProcessor.ts` (uses blendshapes already retrieved by MediaPipe — see `MATH.md §A2`).
2. Add EAR + PERCLOS for drowsiness (`MATH.md §A1`).
3. Replace the hand-tuned fusion weights with a logistic regression trained on student self-reports.
