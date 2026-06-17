# MATH.md — The Math Behind GazingEngageMent

This document derives every number the system computes, in order, so that anyone reading the code can trace a single frame from raw pixels to an engagement score and know exactly which assumption is being relied on at each step.

The system is structured as a *cascade*: each stage takes the output of the previous stage and refines it. If a stage fails (no face, low confidence, missing camera), all downstream stages either fall back to a degraded estimate or are skipped, and the fusion stage reweights what remains.

---

## 1. Notation and the Assumption Flow

We use the following symbols throughout.

| Symbol | Meaning |
|---|---|
| `I_t` | The image frame at time `t` |
| `L_t = {p_i ∈ R^2}` | The set of 2D facial landmarks detected in `I_t` |
| `M = {P_i ∈ R^3}` | The canonical 3D face model (MediaPipe ships this) |
| `K` | The 3×3 camera intrinsic matrix |
| `R, t` | Head rotation (3×3) and translation (3×1) in camera coordinates |
| `(α, β, γ)` | Euler angles: yaw, pitch, roll (radians) |
| `EAR_t` | Eye Aspect Ratio at time `t` |
| `g_t` | Gaze direction unit vector |
| `b_t` | Tab/window visibility, focus, mouse, keyboard signals |
| `f_t ∈ R^d` | The full feature vector for frame `t` |
| `E_t ∈ [0,1]` | The engagement score at time `t` |

### Assumption flow (what each stage believes about the world)

```
Stage 0  Camera present and authorized    ─┐
Stage 1  Exactly one face in the frame     │  if any fail → fall back
Stage 2  Landmark confidence > 0.5         │  or skip the stage and
Stage 3  Calibrated head-pose extraction   │  reweight in fusion
Stage 4  Head pose ≈ visual attention      │
Stage 5  Visual attention ≈ engagement     ─┘
```

Each downstream conclusion is *only as strong as the weakest upstream assumption*. The fusion stage (§7) is the only place where we collapse this cascade into a single number, so that is where we are most explicit about uncertainty.

---

## 2. Stage 0 — Camera Availability and Consent

Before any math runs, we check three boolean predicates in the browser:

1. `navigator.mediaDevices.getUserMedia` exists (modern browser).
2. The user has not previously denied camera permission for this origin (`navigator.permissions.query({name:'camera'})`).
3. The user actively grants permission this session via an explicit dialog.

If any predicate is false we enter **behavioral-only mode**. In that mode the cascade skips stages 1–6 and feeds a degraded feature vector to fusion (§7). The fusion weights for camera-derived features are zeroed and the remaining weights are renormalized so they still sum to 1.

This is important: a missing camera does not break the system, it produces a confidence-discounted score and a flag (`mode: "behavioral-only"`) the dashboard can show to the instructor.

---

## 3. Stage 1 — Face Detection and Landmarks

MediaPipe's `FaceLandmarker` outputs:

- `landmarks`: 478 normalized 2D points `(u, v) ∈ [0,1]^2`
- `facialTransformationMatrixes`: a 4×4 matrix `T` mapping the canonical 3D face model into camera space
- `blendshapes`: 52 ARKit-style coefficients in `[0,1]`

We use the matrix `T` directly and skip OpenCV's `solvePnP` (because it has already been solved for us, more accurately, by the temporal-coherent neural model). The PnP math is included below for completeness — it is what MediaPipe is doing inside.

### 3.1 The Perspective-n-Point (PnP) problem (for reference)

Given:
- N image points `p_i = (u_i, v_i)`
- The same N points in 3D model coordinates `P_i = (X_i, Y_i, Z_i)`
- The camera intrinsic matrix

```
K = [ f_x   0   c_x ]
    [  0   f_y  c_y ]
    [  0    0    1  ]
```

we want `R ∈ SO(3)` and `t ∈ R^3` such that for every `i`:

```
s_i · [u_i, v_i, 1]ᵀ  =  K · [R | t] · [X_i, Y_i, Z_i, 1]ᵀ
```

where `s_i` is an unknown per-point scale (depth). Stacking these equations and minimizing the reprojection error gives a non-linear least-squares problem:

