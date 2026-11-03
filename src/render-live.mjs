#!/usr/bin/env node
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile, mkdir, mkdtemp, rm, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Usage: npm run render -- replay.ttrm [output.mp4] [options]

Uses TETR.IO's live, native WebGL replay player and records its tab audio/video.
Requires Google Chrome and internet access. Playback records in real time.

  --width N       Video width (default 1920, even number)
  --height N      Video height (default 1080, even number)
  --fps N         Capture frame rate (default 60, 1–60)
  --round N       Render only this round (1-based; default: entire match)
  --duration N    Stop after N seconds (useful for previews)
  --headed        Show the browser while rendering
  --software      Use software WebGL instead of the GPU (slower)
  --chrome PATH   Chrome executable (default: installed Google Chrome)
  --overwrite     Replace an existing output
  --help          Show this help
`;

function positive(value, name, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw Error(`${name} must be a positive number${max < Infinity ? ` up to ${max}` : ''}.`);
  return n;
}

async function encode(input, output, fps) {
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast',
    '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', output], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  proc.stderr.on('data', b => { errors = (errors + b).slice(-8000); });
  const [code] = await once(proc, 'exit');
  if (code !== 0) throw Error(`Video encoding failed (${code}): ${errors}`);
}

async function main() {
  const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: {
    width: { type: 'string', default: '1920' }, height: { type: 'string', default: '1080' },
    fps: { type: 'string', default: '60' }, round: { type: 'string' }, duration: { type: 'string' },
    headed: { type: 'boolean' }, software: { type: 'boolean' }, chrome: { type: 'string' },
    overwrite: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (opts.help) return console.log(HELP);
  if (positionals.length < 1 || positionals.length > 2) throw Error(HELP);
  const width = positive(opts.width, 'width', 7680), height = positive(opts.height, 'height', 4320);
  if (![width, height].every(n => Number.isInteger(n) && n % 2 === 0)) throw Error('Width and height must be even integers.');
  const fps = positive(opts.fps, 'fps', 60);
  if (!Number.isInteger(fps)) throw Error('fps must be an integer.');
  const duration = opts.duration ? positive(opts.duration, 'duration') : null;
  const input = path.resolve(positionals[0]);
  if (path.extname(input).toLowerCase() !== '.ttrm') throw Error('Input must be a .ttrm replay.');
  const raw = await readFile(input, 'utf8');
  const replay = JSON.parse(raw);
  const rounds = replay.replay?.rounds;
  if (!Array.isArray(rounds) || !rounds.length || rounds.some(r => !Array.isArray(r) || r.length !== 2 || r.some(p => !p.replay || !Number.isFinite(p.replay.frames) || p.replay.frames <= 0 || !Array.isArray(p.replay.events)))) {
    throw Error('Expected a two-player .ttrm with complete replay data in each round.');
  }
  const round = opts.round ? positive(opts.round, 'round', rounds.length) : null;
  if (round !== null && !Number.isInteger(round)) throw Error('round must be an integer.');
  const output = path.resolve(positionals[1] ?? input.replace(/\.ttrm$/i, '.mp4'));
  if (path.extname(output).toLowerCase() !== '.mp4') throw Error('Output must have the .mp4 extension.');
  if (!opts.overwrite) {
    try { await access(output); throw Error(`Output already exists: ${output}. Use --overwrite to replace it.`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await mkdir(path.dirname(output), { recursive: true });
  // Keep the intermediate MP4 on the output filesystem so publishing is atomic.
  const temp = await mkdtemp(path.join(path.dirname(output), '.replay-render-'));
  let browser, video;
  let interrupted = false;
  const interrupt = () => { interrupted = true; browser?.close().catch(() => {}); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const expected = (round ? [rounds[round - 1]] : rounds).reduce((sum, r) => sum + Math.max(...r.map(p => p.replay.frames)) / 60, 0);
    console.log(`Loading TETR.IO — ${round ? `round ${round}` : `${rounds.length} rounds`}, ~${Math.ceil(expected)} seconds of gameplay.`);
    browser = await chromium.launch({
      ...(opts.chrome ? { executablePath: opts.chrome } : { channel: 'chrome' }),
      headless: !opts.headed,
      ignoreDefaultArgs: ['--mute-audio'],
      args: ['--autoplay-policy=no-user-gesture-required', '--enable-usermedia-screen-capturing',
        '--auto-select-tab-capture-source-by-title=TETR.IO', '--force-color-profile=srgb',
        ...(opts.software ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : process.platform === 'darwin' ? ['--use-angle=metal'] : [] )],
    });
    const session = await browser.newBrowserCDPSession();
    const { userAgent } = await session.send('Browser.getVersion');
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1,
      // The headless UA is rejected by TETR.IO; use this Chrome's regular identity.
      userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/'), locale: 'en-US', timezoneId: 'America/Los_Angeles' });
    page.setDefaultTimeout(120000);
    // Replay rendering needs only the game origin and its subdomains, not ad providers.
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      return /(^|\.)tetr\.io$/.test(u.hostname) || ['blob:', 'data:'].includes(u.protocol) ? route.continue() : route.abort();
    });
    let renderer = '';
    const textureErrors = [];
    page.on('console', msg => {
      if (msg.text().includes('Renderer:')) renderer = msg.text().replace(/%c/g, '').split('color:')[0].trim();
      if (msg.type() === 'error' && msg.text().startsWith('Texture ')) textureErrors.push(msg.text());
    });
    await page.goto('https://tetr.io/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    console.log('Entering the anonymous game menu…');
    await page.locator('#entry_button').click();
    // The login form can appear before the asynchronous client has bound its
    // click handler. Retry only while that same anonymous entry form is visible.
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await page.waitForFunction(() => typeof window.DEVHOOK_LOAD_REPLAY_RAW === 'function', null, { timeout: 10000 });
        break;
      } catch (error) {
        if (attempt === 11) {
          await page.screenshot({ path: path.join(path.dirname(output), 'render-error.png') });
          throw Error('Game startup timed out; see render-error.png. ' + error.message);
        }
        if (await page.locator('#entry_button').isVisible()) await page.locator('#entry_button').click();
      }
    }
    console.log('Waiting for native graphics…');
    await page.waitForFunction(() => document.getElementById('pixi')?.width > 256);
    await page.waitForFunction(() => document.getElementById('preload')?.classList.contains('ready'));
    await page.waitForFunction(() => document.getElementById('preload')?.classList.contains('hidden'));
    await page.evaluate(() => document.fonts.ready);
    if (textureErrors.length) throw Error('Native textures failed to load: ' + textureErrors.join('; '));
    console.log(renderer || 'Native WebGL renderer ready.');
    await page.evaluate(({ raw, name }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([raw], name, { type: 'application/json' }));
      document.getElementById('menus').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { raw, name: path.basename(input) });
    await page.locator('#multilog .multilog_result').first().waitFor({ state: 'visible' });
    const count = await page.locator('#multilog .multilog_result').count();
    if (count !== rounds.length) throw Error(`Native player imported ${count} rounds; expected ${rounds.length}.`);
    video = await open(path.join(temp, 'capture.webm'), 'wx');
    await page.exposeBinding('__saveChunk', async (_source, base64) => { await video.write(Buffer.from(base64, 'base64')); });
    // getDisplayMedia needs a real click. Explicitly include the current tab so
    // Chrome's auto-select flag selects this tab rather than opening a picker.
    await page.evaluate(({ fps, width, height }) => {
      const button = document.createElement('button');
      button.id = 'render-start';
      button.textContent = 'Start recording';
      button.style = 'position:fixed;top:0;left:0;z-index:2147483647';
      button.onclick = async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: fps, max: fps }, width: { ideal: width }, height: { ideal: height } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            preferCurrentTab: true, selfBrowserSurface: 'include',
          });
          if (!stream.getAudioTracks().length) throw Error('Chrome did not provide tab audio.');
          window.__captureSettings = stream.getVideoTracks()[0].getSettings();
          const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
          if (!mimeType) throw Error('Chrome cannot encode WebM.');
          const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16000000, audioBitsPerSecond: 192000 });
          let pending = Promise.resolve();
          let failure;
          recorder.ondataavailable = event => {
            if (!event.data.size) return;
            pending = pending.then(async () => {
              const data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(';base64,') + 8));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(event.data);
              });
              await window.__saveChunk(data);
            }).catch(error => { failure = error; });
          };
          recorder.onerror = event => { failure = event.error || Error('MediaRecorder failed'); };
          window.__startRecording = () => recorder.start(1000);
          window.__stopRecording = () => new Promise((resolve, reject) => {
            recorder.onstop = async () => {
              await pending;
              stream.getTracks().forEach(t => t.stop());
              failure ? reject(failure) : resolve();
            };
            recorder.stop();
          });
          window.__captureReady = true;
          button.remove();
        } catch (e) { window.__captureError = e.message; }
      };
      document.body.append(button);
    }, { fps, width, height });
    await page.locator('#render-start').click();
    await page.waitForFunction(() => window.__captureReady || window.__captureError, null, { timeout: 20000 });
    const captureError = await page.evaluate(() => window.__captureError);
    if (captureError) throw Error(`Tab capture failed: ${captureError}`);
    const settings = await page.evaluate(() => window.__captureSettings);
    if (settings.width !== width || settings.height !== height) throw Error(`Chrome captured ${settings.width}×${settings.height}, expected ${width}×${height}.`);
    await page.mouse.move(width - 2, 2);
    await page.evaluate(() => window.__startRecording());
    await page.locator('#multilog .multilog_result').nth((round ?? 1) - 1).click();
    await page.waitForFunction(() => !document.getElementById('replaytools').classList.contains('hidden'));
    await page.evaluate(single => {
      document.getElementById(single ? 'replaytools_button_end' : 'replaytools_button_nextround').click();
    }, round !== null);
    console.log(`Recording ${width}×${height} at up to ${fps} fps, with native tab audio…`);
    const started = Date.now();
    const deadline = (duration ?? expected + rounds.length * 8 + 30) * 1000;
    let lastRound = '';
    let finished = false;
    while (Date.now() - started < deadline) {
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({
        label: document.getElementById('data_replay').textContent,
        ended: document.getElementById('replaytools').classList.contains('hidden'),
      }));
      if (state.label !== lastRound) { const number = state.label.match(/round\s+(\d+)/i)?.[1]; console.log(number ? `Round ${number} / ${rounds.length}` : state.label.trim()); lastRound = state.label; }
      if (state.ended) { finished = true; break; }
    }
    if (!duration && !finished) throw Error('Replay did not finish before the safety timeout; no completed MP4 was published.');
    await page.evaluate(() => window.__stopRecording());
    await video.close(); video = null;
    await browser.close(); browser = null;
    console.log('Encoding MP4…');
    const staged = path.join(temp, 'output.mp4');
    await encode(path.join(temp, 'capture.webm'), staged, fps);
    // Recheck in case another job created the destination while recording.
    if (!opts.overwrite) {
      try { await access(output); throw Error(`Output appeared while rendering: ${output}`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await rename(staged, output);
    console.log(`Saved ${output}`);
  } catch (error) {
    if (interrupted) throw Error('Rendering interrupted.');
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await video?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
