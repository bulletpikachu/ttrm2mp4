import {packager} from '@electron/packager';
import {execFile} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {createGunzip} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {Data} from 'resedit';
const execFileAsync=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(path.join(root,'node_modules/electron/package.json'),'utf8'));
const ffmpegRelease=JSON.parse(await readFile(path.join(root,'node_modules/ffmpeg-static/package.json'),'utf8'))['ffmpeg-static']['binary-release-tag'];
const assets=path.join(root,'desktop/assets');

function windowsIcon(images){
  const header=6+images.length*16;
  const output=Buffer.alloc(header+images.reduce((total,image)=>total+image.png.length,0));
  output.writeUInt16LE(0,0);
  output.writeUInt16LE(1,2);
  output.writeUInt16LE(images.length,4);
  let offset=header;
  images.forEach((image,index)=>{
    const at=6+index*16,dimension=image.size>=256?0:image.size;
    output.writeUInt8(dimension,at);
    output.writeUInt8(dimension,at+1);
    output.writeUInt16LE(1,at+4);
    output.writeUInt16LE(32,at+6);
    output.writeUInt32LE(image.png.length,at+8);
    output.writeUInt32LE(offset,at+12);
    image.png.copy(output,offset);
    offset+=image.png.length;
  });
  return output;
}

// Native icon files are derived from desktop/assets/icon.png.
async function deriveIcons(){
  if(process.platform!=='darwin')return;
  const source=path.join(assets,'icon.png');
  const directory=await mkdtemp(path.join(tmpdir(),'replay-icon-'));
  try{
    const iconset=path.join(directory,'icon.iconset');
    await mkdir(iconset);
    const mac=[[16,'icon_16x16.png'],[32,'icon_16x16@2x.png'],[32,'icon_32x32.png'],[64,'icon_32x32@2x.png'],[128,'icon_128x128.png']];
    const windows=[16,32,48,64,128];
    const pngs=new Map();
    for(const [size,name] of mac){
      const dest=path.join(iconset,name);
      await execFileAsync('sips',['-z',String(size),String(size),source,'--out',dest]);
      pngs.set(size,await readFile(dest));
    }
    for(const size of windows){
      if(pngs.has(size))continue;
      const dest=path.join(directory,`icon-${size}.png`);
      await execFileAsync('sips',['-z',String(size),String(size),source,'--out',dest]);
      pngs.set(size,await readFile(dest));
    }
    await execFileAsync('iconutil',['-c','icns',iconset,'-o',path.join(assets,'icon.icns')]);
    const ico=windowsIcon(windows.map(size=>({size,png:pngs.get(size)})));
    const parsed=Data.IconFile.from(ico);
    if(parsed.icons.length!==windows.length)throw Error('Windows icon is missing image sizes');
    await writeFile(path.join(assets,'icon.ico'),ico);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
}

const targets=(process.argv.slice(2).length?process.argv.slice(2):[`${process.platform}-${process.arch}`]).map(target=>{
  const match=/^(darwin|win32|linux|mas)-(ia32|x64|arm64|universal)$/.exec(target);
  if(!match)throw Error(`Unknown package target ${target}. Use darwin-arm64 or win32-x64.`);
  return {platform:match[1],arch:match[2]};
});
if(targets.some(({platform,arch})=>platform==='win32'&&arch==='x64')){
  // Packaging copies the prepared binaries verbatim. Check the strings used
  // by the hybrid-GPU fix in both modules before replacing an existing build.
  for(const [file,marker] of [
    ['.native-deps/node-webgl-windows/node-webgl-windows.node','REPLAY_WINDOWS_NVIDIA_ADAPTER'],
    ['.native-deps/windows-gpu/windows-encoder.node','NV_ENC_ERR_NO_ENCODE_DEVICE'],
  ]){
    let binary;
    try{binary=await readFile(path.join(root,file));}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!binary.includes(marker))throw Error(`Stale Windows native module: ${file}. Run npm run prepare-windows-fast -- replay.ttrm on Windows before packaging.`);
  }
}
await deriveIcons();
for(const {platform} of targets){
  const extension={darwin:'icns',win32:'ico'}[platform];
  if(extension)await access(path.join(assets,`icon.${extension}`));
}
const built=[];
for(const {platform,arch} of targets){
  built.push(...await packager({dir:root,name:'ttrm2mp4',executableName:'ttrm2mp4',appBundleId:'io.replayrender.desktop',appVersion:'0.1.0',electronVersion:version,platform,arch,out:path.join(root,'dist'),overwrite:true,asar:false,prune:true,win32metadata:{CompanyName:'ttrm2mp4'},
    icon:path.join(assets,'icon'),
    ignore:relative=>{
      const file=relative.replaceAll('\\','/');
      const top=file.replace(/^\//,'').split('/')[0];
      if(top&&!new Set(['package.json','package-lock.json','README.md','src','desktop','scripts','node_modules','.native-deps']).has(top))return true;
      if(/^\/(?:\.git|\.inspect|client|output|dist|\.replay-render-[^/]*)(?:\/|$)/.test(file))return true;
      if(/^\/\.native-deps\/(?!node-webgl-(?:local|windows)(?:\/|$)|windows-gpu(?:\/|$))/.test(file))return true;
      if(/^\/[^/]+-rounds(?:\/|$)/.test(file))return true;
      if(/\.(?:mp4|webm|dmg|ttrm|ttr|log)$/.test(file))return true;
      if(/^\/(?:output[^/]*|d49cd02df245[^/]*)\.json$/.test(file))return true;
      return false;
    },
    afterCopy:[async({buildPath,platform:copiedPlatform,arch:copiedArch})=>{
      // Older prepared mirrors may still contain a developer's absolute filename.
      for(const [folder,binary] of [['node-webgl-local','node-webgl-local.node'],['node-webgl-windows','node-webgl-windows.node']]){
        const loader=path.join(buildPath,'.native-deps',folder,'dist/native.js');
        try{let source=await readFile(loader,'utf8');source=source.replace(/native = require\([^\n]+\);/,`native = require(join(packageRoot, '${binary}'));`);await writeFile(loader,source);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      if(copiedPlatform!=='win32')return;
      const destination=path.join(buildPath,'node_modules/ffmpeg-static/ffmpeg.exe');
      const response=await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/${ffmpegRelease}/ffmpeg-${copiedPlatform}-${copiedArch}.gz`);
      if(!response.ok||!response.body)throw Error(`Could not download Windows ffmpeg (${response.status})`);
      await pipeline(Readable.fromWeb(response.body),createGunzip(),createWriteStream(destination));
    }],
  }));
}
console.log('Portable app folders:',built.join('\n'));