```
(R*, t*)  =  argmin_{R, t}   Σ_i  ‖ π(K · (R P_i + t)) − p_i ‖²
```

where `π(x, y, z) = (x/z, y/z)`. Classical solvers (EPnP, Iterative-LM, P3P + RANSAC) reach this minimum in a few milliseconds per frame.

### 3.2 What we actually do

```
T  =  facialTransformationMatrixes[0]    // 4×4 row-major
R  =  T[0:3, 0:3]                         // upper-left 3×3
t  =  T[0:3, 3]                           // last column
```

---

## 4. Stage 2 — Euler Angles (Yaw, Pitch, Roll)

Given the rotation matrix:

```
R = [ r11  r12  r13 ]
    [ r21  r22  r23 ]
    [ r31  r32  r33 ]
```

we extract Euler angles using the **ZYX (yaw-pitch-roll) Tait–Bryan convention**:

```
pitch = atan2( −r31,  √(r32² + r33²) )       // up/down nod
yaw   = atan2(  r21,  r11 )                  // left/right turn
roll  = atan2(  r32,  r33 )                  // head tilt
```

**Gimbal lock check.** When `cos(pitch) → 0` (pitch ≈ ±π/2), yaw and roll become indistinguishable. We test `√(r32² + r33²) < 10⁻⁶` and if so set `yaw = atan2(−r12, r22)` and `roll = 0`. In practice a student looking 90° up or down is "not engaged" anyway, so this case is rare and benign.

### 4.1 "Head-aligned" boolean

We define a soft indicator that the head is oriented toward the screen:

```
head_aligned(t)  =  exp( − ( yaw² / σ_y² + pitch² / σ_p² ) )
```

with `σ_y = 25°` and `σ_p = 20°` (converted to radians). This is a 2D Gaussian over the angular deviation; it is smooth (no threshold cliffs), bounded in `[0, 1]`, and falls off the way a person's frustum of attention actually falls off.

---

## 5. Stage 3 — Gaze Heuristic (No-Calibration)

We avoid per-user WebGazer calibration in v1 (it adds onboarding friction the user asked us to avoid). Instead we estimate gaze coarsely from two cues:

1. **Iris offset** inside the eye socket (MediaPipe gives iris landmarks 468–477).
2. **Head pose** from §4.

### 5.1 Iris offset

For each eye define the eye-socket center `c_eye` as the midpoint of the inner and outer eye corners, and the iris center `c_iris` as the centroid of the four iris landmarks. The normalized offset is:

```
o = (c_iris − c_eye) / w_eye
```

where `w_eye = ‖p_outer − p_inner‖` is the eye width. Average the left and right `o` vectors:

```
o_avg = (o_left + o_right) / 2
```

This is a 2D vector roughly proportional to where the eye is pointing inside its socket.

### 5.2 Combining iris offset with head pose

We treat the eye gaze as additive to head orientation in a small-angle approximation:

```
g_x  =  yaw   + k · o_avg.x
g_y  =  pitch + k · o_avg.y
```

with `k ≈ 1.5 rad/unit-offset` (empirically). This gives a coarse gaze direction in screen-relative angles.

### 5.3 "Gaze-on-screen" indicator

The screen subtends some angular half-width `θ_x` and half-height `θ_y` at the viewer's eye. For a 15-inch laptop at 60 cm, these are roughly 15° and 9°. We use the same soft-Gaussian shape:

```
gaze_on_screen(t)  =  exp( − ( g_x² / θ_x² + g_y² / θ_y² ) )
```

This degrades gracefully as the user glances away rather than flipping at a hard boundary.

---

## 6. Stage 4 — Behavioral Signals

These are zero-cost, robust, and used as both a primary signal (when no camera) and as a confidence anchor when the camera is on.

### 6.1 Tab visibility

`v_t = 1` if `document.visibilityState === 'visible'`, else `0`. We aggregate as a rolling fraction over a 10 s window.

### 6.2 Window focus

`w_t = 1` if `document.hasFocus()`, else `0`. Distinct from visibility — a visible tab can be unfocused if another window is on top.

### 6.3 Input activity

For mouse and keyboard we maintain an exponentially-decaying activity score:

