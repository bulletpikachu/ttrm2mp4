# ttrm2mp4

Convert TETR.IO single-player replays (`.ttr`) and two-player matches (`.ttrm`) to MP4.

## Desktop app

To run from source, install Node.js 22 or newer and run these commands in the project folder.

```sh
npm ci
npm run desktop
```

Click **Set up & render** on first use to download the game files. This requires an internet connection. No internet connection is needed for later exports.

Use **Import appearance** to load TETR.IO settings (`.ttc`) or a TETR.IO PLUS pack (`.tpse`).

## Command line

Install Node.js 22 or newer and Google Chrome. Run `prepare-client` once while online to download the game files.

```sh
npm ci --omit=dev
npm run prepare-client -- example.ttrm
npm run render -- example.ttrm output.mp4
```

The default is 1080p at 60 fps. The command saves the main MP4 and writes individual clips to `output-rounds/` as they finish.

```sh
npm run render -- example.ttrm highlights.mp4 --rounds 1,3,5
npm run render -- --help
```

Selected rounds play in match order, and individual clips keep their original round numbers. The renderer uses a prepared native backend when available and falls back to Chrome. [Native setup for Apple Silicon and NVIDIA Windows](AGENTS.md#native-renderer-setup)
