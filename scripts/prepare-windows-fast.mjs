import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Requires Windows x64 with NVIDIA NVENC');
const root = fileURLToPath(new URL('../', import.meta.url)), replay = process.argv[2];
if (!replay || process.argv.length !== 3) throw Error('Usage: npm run prepare-windows-fast -- replay.ttrm (prepare-client must already be complete)');
async function run(script, args = [], env = process.env) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true, env });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`${script}: ${code}`))); });
}
for (const script of ['build-windows-audio.mjs', 'build-windows-webgl.mjs', 'fetch-windows-nvenc.mjs', 'build-windows-encoder.mjs']) await run('scripts/' + script);
const temporary = await mkdtemp(path.join(tmpdir(), 'replay-prepare-windows-'));
try { await run('src/render.mjs', [path.resolve(replay), path.join(temporary, 'warmup.mp4'), '--duration', '0.1', '--engine', 'electron', '--direct-io', '--native-audio', '--export-rounds', '--deterministic'], { ...process.env, REPLAY_AUDIO_DECODE_CACHE: '1', REPLAY_NATIVE_INTERLEAVE: '1' }); }
finally { await rm(temporary, { recursive: true, force: true }); }
console.log('Windows native audio, ANGLE/D3D11, NVENC and decoded-audio cache are ready.');
