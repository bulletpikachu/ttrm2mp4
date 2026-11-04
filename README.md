# TETR.IO replay renderer

Convert a two-player `.ttrm` match into an MP4 using TETR.IO’s original game engine, Pixi renderer and shaders. Export runs on a controlled clock with browser networking disabled. Each completed round is saved while later rounds continue rendering.

## Setup

Windows: install Node.js 22+ and Google Chrome, then run the following in PowerShell. The portable renderer uses Chrome's original WebGL renderer and a bundled FFmpeg executable; it does not need native compilation or a separate FFmpeg installation.

```powershell
npm ci --omit=dev
npm run prepare-client -- "C:\path\example.ttrm"
npm run render -- "C:\path\example.ttrm" output/preview.mp4 --duration 10 --export-rounds --deterministic
```

The default is 1920×1080 at 60 fps with continuous stereo AAC audio. The browser encoder is tested before exporting: automatic selection tries H.264 hardware, software and alternative profiles, then falls back to CPU x264 through FFmpeg. `--encoder ffmpeg` forces the fallback; `--threads N` overrides its CPU-adaptive thread count. The fallback preserves the same simulation and audio timeline, but transfers raw pixels and is slower. `--encoder hardware` requires a working browser hardware configuration. JSON reports record the selected backend/configuration and failed probes. Automatic fallback handles unavailable encoders during startup; an encoder or GPU failure during export fails the command rather than restarting the match.

For a smaller test add `--width 1280 --height 720`. `--software` selects software WebGL independently of the video encoder. If Chrome is installed elsewhere, pass `--chrome "C:\path\chrome.exe"` to both preparation and rendering.

An experimental faster Windows x64 command uses Electron, direct media writes, a native exact audio mixer and continuous muxing. It requires the full dependencies and Visual Studio C++ Build Tools for one-time preparation:

```powershell
npm ci
npm run prepare-windows-fast -- "C:\path\example.ttrm"
npm run render-windows-fast -- "C:\path\example.ttrm" output/match.mp4
```

