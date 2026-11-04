import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/offline/video-encoder.js', import.meta.url), 'utf8');
const base = { codec: 'avc1.640033', width: 1280, height: 720, framerate: 60 };
function environment(behavior) {
  const probes = [];
  class Encoder {
    static async isConfigSupported(config) { return { supported: behavior(config) !== 'unsupported' }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; probes.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    encode() {}
    async flush() {
      if (behavior(this.config) === 'failure') throw Error('Driver initialization failed');
      this.callbacks.output({});
    }
    close() { this.state = 'closed'; }
  }
  const scope = { window: {}, document: { createElement: () => ({ getContext: () => ({ fillRect() {} }) }) },
    VideoFrame: class { close() {} }, ...(behavior ? { VideoEncoder: Encoder } : {}) };
  vm.runInNewContext(source, scope);
  return { select: scope.window.__selectVideoEncoder, probes };
}
assert.equal((await environment().select(base, 'auto')).backend, 'ffmpeg');
assert.equal((await environment(() => 'unsupported').select(base, 'auto')).backend, 'ffmpeg');
const broken = environment(() => 'failure');
assert.equal((await broken.select(base, 'auto')).backend, 'ffmpeg');
assert(broken.probes.every(probe => probe.state === 'closed'));
const software = environment(config => config.hardwareAcceleration === 'prefer-hardware' ? 'failure' : 'ok');
const selected = await software.select(base, 'auto');
assert.equal(selected.config.hardwareAcceleration, 'prefer-software');
assert(selected.attempts.length > 0);
assert(software.probes.every(probe => probe.state === 'closed'));
const profile = await environment(config => config.codec === 'avc1.640033' ? 'unsupported' : 'ok').select(base, 'auto');
assert.equal(profile.config.codec, 'avc1.4d0033');
await assert.rejects(environment().select(base, 'hardware'), /--encoder auto/);
assert.equal((await environment(() => { throw Error('Must not probe'); }).select(base, 'ffmpeg')).backend, 'ffmpeg');
console.log('PASS: missing/unsupported/broken H.264 falls back; software/profile retries and probe cleanup pass.');
