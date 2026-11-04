import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { createFFmpegVideo } from '../src/offline/ffmpeg-video.mjs';

let packets = [];
const encoder = createFFmpegVideo(ffmpeg, async bytes => { packets.push(bytes); }, 2);
for (let segment = 0; segment < 2; segment++) {
  packets = [];
  encoder.start({ width: 64, height: 64, fps: 60 });
  for (let i = 0; i < 15; i++) await encoder.write(Buffer.alloc(64 * 64 * 4, i * 15));
  await encoder.finish();
  await encoder.finish();
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-f', 'framemd5', 'pipe:1'], { input: Buffer.concat(packets) });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(decoded.stdout.toString().split('\n').filter(line => line && !line.startsWith('#')).length, 15);
}
encoder.start({ width: 64, height: 64, fps: 60 });
await encoder.write(Buffer.alloc(64 * 64 * 4));
await encoder.close();
const missing = createFFmpegVideo('nonexistent-replay-ffmpeg', async () => {});
missing.start({ width: 64, height: 64, fps: 60 });
await assert.rejects(missing.finish());
await missing.close();
console.log('PASS: CPU encoder drains all frames, restarts at round boundaries, cancels, and reports startup failures.');