The current full nine-round Windows candidate exported 318.85 seconds in 98.01 seconds (3.25×), versus 205.22 seconds with the portable Chrome path. All frames, round PCM ranges and the canonical full audio hash passed. The 10× target has not been achieved on Windows. Game graphics and 1080p60 settings are retained. The Mac fast path remains separate. See the [Windows handoff](notes/windows-support.md#paused-handoff) for the current recommendation, reproduction command and remaining limitations.

The separate experimental native D3D11/NVENC backend has since reached **44.42 seconds for the complete command (7.18×)** on the same match, improving the previous verified 49.39-second result. It uses three drawing workers, direct cached-file serving inside Electron, a lighter continuous audio-only simulation and Windows Media Foundation AAC. It requires additional native builds and the opt-in settings in the Windows notes. All 19,131 round/master frames, all 160 reference-image samples, complete audio timing and all nine decoded round-audio coverage/alignment checks pass. Original high graphics, 1080p60 and AA4 are retained; the different AAC encoder and its signed 16-bit input conversion are documented there. Windows 10× remains an open target.

**Speed optimization is paused at the user's request (2026-11-04).** The last live-texture compute experiment took 52.24 seconds and is not recommended over the verified 44.42-second D3D11 result. Experimental compute modes remain opt-in; the public launchers and Mac defaults were not switched to them. The Windows notes record all final experiments and distinguish complete audits from preview-only checks. A standalone native installer and validation on other Windows machines remain unfinished.

Apple Silicon macOS: the fast exporter additionally needs Xcode Command Line Tools and the native development dependencies. Its existing setup remains:

```sh
npm install
npm run prepare-client -- example.ttrm
npm run prepare-fast -- example.ttrm
```

`prepare-client` downloads a pinned client and its assets into `client/`. `prepare-fast` builds the native modules and warms a cache of the browser decoder’s exact audio samples using a brief offline preview. This preparation is shared by subsequent replays; it does not cache rendered video.

Keep the project and cached files downloaded locally, and choose an output destination outside cloud synchronization for the best speed. Temporary video and audio work uses system scratch storage. Cloud storage can replace dependencies or assets with placeholders, preventing offline export. The official TETR.IO DMG is an Electron wrapper for the online game; it does not contain the complete offline client.

Git tracks the source, build scripts, dependency lockfile, and documentation. Downloaded game files, installers, local replay inputs, dependencies, compiled native modules, and generated export artifacts are excluded. A fresh checkout needs its own replay file and the setup steps above; it does not include the local `client/` cache.

## Export

On Windows use `npm run render -- example.ttrm output.mp4 --export-rounds --deterministic`. The commands in this section using `render-fast` apply to Apple Silicon macOS only.

```sh
npm run render-fast -- example.ttrm output.mp4
```

The default is **1920×1080 at 60 fps**, native high graphics with four-sample antialiasing, H.264 CRF18, and stereo AAC at 192 kbps. Music keeps its phase across round boundaries, including sound-effect tails.

The command writes:

- `output.mp4`: the complete match.
- `output-rounds/round-01.mp4`, etc.: rounds published as they finish.
- `output.json`: actual elapsed time, settings, frame ranges, publication times and audio verification.

```sh
# Short preview, one round, or replacement of an existing export
npm run render-fast -- example.ttrm preview.mp4 --duration 10
npm run render-fast -- example.ttrm round.mp4 --round 3
npm run render-fast -- example.ttrm output.mp4 --overwrite

npm run render-fast -- --help
```

Existing outputs are protected by default. A preview’s unfinished round has `-partial` in its filename. Unsupported or incomplete replays and missing cached assets cause an error.

## Performance and verification

The supplied Apple M3 Pro exported the 185.63-second, seven-round sample in **17.84 seconds for the complete command (10.41×)** with the prepared audio cache. Timing includes client startup, rendering, audio, all round files and final MP4 packaging. Other replays, system load and hardware can produce different speeds. The measured command uses local scratch space and an output destination outside iCloud; both the complete-command and internal processing times are recorded in its JSON report.

The pipeline uses one continuous native simulation, an asynchronous ANGLE driver, one GPU pass to pack video planes, and sixteen CPU encoding threads. It avoids browser-compositor capture and full-frame CPU readback. Reserving the MP4 index up front avoids moving the completed video a second time. More independent renderers were slower on this machine and changed continuity in older experiments, so the default keeps one match timeline.

The exporter checks the written master PCM hash, every round’s corresponding PCM range, and the continuous mux’s complete input hash and frame count. For a full decoded-frame audit:

```sh
node scripts/verify-rounds.mjs output.json
```

Visual verification also compares sampled decoded frames with the previous native renderer inputs, including countdowns and transitions. This preserves the previous quality settings and checks for frame shifts; it does not claim pixel-identical output between Chromium and native ANGLE. The native background can vary during initialization, so an additional same-run native-canvas check verifies the opening frame’s fidelity.

For portable exports, decode the finished MP4 to check frame count, audio/video timestamp alignment and continuous audio coverage:

```sh
node scripts/verify-av.mjs output.json
node scripts/verify-rounds.mjs output.json
npm run test:portable
```

The timestamp check allows only final AAC packet padding; round PCM is independently compared with the continuous master during export. These checks establish file/timeline integrity, and do not replace listening to the output. See [Windows progress and limitations](notes/windows-support.md) for the tested machine, commands and packaging status.

`REPLAY_X264_THREADS=N` can override the encoding thread count. Extra threads are not a linear speed multiplier because rendering and encoding share the same CPU and GPU.

## Other backends

The portable Chrome exporter is available with `npm run render -- example.ttrm output.mp4 --export-rounds`; it requires Google Chrome and is slower than the native Mac path. Older parallel and diagnostic backends remain experimental. Their measurements and limitations are documented in [the performance notes](notes/native-performance.md).

TETR.IO and its assets remain the property of their respective owners. Client patches target the pinned build and fail if expected source code changes.
