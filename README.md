# ttrm2mp4

Convert a two-player `.ttrm` match into an MP4 using TETR.IO’s original game engine, Pixi renderer and shaders. Export runs on a controlled clock with browser networking disabled. Each completed round is saved while later rounds continue rendering.

## Desktop app

```sh
npm ci
npm run desktop
```

Drop one or more `.ttrm` files onto the artwork, or use **Choose replay files**. Use the settings on the right to pick an output folder, resolution, frame rate, or backend. The left column shows the current run’s logs. Press **Render** to start. Exports run one at a time, and **Queue** opens the sketchbook window with queued replays and links to completed videos. If an output filename is already in use, the app picks the next available name. Drag the top of the artwork to move the window, or resize from the edges to keep its original proportions.

On first use, add a replay and click **Set up & render**. The app downloads TETR.IO files with its bundled browser, verifies the downloaded objects, checks an offline preview, then renders the replay. You can also use **Set up TETR.IO files** in the settings column to download without rendering. Setup needs an internet connection and may take a minute or two. No installed TETR.IO game, Chrome, or command-line setup is required.

Game files are stored as separate versioned caches in the app's data folder. Setup uses a fresh browser session and does not read or modify your installed game or account. A failed or cancelled refresh keeps the previous cache selected. In the settings column, you can select an existing renderer cache or download fresh files. Preferences and decoded audio caches are written to the user's application-data folder, never the installed app folder.

Use **Import appearance** to load video preferences from a TETR.IO `.ttc` export and assets from a TETR.IO PLUS `.tpse` pack. Import each file separately to use both together. Imports are saved in the renderer's application-data folder and apply to the selected backend. With **Automatic**, the native startup check uses the imported appearance before choosing a backend. TPSE support covers static skins, textures, rank icons, particles, the first embedded still background, and sound effect banks. Animated assets and custom music are skipped. **Clear appearance** restores the default look.

Build an installer-free app folder for the current operating system and architecture:

```sh
npm run package:desktop
```

The result is in `dist/` and can be moved or zipped. Native modules must be built on the target platform before packaging (`prepare-fast` on Apple Silicon; `prepare-windows-fast` on Windows NVIDIA). If native dependencies are unavailable, Automatic tries the compatible renderer using the bundled Electron browser. End users do not need Node, Chrome or compiler tools. This is a local, unsigned development package; release signing and automatic updates are not configured.

Resource paths are resolved relative to the app, and generated native loaders resolve binaries relative to their own package. The desktop worker uses the bundled Electron executable in Node mode, while hidden rendering windows launch in normal Electron mode. The UI uses a sandboxed window and a narrow preload bridge; rendering workers retain the original engine's separate execution environment.

Windows source builds discover Visual Studio through `vswhere` (located from Program Files) and the Windows SDK through developer-environment variables or the registry. Nonstandard installations can set `REPLAY_VSWHERE`, `REPLAY_MSVC_ROOT`, `REPLAY_WINDOWS_SDK`, `REPLAY_WINDOWS_SDK_VERSION`, or `REPLAY_DELAY_LOAD_HOOK`. These tools are build-time dependencies, not requirements for running a packaged app.

Validation:

```sh
npm run check:desktop
npm run test:desktop-jobs
npm run test:setup
npm run test:desktop
# Test an already packaged app using its executable path:
node scripts/check-desktop.mjs "/path/to/ttrm2mp4.app/Contents/MacOS/ttrm2mp4"
```

The export end-to-end check needs a local `replay.ttrm` and a prepared `client/`. `npm run test:desktop-setup` exercises first-run downloads, an offline export, and cancelled refresh preservation against the live TETR.IO site; it needs `replay.ttrm` and network access. It tests file selection, file drop, a complete one-round export, structured events, preferences and cancellation during rendering. Mac native and compatible packaged exports were exercised after moving the app to another folder with spaces in its name. Windows GUI and packaging still require validation on Windows hardware.

## Automatic rendering

Use the same command on every machine:

```sh
npm run render -- example.ttrm output.mp4
```

The launcher tries the prepared Apple Silicon backend on macOS arm64 or the prepared NVIDIA backend on Windows x64. Before selecting native rendering, it runs a temporary 0.1-second export at the requested dimensions and frame rate; Windows checks the proposed number of concurrent NVENC sessions and Media Foundation AAC, reducing automatic worker counts if concurrent startup fails. Missing modules or a failed startup check select the portable Chrome backend instead. This check adds startup time and never writes to your destination. Later export failures stop the command without restarting or overwriting completed rounds.

CPU capacity and currently available memory determine default concurrency. Native Windows uses 1–3 drawing workers plus one continuous audio worker, with a 2 GiB reserve and a 2 GiB-per-worker budget at 1080p (scaled up at higher resolutions). Mac uses one drawing worker and 1–16 x264 threads, reserving CPU capacity and limiting threads on low-memory machines. Portable CPU encoding uses 1–8 threads. These are conservative defaults, not measured optimal settings for every machine; explicit overrides remain available:

```sh
npm run render -- example.ttrm output.mp4 --backend portable --threads 4
npm run render -- example.ttrm output.mp4 --backend windows-nvidia --jobs 2
npm run render -- example.ttrm output.mp4 --backend mac --threads 16
```