```
a_t  =  λ · a_{t−1}  +  (1 − λ) · 𝟙{event in [t−1, t]}
```

with `λ = exp(−Δt / τ)` and `τ = 20 s`. This is just a 1st-order IIR low-pass filter. Activity is *not* required for engagement (students legitimately watch passively), but **prolonged total inactivity combined with low visibility is a strong "user walked away" indicator.**

---

## 7. Stage 5 — Score Fusion

We collect the per-frame feature vector:

```
f_t  =  [ face_present, head_aligned, gaze_on_screen, v_t, w_t, a_t ]
```

Each component is already in `[0, 1]`. We compute the engagement score as a **weighted logistic combination**:

```
z_t  =  Σ_k  w_k · f_t,k   −   b
E_t  =  σ(z_t)  =  1 / (1 + e^{−z_t})
```

Default v1 weights (visual attention bundle, per the priority you set):

| Feature | Weight | Why |
|---|---|---|
| `face_present` | 1.2 | Strong necessary signal; if zero, others are unreliable |
| `head_aligned` | 1.6 | The single most informative camera signal |
| `gaze_on_screen` | 1.4 | Refines head pose |
| `tab_visible` | 1.2 | Cheap and binary-ish, hard veto on disengagement |
| `window_focused` | 0.8 | Often redundant with visibility |
| `input_activity` | 0.4 | Helpful but noisy |
| bias `b` | 2.5 | Centers `E ≈ 0.5` at a "borderline" student |

These can be relearned from labeled data later (sklearn logistic regression on session features paired with self-report Likert scores).

### 7.1 Behavioral-only fallback

When `face_present` is unavailable (no camera) we set the three camera-derived weights to zero and renormalize the remaining weights to preserve the sum. The resulting score still ranges in `[0, 1]` but is *labeled with `mode: behavioral_only`* so the UI can show reduced confidence.

### 7.2 Temporal smoothing

Raw `E_t` is noisy at 30 Hz. We smooth with an exponential moving average:

```
Ẽ_t  =  α · E_t  +  (1 − α) · Ẽ_{t−1}
```

For a 1 Hz dashboard update with a ~5 s effective time constant, `α ≈ 0.2`. This is the value sent to the backend.

### 7.3 Session-level aggregates

The backend computes for each session:

```
mean_E         =  (1/N) Σ_t Ẽ_t
percent_attentive  =  (1/N) Σ_t  𝟙{Ẽ_t > 0.6}
percent_disengaged =  (1/N) Σ_t  𝟙{Ẽ_t < 0.3}
longest_drop   =  max contiguous run of Ẽ_t < 0.3, in seconds
```

`longest_drop` is the single most actionable instructor metric — a 90-second drop usually indicates the student left or fell asleep, while a chain of 5-second drops indicates normal note-taking.

---

## 8. End-to-End Worked Example

Suppose at `t = 12.0 s` the browser computes:

```
yaw = 8°,   pitch = −4°,   roll = 2°
iris_offset = (0.04, 0.01)   →   g_x = 0.14 rad ≈ 8°, g_y = −0.05 rad ≈ −3°
face_present = 1
visibility = 1, focus = 1, activity = 0.15
```

Then:

```
head_aligned    =  exp(−(8² / 25² + 4² / 20²))            ≈  0.87
gaze_on_screen  =  exp(−(8² / 15² + 3² / 9²))             ≈  0.66

z   =  1.2·1 + 1.6·0.87 + 1.4·0.66 + 1.2·1 + 0.8·1 + 0.4·0.15 − 2.5
    ≈  1.2 + 1.39 + 0.92 + 1.2 + 0.8 + 0.06 − 2.5
    ≈  3.07
E   =  σ(3.07)  ≈  0.956
```

That student is highly engaged.

Now suppose three seconds later the head turns to `yaw = 40°`:

```
head_aligned    =  exp(−(40² / 25²))                       ≈  0.077
gaze_on_screen  ≈  0.10
z               ≈  1.2 + 0.12 + 0.14 + 1.2 + 0.8 + 0.06 − 2.5  ≈  1.02
E               =  σ(1.02)  ≈  0.735
```

