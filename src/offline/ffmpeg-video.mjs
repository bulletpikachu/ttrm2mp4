import { spawn } from 'node:child_process';
import {hostResources,resourceDefaults} from './render-policy.mjs';

// Portable CPU fallback. Video and PCM still use the same controlled timeline.
export function createFFmpegVideo(ffmpeg, writeVideo, threads = resourceDefaults(hostResources()).portableThreads) {
  let active;
  return {
    threads,
    start({ width, height, fps }) {
      if (active) throw Error('FFmpeg video segment is already open');
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`,
        '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-crf', '18', '-threads', String(threads),
        '-pix_fmt', 'yuv420p', '-bf', '0', '-g', String(fps * 2), '-f', 'h264', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const segment = { child, failure: null, errors: '' };
      active = segment;
      child.stderr.on('data', bytes => { segment.errors = (segment.errors + bytes).slice(-6000); });
      child.stdin.on('error', error => { segment.failure ??= error; });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(Error(`FFmpeg video failed (${code}): ${segment.errors}`)));
      });
      const output = (async () => { for await (const bytes of child.stdout) await writeVideo(bytes); })();
      segment.completed = Promise.all([exited, output]);
      segment.completed.catch(error => { segment.failure ??= error; child.kill(); });
    },
    async write(bytes) {
      const segment = active;
      if (!segment) throw Error('No FFmpeg video segment is open');
      if (segment.failure) throw segment.failure;
      await new Promise((resolve, reject) => segment.child.stdin.write(bytes, error => error ? reject(error) : resolve()));
      if (segment.failure) throw segment.failure;
    },
    async finish() {
      if (!active) return;
      const segment = active;
      segment.child.stdin.end();
      try { await segment.completed; if (segment.failure) throw segment.failure; }
      finally { active = null; }
    },
    async close() {
      if (!active) return;
      const segment = active;
      segment.child.kill('SIGKILL');
      await segment.completed.catch(() => {});
      active = null;
    },
  };
}
