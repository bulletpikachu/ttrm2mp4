// Decode the delivered MP4 and verify its actual presentation timeline.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import assert from 'node:assert/strict';

const reportPath = process.argv[2];
if (!reportPath) throw Error('Usage: node scripts/verify-av.mjs output.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const video = [], audio = [];
let tail = '', errors = '', videoTimeBase;
const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', report.output,
  '-map', '0:v:0', '-map', '0:a:0', '-vf', 'showinfo', '-af', 'ashowinfo,volumedetect',
  '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
function line(text) {
  const timeBase = /Parsed_showinfo_.*config in time_base:\s*(\d+)\/(\d+)/.exec(text);
  if (timeBase) videoTimeBase = { numerator: +timeBase[1], denominator: +timeBase[2] };
  // pts_time is rounded to six significant digits by FFmpeg. Above 100 s,
  // that display rounding exceeds the former tolerance; use integer PTS.
  const v = /Parsed_showinfo_.* n:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(text);
  if (v) video.push({ index: +v[1], pts: +v[2] });
  const a = /Parsed_ashowinfo_.* n:(\d+)\s+pts:(-?\d+).*?channels:(\d+).*?rate:(\d+) nb_samples:(\d+)/.exec(text);
  if (a) audio.push({ index: +a[1], pts: +a[2], channels: +a[3], rate: +a[4], samples: +a[5] });
}
child.stderr.on('data', bytes => {
  errors = (errors + bytes).slice(-6000);
  const lines = (tail + bytes).split(/[\r\n]+/); tail = lines.pop(); lines.forEach(line);
});
await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(Error(errors)));
});
line(tail);
assert.equal(video.length, report.count, 'Decoded video frame count');
assert(audio.length > 0, 'Decoded audio is present');
assert(videoTimeBase?.numerator > 0 && videoTimeBase?.denominator > 0, 'Video time base is present');
assert.equal(video[0].pts, 0, 'Video starts at zero');
assert.equal(audio[0].pts, 0, 'Audio starts at zero after AAC priming');
for (const [i, frame] of video.entries()) {
  assert.equal(frame.index, i);
  assert.equal(frame.pts * videoTimeBase.numerator * report.fps, i * videoTimeBase.denominator, `Video timestamp at frame ${i}`);
}
let samples = 0;
for (const frame of audio) {
  assert.equal(frame.channels, 2, 'Stereo audio');
  assert.equal(frame.rate, report.sampleRate);
  assert.equal(frame.pts, samples, 'Contiguous audio sample timestamps');
  samples += frame.samples;
}
assert.equal(report.samples, Math.round(report.count / report.fps * report.sampleRate));
assert(samples >= report.samples && samples - report.samples < 1024, 'Only final AAC packet padding is allowed');
assert(!/mean_volume: -inf/.test(errors), 'Audio must not be silent');
assert(/mean_volume:/.test(errors), 'Audio level was measured');
console.log(`PASS: ${video.length} frames at ${report.fps} fps; audio/video start at zero; contiguous stereo audio covers ${report.samples} timeline samples (+${samples - report.samples} AAC padding).`);
console.log(errors.match(/mean_volume:.*|max_volume:.*/g)?.join('\n'));
