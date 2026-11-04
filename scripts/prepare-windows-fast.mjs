import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), replay = process.argv[2];
if (!replay || process.argv.length !== 3) throw Error('Usage: npm run prepare-windows-fast -- replay.ttrm (prepare-client must already be complete)');
async function run(script, args = []) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`${script}: ${code}`))); });
}
await run('scripts/build-windows-audio.mjs');
const temporary = await mkdtemp(path.join(tmpdir(), 'replay-prepare-windows-'));
try { await run('src/render-windows-fast.mjs', [path.resolve(replay), path.join(temporary, 'warmup.mp4'), '--duration', '0.1']); }
finally { await rm(temporary, { recursive: true, force: true }); }
console.log('Windows native audio module and decoded-audio cache are ready.');
