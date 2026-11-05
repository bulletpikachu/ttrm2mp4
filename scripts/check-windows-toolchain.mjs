import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {discoverWindowsToolchain} from './windows-toolchain.mjs';
const root=await mkdtemp(path.join(tmpdir(),'replay-toolchain-check-'));
try{
  const compilerRoot=path.join(root,'Custom VS/VC/Tools/MSVC/14.50'),sdkRoot=path.join(root,'Custom SDK'),sdkVersion='10.0.26100.0';
  const files=[path.join(compilerRoot,'bin/Hostx64/x64/cl.exe'),...['Include/'+sdkVersion+'/um/windows.h','Include/'+sdkVersion+'/ucrt/stdlib.h','Lib/'+sdkVersion+'/um/x64/d3d11.lib','Lib/'+sdkVersion+'/ucrt/x64/ucrt.lib'].map(file=>path.join(sdkRoot,file))];
  for(const file of files){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'fixture');}
  const direct=await discoverWindowsToolchain({REPLAY_MSVC_ROOT:compilerRoot,REPLAY_WINDOWS_SDK:sdkRoot},{platform:'win32'});
  assert.deepEqual(direct,{compilerRoot,sdkRoot,sdkVersion});
  const vswhere=path.join(root,'custom-vswhere.exe');await writeFile(vswhere,'fixture');
  const discovered=await discoverWindowsToolchain({REPLAY_VSWHERE:vswhere},{platform:'win32',run(command){return command==='reg.exe'?`KitsRoot10    REG_SZ    ${sdkRoot}\n`:JSON.stringify([{installationPath:path.join(root,'Custom VS')}]);}});
  assert.deepEqual(discovered,direct);
  await assert.rejects(discoverWindowsToolchain({REPLAY_MSVC_ROOT:compilerRoot,REPLAY_WINDOWS_SDK:sdkRoot,REPLAY_WINDOWS_SDK_VERSION:'missing'},{platform:'win32'}),/complete Windows SDK/);
  console.log('PASS: custom compiler/SDK paths, installation discovery, numeric SDK selection and incomplete SDK rejection.');
}finally{await rm(root,{recursive:true,force:true});}
