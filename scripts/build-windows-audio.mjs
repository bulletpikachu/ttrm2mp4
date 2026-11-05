// Build the existing portable N-API mixer with MSVC; no Mac sources/settings change.
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {discoverWindowsToolchain,windowsDelayLoadHook} from './windows-toolchain.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This build script requires Windows x64');
const cache = path.join(root, '.native-deps', 'windows-audio');
await mkdir(cache, { recursive: true });
const version = process.version, base = `https://nodejs.org/dist/${version}/`;
const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
async function download(name, local) {
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0];
  if (!expected) throw Error(`No official checksum for ${name}`);
  let bytes;
  try { bytes = await readFile(local); } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetch(base + name);
    if (!response.ok) throw Error(`Download failed: ${name}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error(`Checksum failed: ${name}`);
    await writeFile(local, bytes);
  }
}
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: cache, env, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`${command}: exit ${code}`))); });
}
const archive = `node-${version}-headers.tar.gz`;
await download(archive, path.join(cache, archive));
await download('win-x64/node.lib', path.join(cache, 'node.lib'));
const headers = path.join(cache, `node-${version}`, 'include', 'node');
try { await access(path.join(headers, 'node_api.h')); } catch { await run('tar.exe', ['-xzf', archive]); }
const {compilerRoot,sdkRoot:sdk,sdkVersion}=await discoverWindowsToolchain();
const bin = path.join(compilerRoot, 'bin/Hostx64/x64');
const env = { ...process.env, INCLUDE: [path.join(compilerRoot, 'include'), ...['ucrt', 'shared', 'um'].map(part => path.join(sdk, 'Include', sdkVersion, part))].join(';'),
  LIB: [path.join(compilerRoot, 'lib/x64'), ...['ucrt', 'um'].map(part => path.join(sdk, 'Lib', sdkVersion, part, 'x64'))].join(';') };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.Path = bin + ';' + process.env.Path;
const hook = await windowsDelayLoadHook();
const output = path.join(root, 'src/experimental/native/audio-mixer.node');
await run(path.join(bin, 'cl.exe'), ['/nologo', '/O2', '/fp:strict', '/std:c++17', '/MD', '/EHsc', '/LD', '/DHOST_BINARY="node.exe"', `/I${headers}`,
  path.join(root, 'src/experimental/native/audio-mixer.cc'), hook, '/link', path.join(cache, 'node.lib'), 'delayimp.lib', '/DELAYLOAD:node.exe', `/OUT:${output}`, `/IMPLIB:${path.join(cache, 'audio-mixer.lib')}`], env);
await writeFile(path.join(cache, 'build.json'), JSON.stringify({ version, compilerRoot, sdkRoot:sdk, sdkVersion, floatingPoint: 'strict', output }, null, 2));
console.log('Windows N-API audio mixer built with strict floating-point arithmetic.');
