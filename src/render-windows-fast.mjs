#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run render-windows-fast -- input.ttrm output.mp4 [--duration N] [--overwrite]\n\nExperimental Windows x64 GPU export with direct media writes, native exact audio,\ncontinuous master audio, and progressive round files. Requires Electron and\nthe Windows audio module: npm run prepare-windows-fast -- input.ttrm.\nThe 10x speed target is not yet achieved.');
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Requires Windows x64; use render-fast on Apple Silicon or render for the portable browser path');
  try { await access(new URL('./experimental/native/audio-mixer.node', import.meta.url)); }
  catch { throw Error('Run npm run prepare-windows-fast -- input.ttrm first'); }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./render.mjs', import.meta.url)), ...args,
    '--engine', 'electron', '--direct-io', '--native-audio', '--export-rounds', '--deterministic'], {
    stdio: 'inherit', windowsHide: true, env: { REPLAY_STREAM_MUX: '1', REPLAY_RESERVE_MOOV: '1',
      REPLAY_FINAL_AUDIO_REUSE: '1', REPLAY_OVERLAP_ROUND_AUDIO: '1', REPLAY_NATIVE_INTERLEAVE: '1', REPLAY_AUDIO_DECODE_CACHE: '1', ...process.env },
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.exitCode = code ?? (signal ? 1 : 0); });
}
