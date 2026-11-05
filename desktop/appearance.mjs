import {readFile,rename,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {importAppearance,maxAppearanceBytes} from '../src/offline/appearance.mjs';

export async function storedAppearance(file) {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch (error) { if(error.code==='ENOENT')return {};throw error; }
}

export function summarizeAppearance(profile) {
  return {
    ttc:profile.ttc,
    tpse:profile.tpse,
    videoCount:Object.keys(profile.video||{}).length,
    assetCount:Object.keys(profile.assets||{}).length,
  };
}

export async function updateAppearance(file, imported) {
  if (!imported) {
    await rm(file,{force:true});
    return summarizeAppearance({});
  }
  const profile=await storedAppearance(file);
  const {kind,name,warnings}=imported;
  profile[kind]={name,warnings};
  if(kind==='ttc')profile.video=imported.video;
  else profile.assets=imported.assets;
  const json=JSON.stringify(profile);
  if (Buffer.byteLength(json)>maxAppearanceBytes)throw Error('Imported appearance is too large');
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temporary,json,{flag:'wx'});
    await rename(temporary,file);
  } finally { await rm(temporary,{force:true}); }
  return summarizeAppearance(profile);
}

export function readImport(file,nativeImage) {
  return importAppearance(file,(bytes,dimensions)=>{
    let image=nativeImage.createFromBuffer(bytes);
    const {width,height}=image.getSize();
    if(image.isEmpty()||width>8192||height>8192)throw Error('Invalid or oversized image');
    if(dimensions){
      if(width!==dimensions.sourceSize||height!==dimensions.sourceSize)throw Error('Expected a '+dimensions.sourceSize+' × '+dimensions.sourceSize+' connected skin atlas');
      if(width!==dimensions.width||height!==dimensions.height){
        image=image.resize({width:dimensions.width,height:dimensions.height,quality:'good'});
      }
    }
    return image.toPNG();
  });
}