An explicitly requested native backend fails if its startup check fails. Windows previews and single-round requests use the portable path automatically; explicit browser/encoder options also select that path. `--jobs` applies to native Windows; `--threads` applies to CPU encoders. The launcher prints its selection and concurrency. Native backends still require their preparation steps below; automatic selection does not install or compile dependencies. `npm run render-portable -- ...` directly runs the original portable renderer without native probing.

## Setup

Windows: install Node.js 22+ and Google Chrome, then run the following in PowerShell. The portable renderer uses Chrome's original WebGL renderer and a bundled FFmpeg executable; it does not need native compilation or a separate FFmpeg installation.

```powershell
npm ci --omit=dev
npm run prepare-client -- "C:\path\example.ttrm"
npm run render -- "C:\path\example.ttrm" output/preview.mp4 --duration 10 --export-rounds --deterministic
```

The default is 1920×1080 at 60 fps with continuous stereo AAC audio. The browser encoder is tested before exporting: automatic selection tries H.264 hardware, software and alternative profiles, then falls back to CPU x264 through FFmpeg. `--encoder ffmpeg` forces the fallback; `--threads N` overrides its CPU-adaptive thread count. The fallback preserves the same simulation and audio timeline, but transfers raw pixels and is slower. `--encoder hardware` requires a working browser hardware configuration. JSON reports record the selected backend/configuration and failed probes. Automatic fallback handles unavailable encoders during startup; an encoder or GPU failure during export fails the command rather than restarting the match.

For a smaller test add `--width 1280 --height 720`. `--software` selects software WebGL independently of the video encoder. If Chrome is installed elsewhere, pass `--chrome "C:\path\chrome.exe"` to both preparation and rendering.

The fast Windows x64 command requires an NVIDIA GPU with working NVENC support, the full dependencies, and Visual Studio C++ Build Tools plus the Windows SDK for one-time preparation:

```powershell
npm ci
npm run prepare-windows-fast -- "C:\path\example.ttrm"
npm run render-windows-fast -- "C:\path\example.ttrm" output/match.mp4
```

`prepare-windows-fast` builds the native audio mixer, ANGLE binding and NVENC encoder, then warms the audio cache. `render-windows-fast` selects the audited D3D11/NVENC configuration: an adaptive number of drawing workers, direct cached-file serving, a continuous audio-only worker and Windows Media Foundation AAC. Use `--jobs N` to change the drawing-worker count. For short previews (`--duration`) or non-NVIDIA machines, use `render --backend portable` or the automatic `render` command above.

On laptops with integrated and NVIDIA graphics, the native Windows renderer asks ANGLE to use the NVIDIA adapter. If updating an existing build, rerun `prepare-windows-fast` on Windows before repackaging the desktop app so the updated native modules are included.

This native configuration exported the tested 318.85-second, nine-round match in **44.42 seconds for the complete command (7.18×)**. All 19,131 round/master frames, all 160 reference-image samples, complete audio timing and all nine decoded round-audio coverage/alignment checks passed. Original high graphics, 1080p60 and AA4 are retained. The AAC encoder and signed 16-bit input conversion are documented in the [Windows notes](notes/windows-support.md#paused-handoff). Speed varies with hardware and replay; Windows 10× was not achieved.

**Speed optimization is paused at the user's request (2026-11-04).** The public fast launcher now selects the audited configuration above; later D3D12/compute experiments remain available through the lower-level native commands. A standalone native installer and validation on other Windows machines remain unfinished.

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

On NVIDIA Windows machines use `npm run render-windows-fast -- example.ttrm output.mp4`. For automatic selection use `npm run render -- example.ttrm output.mp4`; to force the portable path add `--backend portable`. The commands in this section using `render-fast` apply to Apple Silicon macOS only.

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

The pipeline uses one continuous native simulation, an asynchronous ANGLE driver, one GPU pass to pack video planes, and an adaptive CPU encoding thread count. The historical benchmark used sixteen encoder threads. It avoids browser-compositor capture and full-frame CPU readback. Reserving the MP4 index up front avoids moving the completed video a second time. More independent renderers were slower on this machine and changed continuity in older experiments, so the default keeps one match timeline.

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
npm run test:selection
```

The timestamp check allows only final AAC packet padding; round PCM is independently compared with the continuous master during export. These checks establish file/timeline integrity, and do not replace listening to the output. See [Windows progress and limitations](notes/windows-support.md) for the tested machine, commands and packaging status.

`--threads N` (or `REPLAY_X264_THREADS=N` on the Mac launcher) can override the encoding thread count. Extra threads are not a linear speed multiplier because rendering and encoding share the same CPU and GPU.

## Other backends

The portable Chrome exporter is available with `npm run render-portable -- example.ttrm output.mp4 --export-rounds`; it requires Google Chrome and is slower than the native Mac path. Older parallel and diagnostic backends remain experimental. Their measurements and limitations are documented in [the performance notes](notes/native-performance.md).

TETR.IO and its assets remain the property of their respective owners. Client patches target the pinned build and fail if expected source code changes.