After EMA smoothing with α = 0.2:

```
Ẽ_{t=15}  =  0.2 · 0.735  +  0.8 · 0.956  =  0.912
```

A brief glance away barely moves the smoothed score, exactly as you'd want.

---

## 9. Assumptions Inventory

Each assumption is listed with its failure mode and our mitigation.

| # | Assumption | Failure mode | Mitigation |
|---|---|---|---|
| A1 | Camera is available | No video stream | Behavioral-only mode (§2, §7.1) |
| A2 | Exactly one face | Multiple/no faces | Use the largest-bounding-box face; drop frame if none |
| A3 | Adequate lighting | Landmark drift | Confidence threshold from MediaPipe; if low, skip frame |
| A4 | Frontal camera near screen center | Yaw bias | Optional one-time "look at the camera" calibration step |
| A5 | Head pose ≈ visual attention | False (second monitor, phone) | Soft Gaussians (not thresholds); fused with activity |
| A6 | Visual attention ≈ cognitive engagement | The big one | Honest UI wording: "attention", not "engagement", to the student |
| A7 | Smoothing constants chosen well | Over-smoothing hides real drops | `longest_drop` metric is computed on un-smoothed `E_t` |
| A8 | All users' faces are in MediaPipe's training distribution | Accuracy varies across demographics | Report per-subgroup accuracy if you collect it; never use this for grading |

---

## 10. What We Are NOT Computing in v1

These are deliberately out of scope for the visual-attention v1 the user selected:

- **Drowsiness (EAR + PERCLOS).** Math is included in §A1 below for when this is added.
- **Affect / emotion.** Blendshape vector → classifier; spec in §A2 below.
- **Per-user gaze calibration.** WebGazer-style ridge regression; spec in §A3 below.

These are wired through as `null` fields in the event schema so adding them later is a backwards-compatible change.

---

## Appendix A — Math for Out-of-Scope v1.x Modules

### A1. Eye Aspect Ratio (EAR) and PERCLOS

For six landmarks around one eye (`p1` outer corner, `p2/p3` upper lid, `p4` inner corner, `p5/p6` lower lid):

```
EAR  =  (‖p2 − p6‖ + ‖p3 − p5‖)  /  (2 · ‖p1 − p4‖)
```

A blink shows up as a sharp dip from ~0.30 to ~0.05 lasting 100–300 ms. PERCLOS, the standard drowsiness metric, is the fraction of time the eye is more than 80% closed in a rolling 60 s window:

```
PERCLOS_t  =  (1/W) · Σ_{τ=t−W}^{t}  𝟙{EAR_τ < 0.2 · EAR_open}
```

with `EAR_open` the user's resting EAR (estimated from the first 10 s). `PERCLOS > 0.15` is the conventional drowsiness threshold from the U.S. DOT FHWA studies.

### A2. Affect from blendshapes

Take the 52-dim blendshape vector `s_t`, project onto a small subspace via a one-layer MLP trained on a labeled dataset (FER-2013 transfer, or in-house labels). Output is a 4-way softmax over `{neutral, confused, bored, engaged}`. Use the softmax probabilities directly as additional features in the fusion `z_t`.

### A3. WebGazer-style ridge regression

For each calibration click at screen point `(x_i, y_i)`, extract a fixed-length eye feature vector `φ_i` (flattened eye patch, downsampled). Solve:

```
W*  =  argmin_W  Σ_i  ‖ W φ_i − (x_i, y_i) ‖²  +  λ ‖W‖²
W*  =  (Φᵀ Φ + λ I)⁻¹ Φᵀ Y
```

At inference, `(x̂, ŷ) = W* φ_t`. Typical accuracy after 9-point calibration: 100–150 px. We then test whether `(x̂, ŷ)` lies inside the video player's bounding rect for a much sharper gaze-on-screen signal.

---

## Appendix B — Limits and Honest Disclaimers

Even with all of the above working perfectly, this system measures *visual attention proxies*, not engagement. Looking at the screen is necessary but not sufficient for learning. Looking away is *not* sufficient for disengagement. The score should be used for instructor feedback ("the class lost focus around slide 12") and student self-reflection, never for grading or surveillance.
