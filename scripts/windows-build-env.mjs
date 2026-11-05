import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {discoverWindowsToolchain,windowsDelayLoadHook} from './windows-toolchain.mjs';
import { fileURLToPath } from 'node:url';
export async function windowsBuildEnvironment() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cache = path.join(root, '.native-deps/windows-audio');
  const { version } = JSON.parse(await readFile(path.join(cache, 'build.json'), 'utf8'));
  const {compilerRoot,sdkRoot:sdk,sdkVersion}=await discoverWindowsToolchain();
  const bin = path.join(compilerRoot, 'bin/Hostx64/x64');
  const env = { ...process.env,
    INCLUDE: [path.join(compilerRoot, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(p => path.join(sdk, 'Include', sdkVersion, p))].join(';'),
    LIB: [path.join(compilerRoot, 'lib/x64'), ...['ucrt', 'um'].map(p => path.join(sdk, 'Lib', sdkVersion, p, 'x64'))].join(';') };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = bin + ';' + process.env.Path;
  return { root, cache, env, cl: path.join(bin, 'cl.exe'), headers: path.join(cache, `node-${version}/include/node`),
    hook: await windowsDelayLoadHook() };
}
