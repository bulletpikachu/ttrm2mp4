# TETR.IO replay renderer

Convert a two-player `.ttrm` match into an MP4 using TETR.IO’s original game engine, Pixi renderer and shaders. Export runs on a controlled clock with browser networking disabled. Each completed round is saved while later rounds continue rendering.

## Setup

The fast exporter requires Apple Silicon macOS, Node.js 22+, and Xcode Command Line Tools. Install dependencies and prepare the client once while online:

```sh
npm install
npm run prepare-client -- example.ttrm
npm run prepare-fast -- example.ttrm
```

`prepare-client` downloads a pinned client and its assets into `client/`. `prepare-fast` builds the native modules and warms a cache of the browser decoder’s exact audio samples using a brief offline preview. This preparation is shared by subsequent replays; it does not cache rendered video.

Keep the project and cached files downloaded locally, and choose an output destination outside cloud synchronization for the best speed. Temporary video and audio work uses system scratch storage. Cloud storage can replace dependencies or assets with placeholders, preventing offline export. The official TETR.IO DMG is an Electron wrapper for the online game; it does not contain the complete offline client.

Git tracks the source, build scripts, dependency lockfile, and documentation. Downloaded game files, installers, local replay inputs, dependencies, compiled native modules, and generated export artifacts are excluded. A fresh checkout needs its own replay file and the setup steps above; it does not include the local `client/` cache.

## Export

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

`REPLAY_X264_THREADS=N` can override the encoding thread count. Extra threads are not a linear speed multiplier because rendering and encoding share the same CPU and GPU.

## Other backends

The original Chrome exporter remains available with `npm run render -- example.ttrm output.mp4 --export-rounds`; it requires Google Chrome and is slower. Older parallel and diagnostic backends remain experimental. Their measurements and limitations are documented in [the performance notes](notes/native-performance.md).

TETR.IO and its assets remain the property of their respective owners. Client patches target the pinned build and fail if expected source code changes.
