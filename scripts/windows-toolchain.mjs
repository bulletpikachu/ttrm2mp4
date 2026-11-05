import {access,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createRequire} from 'node:module';
const versions=values=>values.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
async function present(file){try{await access(file);return true;}catch{return false;}}
export async function discoverWindowsToolchain(env=process.env,{platform=process.platform,run=execFileSync}={}){
  if(platform!=='win32')throw Error('Windows toolchain discovery requires Windows');
  let compilerRoot=env.REPLAY_MSVC_ROOT||env.VCToolsInstallDir;
  if(!compilerRoot){
    const candidates=[env.REPLAY_VSWHERE,...[env['ProgramFiles(x86)'],env.ProgramFiles].filter(Boolean).map(base=>path.join(base,'Microsoft Visual Studio/Installer/vswhere.exe'))].filter(Boolean);
    const vswhere=(await Promise.all(candidates.map(present))).findIndex(Boolean);
    if(vswhere<0)throw Error('Visual Studio discovery unavailable. Install C++ Build Tools or set REPLAY_VSWHERE / REPLAY_MSVC_ROOT.');
    const installations=JSON.parse(run(candidates[vswhere],['-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json'],{encoding:'utf8',windowsHide:true}));
    for(const installation of installations.reverse()){
      const directory=path.join(installation.installationPath,'VC/Tools/MSVC');
      try{for(const version of versions(await readdir(directory))){const candidate=path.join(directory,version);if(await present(path.join(candidate,'bin/Hostx64/x64/cl.exe'))){compilerRoot=candidate;break;}}}catch{}
      if(compilerRoot)break;
    }
  }
  if(!compilerRoot||!await present(path.join(compilerRoot,'bin/Hostx64/x64/cl.exe')))throw Error('No x64 C++ compiler found. Set REPLAY_MSVC_ROOT to the MSVC version directory.');
  let sdkRoot=env.REPLAY_WINDOWS_SDK||env.WindowsSdkDir;
  if(!sdkRoot){
    for(const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots','HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots']){
      try{const text=run('reg.exe',['query',key,'/v','KitsRoot10'],{encoding:'utf8',windowsHide:true});sdkRoot=/KitsRoot10\s+REG_SZ\s+(.+)/i.exec(text)?.[1].trim();}catch{}
      if(sdkRoot)break;
    }
  }
  if(!sdkRoot)throw Error('Windows SDK not found. Set REPLAY_WINDOWS_SDK or use a Visual Studio developer environment.');
  const pinned=env.REPLAY_WINDOWS_SDK_VERSION||env.WindowsSDKVersion?.replace(/[\\/]+$/,'');
  let sdkVersion;
  for(const version of pinned?[pinned]:versions(await readdir(path.join(sdkRoot,'Lib')))){
    const required=[path.join(sdkRoot,'Include',version,'um/windows.h'),path.join(sdkRoot,'Include',version,'ucrt/stdlib.h'),path.join(sdkRoot,'Lib',version,'um/x64/d3d11.lib'),path.join(sdkRoot,'Lib',version,'ucrt/x64/ucrt.lib')];
    if((await Promise.all(required.map(present))).every(Boolean)){sdkVersion=version;break;}
  }
  if(!sdkVersion)throw Error('No complete Windows SDK found. Install the desktop C++ SDK or set REPLAY_WINDOWS_SDK_VERSION.');
  return {compilerRoot:path.resolve(compilerRoot),sdkRoot:path.resolve(sdkRoot),sdkVersion};
}

export async function windowsDelayLoadHook(env=process.env){
  if(env.REPLAY_DELAY_LOAD_HOOK){await access(env.REPLAY_DELAY_LOAD_HOOK);return path.resolve(env.REPLAY_DELAY_LOAD_HOOK);}
  const require=createRequire(import.meta.url);
  const search=[path.dirname(env.npm_execpath||process.execPath),path.dirname(process.execPath)];
  try{const pkg=require.resolve('node-gyp/package.json',{paths:search});const hook=path.join(path.dirname(pkg),'src/win_delay_load_hook.cc');await access(hook);return hook;}catch{}
  const conventional=path.join(path.dirname(process.execPath),'node_modules/npm/node_modules/node-gyp/src/win_delay_load_hook.cc');
  if(await present(conventional))return conventional;
  throw Error('Node delay-load hook not found. Set REPLAY_DELAY_LOAD_HOOK or install node-gyp in the build environment.');
}
