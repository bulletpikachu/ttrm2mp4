import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { windowsBuildEnvironment } from './windows-build-env.mjs';
const { root, cache, env, cl, headers, hook } = await windowsBuildEnvironment();
const target = path.join(root, '.native-deps/windows-gpu'); await mkdir(target, { recursive: true });
const dependency = path.join(root, 'node_modules/@onirenaud/node-webgl');
const child = spawn(cl, ['/nologo','/O2','/utf-8','/std:c++17','/MD','/EHsc','/LD','/DHOST_BINARY="node.exe"',`/I${headers}`,`/I${target}`,`/I${path.join(dependency,'angle/include')}`,path.join(root,'src/experimental/native/windows-encoder.cc'),hook,
  '/link',path.join(cache,'node.lib'),'d3d11.lib','d3d12.lib','d3dcompiler.lib','dxgi.lib','dxguid.lib','delayimp.lib','/DELAYLOAD:node.exe',`/OUT:${path.join(target,'windows-encoder.node')}`],{cwd:target,env,stdio:'inherit',windowsHide:true});
await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(`Native Windows encoder build: ${code}`)));});
