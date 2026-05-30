# Wireless Multicam Studio — Feature & UX Research

Research compiled 2026-05-28. Two parallel research streams (market/competitive landscape + UX walkthrough of the current product) plus an additional section on optional operator authentication, framed for the small-church-with-low-budget use case.

Stack assumed throughout: vanilla HTML/JS device PWA + operator dashboard, Node control service over WebSocket, MediaMTX for WHIP/WHEP, FFmpeg for export, mkcert for TLS. No framework. Runs offline on a LAN. Windows-first.

---

## 0. TL;DR — the ten things worth shipping next

Ranked by impact-on-the-small-church-volunteer per unit of effort.

| # | Feature | Why it matters | Complexity |
|---|---|---|---|
| 1 | **Sunday mode** — single-screen wizard, one giant button per state | Deacon Bob (the substitute volunteer) can run a service end-to-end without training | Medium |
| 2 | **Post-session Whisper transcript + SRT/VTT** (`whisper.cpp small.en`) | Captions + searchable sermon archive + podcast-ready text. The single biggest credibility-and-utility ROI | Medium |
| 3 | **Persistent health strip** replacing the manual `Pre-flight` button | Volunteers never click pre-flight; passive surface earns trust | Low |
| 4 | **Markers (`M` key) + chapter sidecar in export** | Sermon points / song changes / prayer → YouTube chapters. Highest-leverage post-production add | Medium |
| 5 | **Optional operator auth** (single-tenant PIN/passphrase + bearer token) — see §10 | Closes the LAN-trust hole without enterprise complexity; one-checkbox install | Low–Medium |
| 6 | **Tally-light on device page when "on air"** | Phone-holders behave differently when they know they're being shown — better footage | Low |
| 7 | **Vertical 9:16 "sermon clip" export** (15–90s, captioned) | Replaces a $20–100/mo SaaS category (Choppity, ChurchSocial) | Medium |
| 8 | **Mobile "director" view** via `@media (max-width: 720px)` | Unlocks team-of-two: tech lead at the back of the room on a tablet | Medium |
| 9 | **VAD-on-mics → "switch suggestion" overlay** (Silero VAD on existing audio sources) | Surprising-good. Operator gets a ghost hint "Pastor John's mic is hot — take cam 2" | Medium |
| 10 | **Confidence monitor** at `/confidence` URL — big clock, countdown, "wrap up in 3:00" | Earns the tool a permanent spot at the church. Tiny build | Low |

Things to **not** build: built-in donation processing, native live-RTMP switching, animated lower-thirds, pyannote-style diarization, replace-ProPresenter ambition. Stay narrow.

---

## 1. Competitive landscape (small-church reality)

### 1.1 Where each tool lives

