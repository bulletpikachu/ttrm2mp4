#!/usr/bin/env node
import {forwardRenderEvents} from './offline/runtime.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { windowsFastEnvironment } from './offline/render-policy.mjs';
import { terminateWindowsProcessTree } from './offline/windows-process-tree.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run render-windows-fast -- input.ttrm output.mp4 [--jobs N] [--overwrite] [--report]\n\nWindows x64 NVIDIA D3D11/NVENC export with CPU/memory-adaptive drawing workers,\ncontinuous Media Foundation AAC audio and progressive round files.\nRun npm run prepare-windows-fast -- input.ttrm first.\nFor short previews or non-NVIDIA machines, use npm run render.');
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Requires Windows x64 with NVIDIA NVENC; use render-fast on Apple Silicon or render for the portable browser path');
  for (const name of ['src/experimental/native/audio-mixer.node', '.native-deps/node-webgl-windows/node-webgl-windows.node', '.native-deps/node-webgl-windows/dist/index.js', '.native-deps/windows-gpu/windows-encoder.node']) {
    try { await access(new URL('../' + name, import.meta.url)); }
    catch { throw Error('Native Windows modules are missing. Run npm run prepare-windows-fast -- input.ttrm first'); }
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./render-native-parallel.mjs', import.meta.url)),
    ...args, '--backend', 'windows'], {
    stdio: ['inherit','inherit','inherit','ipc'], windowsHide: true, env: windowsFastEnvironment(),
  });
  forwardRenderEvents(child);
  let stopping;
  const stop = () => { stopping ??= terminateWindowsProcessTree(child).catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.exitCode = code ?? (signal ? 1 : 0); });
}

process.once('beforeExit',()=>{if(process.connected)process.disconnect()});
