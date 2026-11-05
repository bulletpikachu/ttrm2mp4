import { mkdir, readFile, writeFile, cp, access, readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { windowsBuildEnvironment } from './windows-build-env.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Requires Windows x64');
const { root, cache, env, cl, headers, hook } = await windowsBuildEnvironment();
const dependency = path.join(root, 'node_modules/@onirenaud/node-webgl'), target = path.join(root, '.native-deps/node-webgl-windows');
if (JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8')).version !== '0.2.0') throw Error('Requires pinned node-webgl 0.2.0');
await mkdir(target, { recursive: true });
async function run(command, args) {
  const child = spawn(command, args, { cwd: target, env, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`${command}: ${code}`))); });
}
const libraries = path.join(target, 'angle'); await mkdir(libraries, { recursive: true });
const archive = path.join(libraries, 'angle.zip');
try { await access(path.join(libraries, 'libEGL.lib')); } catch {
  const url = 'https://github.com/godotengine/godot-angle-static/releases/download/chromium%2F7578/godot-angle-static-x86_64-msvc-release.zip';
  const response = await fetch(url); if (!response.ok) throw Error(`ANGLE download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()); await writeFile(archive, bytes);
  await writeFile(path.join(libraries, 'download.json'), JSON.stringify({ url, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
  await run('tar.exe', ['-xf', archive, '-C', libraries]);
  for (const name of await readdir(libraries)) {
    const match = /^lib(EGL|GLES|ANGLE)\./.exec(name);
    if (match && name !== `lib${match[1] === 'GLES' ? 'GLESv2' : match[1]}.lib`) await rename(path.join(libraries, name), path.join(libraries, `lib${match[1] === 'GLES' ? 'GLESv2' : match[1]}.lib`));
  }
}
let source = await readFile(path.join(dependency, 'src/native/addon.cc'), 'utf8');
function replace(needle, replacement) { if (source.split(needle).length !== 2) throw Error('Pinned binding patch mismatch'); source = source.replace(needle, replacement); }
const shaderBuildHash=createHash('sha256');
for(const name of ['libEGL','libGLESv2','libANGLE'])shaderBuildHash.update(await readFile(path.join(libraries,name+'.lib')));
replace('#include <vector>',`#include <vector>\n#define REPLAY_SHADER_CACHE_BUILD "${shaderBuildHash.digest('hex')}"\n#include "${path.join(root,'src/experimental/native/windows-shader-cache.inc').replaceAll('\\','/')}"`);
// NVENC consumes textures on ANGLE's device, so choose the NVIDIA adapter
// when creating the display, before any WebGL contexts or textures exist.
const displayAttribs = '  if (!BackendAttribs(backend, attrs, err)) return false;';
replace(displayAttribs, `${displayAttribs}
  const char* nvidia = getenv("REPLAY_WINDOWS_NVIDIA_ADAPTER");
  if (nvidia && strcmp(nvidia, "1") == 0) {
    if (backend != "d3d11" || !HasClientExtension("EGL_ANGLE_platform_angle_device_id")) {
      err = "ANGLE D3D11 adapter selection unavailable";
      return false;
    }
    // On D3D11, the high part is the PCI vendor ID and zero matches any device ID.
    attrs.insert(attrs.end() - 1, {EGL_PLATFORM_ANGLE_DEVICE_ID_HIGH_ANGLE, 0x10de});
  }`);
replace('if (TryInitDisplay(c, api, err)) return DisplayInfo(env);','if (TryInitDisplay(c, api, err)) { try { ReplayShaderCache::Start(g_display.dpy,egl.GetProcAddress,g_display.vendor,g_display.version); } catch (const std::exception& error) { return Throw(env,error.what()); } return DisplayInfo(env); }');
replace('NAPI_MODULE_INIT() {', `static napi_value ReplayEGL(napi_env env,napi_callback_info){napi_value out;napi_create_external(env,(void*)egl.GetProcAddress,nullptr,nullptr,&out);return out;}\nNAPI_MODULE_INIT() {`);
replace('  add("hasProc", GetProcAvailable);', '  add("hasProc", GetProcAvailable);\n  add("_replayEGL", ReplayEGL);\n  add("_replayShaderCacheStats", ReplayShaderCache::Stats);');
await writeFile(path.join(target, 'addon.cc'), source);
const binary = path.join(target, 'node-webgl-windows.node');
await run(cl, ['/nologo', '/O2', '/std:c++17', '/MT', '/utf-8', '/EHsc', '/LD', '/DNAPI_VERSION=8', '/DKHRONOS_STATIC', '/DEGLAPI=', '/DGL_APICALL=', '/DANGLE_STATIC', '/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN', '/DHOST_BINARY="node.exe"', `/I${headers}`, `/I${path.join(dependency, 'angle/include')}`, `/I${path.join(dependency, 'src/native')}`, path.join(target, 'addon.cc'), path.join(dependency, 'src/native/astcenc_stub.cc'), hook,
  '/link', path.join(cache, 'node.lib'), ...['libEGL', 'libGLESv2', 'libANGLE'].map(p => path.join(libraries, p + '.lib')), ...['d3d11', 'dxgi', 'dxguid', 'd3d9', 'gdi32', 'user32', 'synchronization', 'dcomp', 'delayimp', 'bcrypt'].map(p => p + '.lib'), '/DELAYLOAD:node.exe', `/OUT:${binary}`, `/IMPLIB:${path.join(target, 'node-webgl.lib')}`]);
await cp(path.join(dependency, 'dist'), path.join(target, 'dist'), { recursive: true });
const loaderFile = path.join(target, 'dist/native.js');
let loader = await readFile(loaderFile, 'utf8');
if (loader.split('native = gypBuild(packageRoot);').length !== 2) throw Error('Pinned JS loader mismatch');
loader = loader.replace('native = gypBuild(packageRoot);', `native = require(join(packageRoot, 'node-webgl-windows.node'));`);
await writeFile(loaderFile, loader); await writeFile(path.join(target, 'package.json'), '{"type":"module","private":true}\n');
console.log('Built local Windows ANGLE binding with EGL interop access; installed dependency unchanged.');