| Tool | Wins for small churches | Falls short |
|---|---|---|
| **OBS Studio** | Free; massive tutorial corpus; ProPresenter via NDI/Syphon works | Single-PC encoder; multi-USB-camera setups regularly fail (USB bus saturation); volunteer-hostile UX ("[Why Is OBS So Garbage & Complicated?](https://obsproject.com/forum/threads/why-is-obs-so-garbage-complicated.100669/)" is a real forum thread); dropped-frame anxiety endemic on a 3-cam + ProPresenter NDI laptop |
| **vMix** | [Free HD license program for churches](https://www.vmix.com/purchase/churches.aspx); deep feature set; native NDI | Windows-only; $350+ otherwise; steep UI; same single-PC encode bottleneck |
| **ATEM Mini (Pro)** | $325; tactile buttons volunteers like; hardware reliability | HDMI cabling = no wireless cameras; over-saturation/contrast complaints; isn't an iso recorder |
| **ProPresenter** | Industry-standard lyrics/scripture; NDI/Syphon into OBS | Adjacent, not a competitor. $$$, Mac-leaning. Integration is fragile — "Hardwiring is best, as wireless is not always consistent" |
| **Switcher Studio** | Solved the wireless-iPhone-camera UX; volunteer-friendly | **Subscription** (~$30/mo non-profit min); **iOS-only**; ["doesn't appear to overlay graphics from worship software via NDI"](https://churchtechtoday.com/switcherstudio-review/) |
| **StreamYard** | "Passes the grandparent test"; volunteers learn in one rehearsal | Cloud-only; recurring fee; guest-style multicam, not fixed-angle |
| **BoxCast / Resi** | Turnkey, "just works", auto-archive | [Starts at $119/mo](https://www.capterra.com/p/196797/BoxCast/); aggressive upsell; churches actively migrating away on cost |
| **Reincubate Camo** | Phone-as-webcam for OBS/Zoom | Single-camera per phone; not a switcher; subscription |
| **Larix Broadcaster** | Free WHIP/RTMP from phone | "Designed for streamers who already have some technical experience"; no coordinator; iOS background mode limited to audio |
| **VDO.Ninja** | Closest analogue — free, browser WebRTC, phones, can record locally | Designed as **guest ingest into OBS**, not as LAN multi-angle iso recorder. Default routes through public infrastructure; self-hosting for true offline is non-trivial. No structured switch log or post-edit pipeline |

### 1.2 Volunteer pain points (cited)

- **Volunteer burnout / can't attend service** — "[pre-recorded streaming has no volunteer burnout… allowing A/V volunteers to actually attend worship](https://www.scrile.com/blog/live-streaming-for-churches)".
- **OBS handoff failure** — volunteers click scenes but can't configure; "[tools that are easy to learn help volunteers jump in without hours of training](https://wpstream.net/streaming-software-for-churches/)".
- **OBS dropped frames** — the #1 forum noise; "[the encoder is overloaded](https://obsproject.com/forum/threads/obs-suddenly-dropping-massive-amounts-of-frames.176889/)" on a typical church laptop with 3 USB cams + NDI + x264.
- **USB camera bus contention** — "two cheap webcams work individually but fail when both are connected simultaneously" pattern is endemic.
- **ProPresenter ↔ OBS gymnastics** — "[do not use a church wireless network that would draw on bandwidth. Hardwiring is best.](https://churchvisuals.com/article/how-to-use-obs-and-pro-presenter-together-for-your-online-stream/)" Transparency/alpha "doesn't always work, you get the whole screen."
- **Subscription fatigue** — Resi/BoxCast pricing is the loudest single complaint; entire [BoxCast vs Resi case-study series](https://www.boxcast.com/case-studies/tag/boxcast-vs-resi) exists around churches who quit.

### 1.3 The gap idle-stream fills

Nobody covers all five of:
1. Offline / LAN-only (no cloud, no internet)
2. Wireless phone cameras as first-class citizens, no app install
3. Lossless per-angle iso recording (no encoder bottleneck)
4. Free + open source + no subscription
5. Coordinator UX (operator arms, switches, logs) — not "every phone on its own"

VDO.Ninja gets #2 and #4 but fails the rest. Switcher Studio gets #2 and #5 but fails #1, #3, #4. OBS+NDI gets #4 but burns the laptop. **This is the real wedge.**

### 1.4 Positioning copy (steal freely)

> **Wireless Multicam Studio** — the multicam recording rig your volunteers can actually run.
>
> Bring your phones. We'll record every angle in original quality, mark which one was "on", and give you the finished cut. No capture hardware. No subscription. No cloud. Captions and a transcript on the way out.
>
> Built for small churches, conferences, schools, and anyone who got burned by OBS dropping frames at the wrong moment.

Sharpen these for the README hero:

1. **"Your laptop never encodes."** Copy-only recording.
2. **"Phones are wireless cameras. No app store. No NDI license. Open a URL."**
3. **"Every angle saved losslessly. Switch in post — or change your mind."**
4. **"Offline. Nothing leaves the LAN."** Legally meaningful for child-safeguarding churches.
5. **"No subscription. Forever."**
6. **(Future) "Captions and a transcript on your laptop, without OpenAI."**
7. **(Future) "Switch by who's speaking, not by who's clicking."**

---

## 2. Worship-tech feature wishlist (ranked by signal strength)

**Strong signal (mentioned across multiple independent sources):**

- **Lyrics/scripture overlay** — ProPresenter is the de facto standard. Don't replace it; accept an **NDI source as a camera** (the existing "screen-share is a camera" slot is conceptually most of the way there).
- **Sermon clips for socials (vertical 9:16, captioned, 30–90s)** — entire SaaS category ([Choppity](https://www.choppity.com/blog/best-sermon-short-clips-makers-generators/), ChurchSocial.ai, Sermon Studio, REACHRIGHT). Volunteers pay monthly for what idle-stream + Whisper can do locally.
- **Captions / accessibility** — sometimes mandated by denominational accessibility guidelines.
- **Multi-destination simulcast (YouTube + Facebook)** — the specific feature Resi got criticized for paywalling.
- **Sermon notes follow-along** — [Planning Center Sermon Notes](https://www.planningcenter.com/blog/2024/12/beta-launch-announcing-sermon-notes-in-planning-center) ships fill-in-the-blanks tied to mobile app.

**Medium signal:**

- **Stream Deck integration** — "[create a button that opens Planning Center directly](https://churchtechtoday.com/stream-decks-and-live-stream-controllers-a-complete-guide-for-church-staff/)". For idle-stream this is a tiny WebSocket bridge OR a documented HTTP take endpoint (`POST /api/take?cam=cam1`) that Bitfocus Companion can call. **Publish the endpoint; don't build in-app Stream Deck plumbing.**
- **Planning Center integration** — pull the service plan; mark sermon-start. Reference: [BoxCast↔Planning Center](https://www.planningcenter.com/integrations/boxcast).
- **Watch-on-demand page** — per-session HTML page with export + chapters + transcript. One-shot win after Whisper ships.
- **Audio-only podcast export** — trivial from existing mic clips + program log; surprising leverage.
- **Donation overlays** — usually handled at the platform layer; a lower-third URL/QR overlay is enough.

**Privacy-specific (high signal for European / safeguarding-conscious churches):**

- **Privacy zone masking on the wide-angle camera** — mask the kids' section. UK Church of England [GDPR guidance](https://www.churchofengland.org/resources/digital-labs/blogs/filming-and-photography-churches-consent-and-gdpr) is explicit: identifiable congregant = personal data; signed parental consent for children. A static polygon mask in the ffmpeg export covers 90% of it (no realtime face detection needed).

**Out of scope — explicitly defer:**

- Auto-switching by ProPresenter lyric-line (too coupled, will break).
- Built-in donation processing (regulated).
- Native live-RTMP switching (your plan.md already says no — keep saying it).

---

## 3. AI / Whisper opportunities (concrete, with sizing)

### 3.1 What's realistic on a church laptop

`whisper.cpp` ships a working real-time demo today:

```bash
./whisper-stream -m ggml-base.en.bin -t 8 --step 500 --length 5000
```

Samples every 0.5s, transcribes a 5s window ([source](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/README.md)). Supports sliding-window mode and VAD-driven mode (cheaper on a sermon with quiet beats).

**Model sizing:**

| Model | Size | RAM | CPU realtime factor | Recommended use |
|---|---|---|---|---|
| tiny.en | 75 MB (Q5 31 MB) | <1 GB | ~10–15× RT | Live captions on dashboard (rough, usable as a guide) |
| base.en | ~150 MB | ~1 GB | ~6–10× RT | Default for post-session transcript if speed > accuracy |
| **small.en** | **~500 MB** | **2 GB** | **~6× RT** | **Default for archive transcript / clip discovery — accuracy/speed sweet spot** |
| medium.en | ~1.5 GB | 4 GB | ~1–2× RT on CPU; comfortable on GPU | If GPU present and accuracy matters |
| large-v3 | ~3 GB | 6+ GB | ~10× RT on Apple Silicon Metal; ~12× RT on RTX 4070 (faster-whisper int8) | Overkill for typical church laptop on CPU |

**Pick whisper.cpp over faster-whisper.** Pure C/C++; bundles cleanly next to existing `tools/` binaries (ffmpeg, mediamtx, mkcert); only one with a first-class `stream` example; no Python runtime to ship. faster-whisper is ~4× faster on NVIDIA GPUs but drags in Python — not worth the dependency cost.

**Honest live-caption latency caveat:** the headline 10× numbers are batch transcription. Sliding-window live captioning carries step + window-tail latency, typically 1–2s. Fine for an operator-side guide; **not** good enough for tight burned-in lower-thirds.

### 3.2 Ranked Whisper-driven features

1. **Per-session post-recording transcript** (low risk, high value) — runs after Stop Recording. Outputs SRT + VTT + plain text. `small.en`. Ship first.
2. **Live captions overlay on operator dashboard** (medium risk, medium value) — `tiny.en` with VAD. Show to operator as guide, not burned in. Re-run with `small.en` for final SRT.
3. **Searchable sermon archive** — once #1 exists, add full-text search across transcripts in the recordings browser. "Logos for your sermons, but offline."
4. **Auto-generated highlight clips:**
   - *Cheap path*: heuristic — longest continuous speaker run via VAD, or audio-energy spikes after a pause ("Amen" peaks).
   - *Smart path*: feed transcript to local llama.cpp 7B, prompt "pick 5 most quotable 60s windows", return `[{start, end, why}]`.
5. **Multi-language subtitle burn-in** — Whisper translates any → English natively. For other directions, NLLB-200 (~600M) or llama.cpp. Burn with ffmpeg `subtitles` filter.
6. **Speaker diarization for auto-switching** — pyannote is too heavy. **Use the lighter VAD-on-mics design** (§4).
7. **Chapter markers / sermon outline detection** — pause + speaker change heuristic, or feed transcript to local LLM.

**The unsexy enabler:** add `whisper.cpp` to `tools/` next to ffmpeg, same download pattern. Model in `tools/whisper-models/`. Add `npm run setup --whisper` to fetch chosen model.

---

## 4. Adjacent local AI (realistic on a church laptop)

### 4.1 Audio cleanup — highest-impact non-Whisper add

- **[DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet)** — Rust + Python, full-band 48 kHz, real-time on CPU, <20ms latency. PESQ 3.17–3.5. Beats RNNoise on quality. **Run as offline post-process on the mic clip before export mux.**
- **RNNoise** — lighter, lower quality, Pi-friendly. Use if DFN won't fit.
- **Placement:** post-pass on **external-mic clip** before export's audio routing. **Not** in the WebRTC media path — too risky.

### 4.2 VAD-driven auto-switching (this is the surprise-good feature)

- **[Silero VAD](https://github.com/snakers4/silero-models)** — ONNX, ~1MB, tens of ms latency.
- **Design:** for each audio-only mic source (pulpit mic, lapel, handheld), run Silero VAD on PCM. Whichever mic has highest sustained speech energy → pick the camera linked to that mic (mic↔camera link already modeled). Hysteresis: don't switch faster than 1.5s; require 300ms speech before triggering.
- **Cost:** almost nothing CPU-wise. Differentiated. Surprising-good.
- **Ship as "suggestion" first.** Ghost overlay on a tile: "Pastor John's mic is hot — take cam 2?" Builds operator trust before taking the wheel. Opt into full auto later.

### 4.3 Local LLM (llama.cpp) for sermon post-processing

- **Realistic:** Q4_K_M-quantized Llama-3.1-8B or Qwen2.5-7B-Instruct at ~5–15 tok/s on modern CPU. 45-minute sermon transcript = ~5–8k tokens. Summarize in 30–60s wall-clock on a modern laptop.
- **Pipeline:** Whisper transcript → llama.cpp → JSON `{title, scripture_refs[], chapters[], pull_quotes[]}`.
- **High-leverage feature:** "Pick 5 highlight clips" → returns `[{start, end, why}]` → auto-cut to vertical 9:16 with burned captions. **This is the sermon-clip SaaS feature, run locally for free.**
- **Caveat:** small-church laptop can mean a 2017 i5 with integrated graphics. There a 7B model is painful (1–2 tok/s). **Gate LLM features behind a quick benchmark; let users opt out or point at an existing local Ollama install.**

### 4.4 Other (lower priority)

- **Loudness normalize (EBU R128)** on export — pure ffmpeg `loudnorm`, no ML. Trivial. Real value for podcast publishing.
- **RTMP encoder out** — defer. When needed, MediaMTX can re-publish a single camera to YouTube; the hard problem is the *switched* compositor, and your plan correctly defers to OBS+obs-websocket as the escape hatch.
- **Object detection for auto-framing** — possible with YOLO-nano, but phones already frame themselves. Skip.

---

## 5. Heuristic walkthrough of the current dashboard

Persona: Deacon Bob, 67, filling in for the regular A/V volunteer, ~5 min before service.

### Worst moment: the header

```
Operator · connecting… · 0 live · not recording · Layout [Auto] · Bitrate [8 Mbps] · Pre-flight · Recordings
                                          Start Preview (all) · Stop Preview · ● Record · Stop Recording
```

- **P0 — `Bitrate [8 Mbps]` in the header.** Bob has no idea what Mbps means; lowering it accidentally tanks recording quality with no warning. Move to Advanced drawer.
- **P0 — Four verbs for two outcomes.** `Start Preview (all)` + `Stop Preview` + `● Record` + `Stop Recording` is four-button mental model for one decision. `Record` is disabled if nothing is publishing — no tooltip explains why.
- **P1 — "(all)" is jargon.** Bob doesn't know preview-publishing vs preview-as-watching.
- **P1 — `not recording` muted badge** next to a red Record button reads like an instruction Bob shouldn't ignore. Negative phrasing is anxiety-inducing pre-service.

### Pre-flight is a hidden landmine

`#preflightBtn` is small (`.stop sm`). The button that decides whether recording will be lossless — Bob will skip it. The verdict strings are incomprehensible: `video not H.264, recording would not be copy-only (vp8)`. Disk warning `writable, but only 1.2 GB free` has no minutes-of-recording estimate.

**Fix:** make it passive. A persistent strip at the top of the dashboard, auto-green/amber/red, "Recheck" link. Replace the manual button entirely.

### Assignment is the most failure-prone screen

- **P0 — No drag-and-drop, no visual mapping.** Bob can't see "Pulpit slot holds Mary's iPhone". Each phone has a dropdown saying `Unassigned` or a slot id; no reciprocal view.
- **P1 — `(taken)` in dropdown** says `Front · cam1 (taken)`. Should name the holder: `Front · cam1 (Mary's iPhone)`.
- **P1 — `+ Create audio source`** is conceptually muddy. Better: **"Use this mic for recording"** with a `?` explainer.
- **P2 — Empty state** `"No devices connected. Open the device page, enter a name, tap Join."` has no QR code surfaced.

### Recording flow modal has issues

`startRecordingFlow` pops a modal with same-color buttons for each live camera plus a `go`-class `Start without a focus`.

- "**Start without a focus**" is jargon. → "Skip — I'll pick on the fly" or "Start with a black screen".
- Cancel is grey on the left; affirmative buttons are green on the right; list of camera buttons in the middle look like options but also like actions. Visually noisy.
- Autofocuses session name input but Enter doesn't submit.

### Switch log is invisible during recording

`#switchlogList` is in a 320px side panel of dropdowns. Bob's eyes are on the tiles. He won't notice if he's not taking cameras at all (a common volunteer mistake — they think clicking is optional). **Move switch log to a thin floating strip across top of `#grid` during recording.**

### Tile interaction is undiscoverable

Clicking a tile takes program — but only while recording. Off-air, clicks do nothing silently. Cursor changes but most volunteers won't notice. No hover state, no `data-key="1"` overlay showing "press 1".

### Recordings modal naming is for engineers

Tabs are **Sessions** and **Clips**. To Bob: a session is a therapy appointment; clips are paperclips. Use **Recordings** and **Raw camera files** (latter collapsed by default).

### Export dialog hides the value prop

`chooseExportOptions` shows a crossfade checkbox and no estimated render time, no output size, no resolution choice (hardcoded 1080p30), no thumbnail preview. Render can take 5–30 min with no ETA — button just becomes `Exporting 42%`.

---

## 6. Sunday mode — first-time-volunteer wizard

Top-right toggle `Sunday mode` (off by default, persisted in localStorage). When on, the dashboard collapses to a **single-screen wizard** with three states:

### State A — "Get cameras connected"

```
┌──────────────────────┬──────────────────────────────────┐
│  Big QR + URL        │  Devices joined so far:          │
│  https://192.../     │   ✓ Mary's iPhone — Camera 1     │
│  + "Print this page" │   ✓ John's pixel  — Camera 2     │
│                      │   ⏳ waiting for camera 3        │
│                      │   [ Go on without it → ]         │
└──────────────────────┴──────────────────────────────────┘
```

### State B — "Check the angles"

```
┌─────────────────────────────────────────────────────────┐
│  Live preview grid (read-only, big tiles)               │
│  Pre-flight: ✓ All cameras ready                        │
│                                                         │
│           [ START RECORDING THE SERVICE ]               │
│           (one giant button, red, 80px high)            │
└─────────────────────────────────────────────────────────┘
```

### State C — "Recording"

```
┌─────────────────────────────────────────────────────────┐
│  ● REC 24:18  ·  Currently showing: Camera 1 (Pulpit)   │
│  [ tap a tile to switch · or press 1–9 ]                │
│                                                         │
│  Live tiles with PGM border on current                  │
│  Bottom strip: Last switches: 00:12 Cam 2 → 03:42 Cam 1 │
│                                                         │
│           [ STOP RECORDING ]                            │
└─────────────────────────────────────────────────────────┘
```

Key moves:
- **One GO button per state.** No Preview/Pre-flight/Record distinction visible. Sunday mode runs pre-flight automatically.
- **Auto-assign devices to next free slot by join order**, Bob drags to rearrange. The power-mode UI stays for non-Sunday-mode.
- **Slot labels persist** ("Pulpit", "Wide", "Choir") — set once at first run.
- **"Go on without it"** uses existing recording-set-grows semantics.
- **No bitrate selector visible.** Locks 8 Mbps; "Advanced settings" link at bottom.

Stack fit: pure vanilla DOM swap.

---

## 7. Device page (phone-pwa) UX improvements

### What phone-holders can't figure out today

- `#armed` HUD overlaps rule-of-thirds zone when rotated to landscape. No framing helpers at all.
- `status: LIVE` doesn't say "you are being recorded." `#rec` badge is 12px in the corner.
- `waiting for operator` reads as "I did something wrong; an operator is upset."
- Rotate overlay doesn't appear for screen share or audio-only (correct) and doesn't say *why* landscape matters.
- No "tap to confirm framing" before going live. Whole `#join` flow is one tap → live.
- Connection drop just silently flips badge to `reconnecting…` in 14px.
- Wake lock requested once; no visible state; OS can revoke without warning.
- Battery API is iOS-blind. iPhone Bob has zero battery visibility.
- Mic picker hides until source=audio. Bluetooth headset gets used silently for video mode.

### Concrete improvements

**Low complexity:**

1. **Big "YOU ARE LIVE — being recorded" banner.** Top-bleed strip, red, 36px when recording. Softer green "Live preview — not recording yet" otherwise.
2. **Better landscape copy:** "Turn the phone sideways — taller is for selfies, wider is for filming."
3. **Connection-loss toast.** Full-screen amber overlay on `ws.onclose`. "Lost the studio connection — tap to reconnect now (or wait, I'm trying)."
4. **Wake-lock heartbeat.** Re-request on `visibilitychange`. Show 🔆 pip in `#armed`. Safari <16.4 fallback: "Tap the screen every few minutes to keep me awake."
5. **Use the slot label more prominently:** "Pulpit — keep the speaker centered."

**Medium complexity:**

6. **Framing helpers overlay.** Toggle (gear icon) on viewfinder. Three options:
   - Rule-of-thirds grid (4 thin white lines, ~0.4 opacity).
   - **Bubble level** via `DeviceOrientation` (iOS needs `requestPermission()` after user gesture). Phone-holders fix tilt in 5 seconds.
   - **Face count via `window.FaceDetector`** (Chrome-only, progressive enhancement). Render "👤 ×2" pip when faces detected.
7. **"Tap to confirm framing."** 5-second pre-publish overlay with a big green confirm button. Auto-publishes after 5s if no tap.
8. **Per-device mic picker for camera mode.** Move out of `hidden-unless-audio`. Default "Built-in mic" rather than ambiguous "Default microphone."
9. **Lock-screen / DND coach.** Platform-detected one-time card after Join. iOS: "Control Center → Focus → DND." Android: "Settings → Notifications → Silence." Dismissable, never shown again.

---

## 8. Operator dashboard creative features

### Worth building

| Feature | Detail | Complexity |
|---|---|---|
| **Hotkey overlay (`?`)** | Print legend: 1–9 take, R record, P preview, M marker, Space start/stop, Esc close | Low |
| **Markers (`M`)** | Quick modal "What is this?" chips: Song / Sermon point / Prayer / Reading / Custom. Storage extends existing switch-log shape `{offset, type:'marker', label}`. Markers show on preview scrubber. Export embeds as MP4 chapters + YouTube-ready text sidecar | Medium |
| **Click-and-hold tile for "punch-in preview"** | `pointerdown` + 250ms timeout + `requestFullscreen`. PGM untouched. Lets operator review a tile before taking it | Low |
| **Round-robin auto-switch for music sets** | Operator picks cameras + interval (e.g. every 8s). Server-side timer fires `switch` messages. Genuinely useful during worship sets | Low |
| **Confidence monitor at `/confidence`** | Separate URL. Big clock, recording elapsed time, "wrap up in X:XX" countdown the operator can set, optional "next song:" line. Big text, black bg | Low |
| **HTTP take endpoint** for Stream Deck / Companion / MIDI | `POST /api/take?cam=cam1` — let users wire whatever surface. Don't build in-app Stream Deck plumbing | Low |
| **Mobile "director" view** | `@media (max-width: 720px)` collapses `#side` to bottom sheet, 2-col tile grid, fixed bottom bar with Record + 1–4 take buttons. Tech lead at the back of the room on a tablet | Medium |
| **Auto-take on join** | New device joins mid-recording → banner "Pulpit (Mary's iPhone) is now live. **Take it?**" with 5s countdown | Low |
| **Tally light push to device** | Operator takes camera → that device's `#armed` HUD turns red-bordered, "📡 ON AIR". New WS broadcast on every `switch` | Low |
| **Volume meters under each tile** | `pc.getStats()` audio inbound-rtp `audioLevel` — 2px bar, red-tipped above -3dBFS | Low |
| **"Last 30s" rolling save trust copy** | Banner "✓ Recording is safe on disk even if this browser crashes" — already true; surface it | Trivial |
| **Replay buffer per camera** (`[`) | Read tail of in-progress fMP4 from disk via HTTP Range. Modal pops with `<video>` seeked to `duration-10`. Server-side endpoint required | Medium-High |

### Trap features — don't build

- **Live "soft-cut vs hard-cut" toggle** — switch log records intent, not pixels. Crossfade is an export-time decision (already exists). A live toggle would do nothing visible.
- **VAD-driven sermon auto-switch (full auto)** — sermons have one mic on 95% of the time; VAD will pick the pulpit and never switch. Music sets flap. **Use the suggestion-overlay variant** (§4.2) instead.
- **In-app Stream Deck integration** — just publish the HTTP endpoint and let Companion call it.
- **Companion phone app** — build responsive view instead. Same WS, zero new backend.

---

## 9. Export & post-production UX

The current export is "make one MP4". Real users want:

### High-value, fits the stack

- **Chapter list as MP4 metadata + plain-text sidecar.** When markers exist, embed as `-metadata:s:t` chapter tracks via ffmpeg ffmetadata file. Drop `<session>.chapters.txt`:
  ```
  00:00 Welcome
  03:42 Opening song
  08:15 Reading
  12:30 Sermon — "The good shepherd"
  ```
- **Thumbnail picker.** Row of frames extracted at take boundaries. `ffmpeg -ss <t> -frames:v 1 -vf scale=1280:720`. Save as `<session>.jpg`.
- **Audio-only podcast export.** Same input clips, same per-section mic routing, but `-vn -c:a libmp3lame -b:a 128k` or m4a. Add Format selector: `Video MP4` / `Audio M4A (podcast)` / `Audio MP3 (legacy)`.
- **Loudness normalize for podcast (-16 / -14 LUFS).** Two-pass `loudnorm` filter. Toggle: "Match podcast loudness (recommended)". Default ON for audio exports.
- **Batch export presets:** YouTube hard-cuts / YouTube crossfade / Podcast M4A / Quick clip (vertical 1080×1920).

### Medium-high value, harder

- **Vertical short clip (15–90s, 9:16).** Pick in/out on scrubber, choose camera or program edit, output 1080×1920. `crop=ih*9/16:ih,scale=1080:1920`.
- **Transcript SRT sidecar via whisper.cpp.** See §3.

### Export UX fixes

- Show **estimated render time** before clicking: `program_seconds × cameras × 0.4` for re-encode, `× 0.05` for stream-copy.
- Show **estimated output size**: `durationSec × bitrate / 8`.
- **Progress as time, not %:** `12 min remaining (35 of 60 min done)`.
- **`<title>` mutation** `(45%) — Operator Dashboard` so progress visible in tab.
- "**Saved to exports/<file>**" path after done.

---

## 10. Optional operator authentication (your follow-up question)

**The current trust model** (from README): *"This is a LAN-trusted app. There is no user authentication: anyone on the same network who reaches the operator URL can drive the studio."* For a small church on a private WiFi this is mostly fine, but it has real failure modes:

- Visiting nephew on the guest WiFi can navigate to `https://studio.localhost:8444/` (or the LAN IP) and stop the recording mid-sermon.
- A misconfigured router that bridges guest WiFi to the main LAN exposes the dashboard to every Sunday visitor.
- Someone on the same LAN can download every recording via the existing Recordings modal.
- If the church ever wants to put the laptop on the office network (so it can also pull lyrics from a PC running ProPresenter), the dashboard is now visible to every workstation.

### Design — keep it minimal, opt-in, single-tenant

This is **not** an enterprise IAM project. It's "lock the operator URL behind a passphrase the A/V lead picks on install." Design constraints:

1. **Off by default.** Plain LAN-trust still works for solo demos and existing users.
2. **Single shared credential.** No accounts table. No password reset emails. The church has one A/V password the way it has one alarm code.
3. **Bearer-token sessions in `localStorage`.** First load shows a passphrase prompt; correct passphrase mints a long-lived token (90 days); subsequent loads auto-authenticate. The operator's laptop and the tech-lead's tablet each enter the passphrase once.
4. **Device page (`:8443`) stays unauthenticated.** Volunteers holding phones can't be asked to enter a password every Sunday. The operator side controls which phones get armed anyway — so an attacker on the LAN can publish video, but it goes nowhere unless the authenticated operator assigns it to a slot.
5. **Control WebSocket requires the token** in the URL query (`?t=<token>`) or in a `Sec-WebSocket-Protocol` subprotocol. Same-origin check stays.
6. **MediaMTX API stays bound to `127.0.0.1`** — no change needed; it's already not LAN-reachable.

### Implementation sketch (vanilla, fits the stack)

**Storage** (`control/auth.mjs`):

```
data/auth.json
{
  "passphraseHash": "<argon2id or scrypt of passphrase + salt>",
  "salt": "<random 16 bytes>",
  "createdAt": "...",
  "tokens": [
    { "id": "...", "hash": "...", "label": "Operator laptop", "createdAt": "...", "lastSeenAt": "..." }
  ]
}
```

- Use Node's built-in `crypto.scryptSync` — no new dependency (your `ws` is the only runtime dep today).
- Token is 32 random bytes, base64url; only its hash is stored.

**Setup UX:**

- **First-run wizard** in the operator dashboard: "Set an operator passphrase (or skip — anyone on the LAN can control the studio)." Two buttons: `Set passphrase` / `Skip (LAN-trust)`.
- The Windows installer adds a checkbox: "☑ Require a passphrase to open the operator dashboard (recommended)." Generates a passphrase on install, prints it to a `passphrase.txt` next to the cert, and stops showing it after first login.

**Passphrase reset — tray menu is the primary path** (for the inevitable "we forgot the passphrase" call, which will happen):

- **System-tray menu** (uses the existing Windows tray launcher in `tray.ps1`): right-click → *Reset operator passphrase…* → yes/no confirm → wipes `data/auth.json` and revokes all tokens → dashboard reloads at the first-run setup wizard. This is the path the A/V lead actually uses. Fits the persona — they're at the laptop, not in a terminal.
- **CLI fallback** (`npm run reset-auth` / `multicam reset-auth`) for headless setups and the future macOS/Linux paths before menubar/appindicator equivalents land.
- **Manual** (delete `data/auth.json` in Explorer) — documented in the README as the last resort. The fact that this works is a feature, not a bug: the church can never be permanently locked out of their own laptop.
- **No network-reachable reset.** No "email a reset link" or "answer a security question over the LAN" — anything network-reachable is a new attack surface that undoes the point of the auth feature.
- **Optional recovery code at first setup.** Wizard shows an 8-digit code alongside the passphrase, tells the A/V lead to write it on a sticker on the bottom of the laptop. Login screen offers a small "I have a recovery code" link. Single-use; stored as a scrypt hash next to the passphrase hash. Bundled improvement, not blocking.
- **What reset wipes:** passphrase hash + salt, all active session tokens (every device must re-log-in), recovery code. **What reset preserves:** recordings, switch logs, exports, camera config, slot labels. Reset only touches auth state.

**Login flow:**

- Operator dashboard root route checks `localStorage.token`. If present, POST `/api/auth/verify` with bearer header. If valid → load app. If invalid → show passphrase prompt.
- POST `/api/auth/login` with `{ passphrase }` returns `{ token }`. Token is a hash-comparable secret; store only its scrypt hash.
- Rate limit: in-memory counter, 5 failed attempts → 60s lockout per source IP. Failed-attempt log to `logs/auth.log` (date, IP, success/fail — no passphrase).

**Authorization enforcement:**

- All `/api/*` HTTP routes (recordings, exports, take endpoint) require `Authorization: Bearer <token>`.
- Control WS upgrade reads `?t=` or `Sec-WebSocket-Protocol`; mismatched/missing → 401 close.
- Static dashboard files (`operator-dashboard/*`) can stay public — they're just HTML/JS shells. The shell loads, fails the verify call, and renders the login prompt. (Avoids serving 401 HTML to a browser that can't deal with it.)

**What this is not:**

- Not RBAC. Not multi-user. Not OAuth. Not WebAuthn (although a future WebAuthn-as-2FA layer is feasible against the same token model).
- Not protection against an attacker who gets shell access to the laptop. That's a different threat.
- Not a substitute for putting the studio on a trusted network. README still recommends that.

### Threat-model framing for README/SECURITY.md

After this feature, the trust model becomes:

> **LAN + passphrase (recommended) or LAN-only (default).** With auth enabled, the operator dashboard and control API require a passphrase that the A/V lead sets on install. Authenticated sessions are remembered on the device for 90 days. Phone capture (`:8443`) stays unauthenticated — devices can publish, but only an authenticated operator can record or download.

This solves 90% of the real-world threats (curious visitor, guest WiFi misconfig, office-LAN exposure) without changing the simplicity of running the tool on a Sunday.

### Adjacent improvements worth bundling

- **Audit log surface.** A small "Activity" tab in the dashboard: "Operator laptop signed in 2026-05-25 10:14 from 192.168.1.42 · Recording started · Session exported." Builds trust + helps the A/V lead spot oddities. Stored in `logs/audit.jsonl`.
- **Per-token revoke UI.** "Devices signed in: Operator laptop ✗, Tech-lead iPad ✗." Click ✗ → token deleted server-side.
- **"Lock now" button.** Clears the operator's own localStorage token. Useful for "I'm done, locking the laptop before I leave."

### What this earns the project

- Removes the loudest objection from any IT-conscious church board ("but anyone can stop the recording?").
- Makes the tool deployable on a shared office LAN, which broadens the addressable installs significantly.
- Tiny code surface (estimate: <300 LOC of vanilla Node + a login modal). Zero new runtime dependencies.
- Sets up the foundation for any future remote-access story (Tailscale, Cloudflare Tunnel) without changing the trust model.

---

## 11. Trust + recovery UX (general)

### Passive surfaces

- **Health strip at top of dashboard.** Always visible: `✓ 4 cameras live · ✓ 18 GB free (≈ 4h at current bitrate) · ✓ Studio reachable · 🔋 Mary 18%`. Click → full pre-flight. Replaces manual button.
- **Per-tile dropped-frame indicator.** `pc.getStats()` exposes `framesDropped` and `framesReceived`. If dropped/received > 2% over 5s → yellow `⚠ choppy` chip.
- **Low-battery operator banner.** When any phone <15% non-charging → top banner `🔋 Mary's iPhone is at 12% — plug it in or swap`. (Already in roadmap.)

### Active recovery

- **Session recovery on operator browser crash.** Server-side recording survives. WS reconnect already restores state — just surface a banner: "📼 A recording is already in progress (started 12:18). Resume?"
- **Append-to-existing-take after accidental Stop.** "Resume previous recording" button if last session ended <60s ago.
- **Per-camera reconnect attempt count surfaced.** `reconnecting… (try 3/∞)` + manual "Retry now."
- **Block Record on pre-flight `bad`.** Confirm modal: "Pre-flight failed: Mary's phone isn't sending H.264. **Record anyway / Fix and retry**." Currently Record is enabled as long as one phone publishes — footgun.
- **Optional redundant local copy.** "Also save a second copy to <USB drive>". `cp` shell-out after Stop.

### Trust copy

- **"Recording is safe even if this browser closes."** Persistent subtitle under `● REC`. Bob's biggest fear.
- **Auto-clear messaging.** When 30s grace fires: "All cameras dropped out for 30 seconds. Recording stopped automatically. Files saved." Currently it just stops.

---

## 12. Accessibility & inclusion — WCAG-anchored fixes

### Current strengths

- `role="dialog"` + `aria-modal="true"` auto-wired.
- `aria-label` on recordings modal buttons.
- `color-scheme: dark`.

### Concrete failures

| # | Severity | Fix |
|---|---|---|
| 1 | **P0 (1.4.1)** | Status badges (`ok` / `warn` / `bad` / `muted`) rely on color alone. Add a leading glyph: `✓ live`, `⚠ standby`, `✗ offline` |
| 2 | **P0 (1.4.1)** | PGM red border + REC red dot fail for deuteranopia. Add thick dashed outline or star glyph on PGM, not color alone |
| 3 | **P1 (1.4.3)** | `#666` text on `#141414` (`.empty`, `.player-camlabel`, `.sc-meta`) is ~3.2:1, fails AA. Bump to `#9aa0a6` (~6:1) |
| 4 | **P1 (1.3.1)** | Bitrate dropdown — wire `aria-labelledby="bitrateLabel"` to the dropdown root |
| 5 | **P1 (4.1.2)** | Custom `createDropdown` not screen-reader friendly. Add `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-haspopup="listbox"`; `role="listbox"` on menu; `role="option"` + `aria-selected` on items. Arrow-key navigation |
| 6 | **P1 (2.1.1)** | Tile `<div>` not focusable. Add `role="button"`, `tabindex="0"`, Enter/Space handler |
| 7 | **P1 (3.3.2)** | Hotkeys 1–9 have no documented surface. `?` overlay (see §8) |
| 8 | **P2 (3.3.2)** | Session-name input uses placeholder only. Add explicit `<label>` (visually hidden if needed) |
| 9 | **P2 (1.3.1)** | `<div id="side">` should be `<aside>`; `<header>` needs `aria-label="App controls"` |
| 10 | **P2 (2.4.3)** | Modal focus trap missing. Cycle Tab within modal until close |
| 11 | **P2 (4.1.3)** | Add `aria-live="polite"` to `#conn`, `#live`, `#recstate`, `#switchlogList` |
| 12 | **P2 (4.1.2)** | 🎧 emoji on Listen button announced as "headphone". Wrap in `aria-hidden="true"` span |

### Phone PWA

- `<select id="source">` only has `aria-label`. Add a visible `<label>`.
- Wake-lock no visible state. Helps accessibility (Bob can hear/touch a "screen stays on" toggle).
- `#log` button is 32×32. WCAG 2.5.5 recommends ≥44×44.

### Practical inclusion wins

- **Mobile director view** (§8) lets a deaf usher and a hearing operator collaborate from different positions.
- **Confidence monitor** (§8) on a tablet at the front lets the pastor see the operator's timing.
- **Transcript sidecar** (§9) makes the recording itself inclusive for deaf congregants.

---

## 13. Whimsy & personality — warm but professional

The current voice is correct-but-clinical (`not recording`, `Start Preview (all)`). A church tool deserves more warmth without losing trust.

**Microcopy with quiet personality:**

- Recording start: `📼 Rolling — every angle is being recorded.`
- Recording end: `✓ Saved 47 minutes of footage. Take a breath.`
- Phone joins: `🎥 Mary's iPhone joined as Camera 2. Hi Mary.` (4s, operator only.)
- Phone drops: `Mary's phone tapped out. Holding the slot for 30 seconds — should reconnect.`
- All cameras drop: `Nobody is publishing. I'll save what we have in 30s.`
- Empty cameras: `No cameras yet. Tap "+ Add" to set one up — give it a name like "Pulpit" or "Wide".`
- Disconnected: `Lost the studio. I'm trying to reconnect…` with subtle spinner.

**One or two easter eggs (not a parade):**

- Type `amen` anywhere (not in an input) → tiny dove SVG drifts across bottom for 2s. Once per session.
- Sunday morning auto-greeting between 7–11am Sunday: header subtitle `Good morning. Service in about an hour?` for first 30s.
- End-of-service stat card after >30min recording: `Recorded for 47 minutes · 4 cameras · 28 switches · 3.2 GB. Nice work.`

**Trust-building micro-moments:**

- Pre-recording: `Pre-flight ✓ All set. The recording will keep going even if you lose WiFi for a moment.`
- After first ever recording: `That's your first recording with this studio. The masters are in <path>; you can come back any time.`
- After first ever export: `Your first export is done. The original camera files are still saved — you can re-render with different transitions anytime.`

**Avoid:**

- Religious-specific labels baked into core ("sermon" hardcoded). Use neutral defaults ("Talk", "Session"); let operators rename. Tool also serves conferences, schools, music.
- Mascot characters. Bob is 67.
- Sound effects. Bob is running audio gear.

---

## 14. Suggested README hero rewrite

Current opening: "Turn a handful of phones (and any webcams, screen shares, or external mics you have around) into a synchronized, multi-angle recording rig…" — accurate but feature-heavy.

Try:

> **Wireless Multicam Studio**
>
> Free, offline, open-source — built so volunteers can actually run it.
>
> Bring your phones. We record every angle in original quality, mark which one was "on", and give you the finished cut. No capture hardware. No subscription. No cloud.
>
> 🎥 Phones as cameras — no app install, just open a URL
> 💾 Lossless per-angle recording — your laptop never encodes during the take
> ✂️ Switch live or fix it in post — the masters are always there
> 🔒 Offline by default — nothing leaves the LAN
> 📝 *(coming)* Captions + transcript on the way out — without OpenAI
>
> Built for small churches, conferences, schools, and anyone who got burned by OBS dropping frames at the wrong moment.

---

## 15. Sources (curated)

### Church tech market
- [ChurchTechToday — Switcher Studio review](https://churchtechtoday.com/switcherstudio-review/)
- [ChurchTechToday — Stream Decks for church staff](https://churchtechtoday.com/stream-decks-and-live-stream-controllers-a-complete-guide-for-church-staff/)
- [Church Visuals — ProPresenter + OBS](https://churchvisuals.com/article/how-to-use-obs-and-pro-presenter-together-for-your-online-stream/)
- [Renewed Vision — ProPresenter in OBS](https://www.renewedvision.com/blog/how-to-use-propresenter-in-obs-lower-thirds)
- [BoxCast vs Resi case-study series](https://www.boxcast.com/case-studies/tag/boxcast-vs-resi)
- [StreamYard — Best streaming software for pastors](https://streamyard.com/blog/best-streaming-software-for-pastors)
- [Scrile — Live streaming for churches](https://www.scrile.com/blog/live-streaming-for-churches)
- [vMix — Church purchase page](https://www.vmix.com/purchase/churches.aspx)
- [Capterra — BoxCast pricing](https://www.capterra.com/p/196797/BoxCast/)

### OBS forum pain points
- [OBS — Why is OBS so garbage & complicated?](https://obsproject.com/forum/threads/why-is-obs-so-garbage-complicated.100669/)
- [OBS — Suddenly dropping massive amounts of frames](https://obsproject.com/forum/threads/obs-suddenly-dropping-massive-amounts-of-frames.176889/)
- [OBS — Multicam tag](https://obsproject.com/forum/tags/multicam/)
- [OBS — 2nd cam always not working](https://obsproject.com/forum/threads/2nd-cam-always-not-working.120870/)
- [OBS — Church needing assistance](https://obsproject.com/forum/threads/church-needing-assistance-if-possible.136901/)

### VDO.Ninja & adjacent
- [VDO.Ninja — main](https://vdo.ninja/)
- [VDO.Ninja — recording options](https://docs.vdo.ninja/guides/options-to-record-streams)
- [VDO.Ninja — GitHub](https://github.com/steveseguin/vdo.ninja)
- [Softvelum — Larix Broadcaster FAQ](https://softvelum.com/larix/faq/)

### Whisper + local AI
- [whisper.cpp main](https://github.com/ggml-org/whisper.cpp)
- [whisper.cpp — stream example](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/README.md)
- [whisper.cpp — streaming latency discussion](https://github.com/ggml-org/whisper.cpp/discussions/3567)
- [Prompt Quorum — whisper.cpp vs faster-whisper 2026](https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026)
- [OpenWhispr — Whisper model sizes](https://openwhispr.com/blog/whisper-model-sizes-explained)
- [Brady Hurlburt — Local live captioning with whisper.cpp + ffmpeg](https://brady.fyi/post/local-live-captioning-with-whisper.cpp-and-ffmpeg/)
- [DeepFilterNet — repo](https://github.com/Rikorose/DeepFilterNet)
- [DeepFilterNet — paper](https://arxiv.org/pdf/2305.08227)
- [Silero VAD](https://github.com/snakers4/silero-models)
- [WhisperX-silero](https://github.com/lukaszliniewicz/whisperX_silero)
- [llama.cpp — summarization discussion](https://github.com/ggml-org/llama.cpp/discussions/628)

### Sermon-clip SaaS landscape
- [Choppity — Best sermon clip makers 2026](https://www.choppity.com/blog/best-sermon-short-clips-makers-generators/)
- [ChurchSocial.ai](https://www.churchsocial.ai/)
- [REACHRIGHT — Sermon clips for social media 2026](https://reachrightstudios.com/blog/sermon-clips-for-social-media/)

### Planning Center
- [Planning Center — Sermon Notes beta](https://www.planningcenter.com/blog/2024/12/beta-launch-announcing-sermon-notes-in-planning-center)
- [Planning Center — BoxCast integration](https://www.planningcenter.com/integrations/boxcast)

### GDPR / safeguarding
- [Church of England — Filming + GDPR](https://www.churchofengland.org/resources/digital-labs/blogs/filming-and-photography-churches-consent-and-gdpr)
- [Edward Connor solicitors — Videos and GDPR](https://www.edwardconnor.com/2025/04/14/videos-and-gdpr/)
- [Church Production — Streaming best practices: protecting your congregation](https://www.churchproduction.com/education/streaming-best-practices-protecting-your-congregation/)

### Tooling
- [obs-websocket](https://github.com/obsproject/obs-websocket)
- [Bitfocus Companion](https://bitfocus.io/companion)

---

## 16. Where I'm guessing vs. citing

Cited above: competitor pricing, OBS failure modes, ProPresenter integration pain, Switcher Studio limits, BoxCast/Resi subscription complaints, Whisper.cpp benchmarks + model sizing + streaming behavior, DeepFilterNet performance, GDPR/safeguarding guidance, Planning Center features, Stream Deck adoption, sermon-clip SaaS category.

Extrapolated (flagged in text):
- VAD-on-mics → auto-switch-to-linked-camera pipeline is a synthesis of the existing mic↔camera link model + Silero VAD characteristics. No source describes this specific design.
- Specific church-laptop tok/s estimates for llama.cpp 7B/8B are extrapolations from general llama.cpp performance corpus.
- "Reaper for multicam" positioning is my framing.
- Optional-auth design (§10) is a fresh proposal; sized for the existing stack but not benchmarked.
