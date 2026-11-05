import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';

const scalar = new Set(['particles','background','bounciness','shakiness','gridopacity','boardopacity','shadowopacity','bloom','chroma','flashwave']);
const flags = new Set(['alwaystiny','colorshadow','sidebyside','spin','kos','fire','guide','lowrescounters','nozenithanim']);
export const maxAppearanceBytes = 160 * 1024 ** 2;
const choices = {
  graphics: ['minimal','low','medium','high','ultra'],
  actiontext: ['none','off','some','all'],
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function videoPreferences(video) {
  if (!object(video)) return {};
  const result = {};
  for (const [key,value] of Object.entries(video)) {
    if (flags.has(key) && typeof value === 'boolean') result[key] = value;
    if (Object.hasOwn(choices,key) && choices[key].includes(value)) result[key] = value;
    if (scalar.has(key) || key === 'zoom') {
      const number = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
      if (Number.isFinite(number) && number >= (key === 'zoom' ? 0.25 : 0) && number <= (key === 'zoom' ? 3 : 2)) result[key] = number;
    }
  }
  return result;
}

function embedded(value, kind) {
  if (typeof value !== 'string') throw Error('Expected an embedded media file');
  const match = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !kind.test(match[1]) || match[2].length % 4 === 1) throw Error('Unsupported embedded media format');
  const bytes = Buffer.from(match[2],'base64');
  if (bytes.length > 32 * 1024 ** 2 || !bytes.length) throw Error('Embedded file is too large or empty');
  return bytes;
}

function soundBank(data) {
  const audio = embedded(data.customSounds,/^audio\/(ogg|opus|wav|wave|mpeg|mp4|webm|x-wav)$/);
  if (!object(data.customSoundAtlas)) throw Error('Missing sound effect atlas');
  const sounds = Object.entries(data.customSoundAtlas);
  if (!sounds.length || sounds.length > 2048) throw Error('Invalid sound effect count');
  for (const [name, timing] of sounds) {
    if (!/^[\w.-]{1,100}$/.test(name) || !Array.isArray(timing) || timing.length !== 2 ||
        timing.some(value => !Number.isFinite(value) || value < 0) || timing[0]+timing[1] > 3600000) {
      throw Error('Invalid sound effect timing');
    }
  }
  sounds.sort((a,b)=>a[1][0]-b[1][0]);
  const header = Buffer.alloc(12);
  header.write('tRSD');
  header.writeUInt32LE(1,4);
  const chunks = [header];
  for (const [name,[offset]] of sounds) {
    const label = Buffer.from(name);
    const entry = Buffer.alloc(8);
    entry.writeFloatLE(offset / 1000);
    entry.writeUInt32LE(label.length,4);
    chunks.push(entry,label);
  }
  const end = Buffer.alloc(12);
  end.writeFloatLE(sounds.at(-1)[1].reduce((a,b)=>a+b) / 1000);
  end.writeUInt32LE(audio.length,8);
  return Buffer.concat([...chunks,end,audio]);
}

const imagePaths = {
  board:'/res/skins/board/generic/board.png',
  queue:'/res/skins/board/generic/queue.png',
  grid:'/res/skins/board/generic/grid.png',
};
const particles = ['beam','beams_beam','bigbox','box','chip','chirp','dust','fbox','fire','particle','smoke','star','flake'];
for (const key of particles) imagePaths['particle_'+key] = '/res/particles/'+key.replace('_','/')+'.png';
for (const rank of ['d','dplus','cminus','c','cplus','bminus','b','bplus','aminus','a','aplus','sminus','s','splus','ss','u','x','xplus','z']) {
  imagePaths['rank_'+rank] = '/res/league-ranks/'+rank.replace('plus','+').replace('minus','-')+'.png';
}
const backgroundPath='/res/bg/*';
const soundPath='/sfx/tetrio.opus.rsd';
const connectedPaths = ['/res/skins/minos/connected.png','/res/skins/minos/connected.2x.png','/res/skins/ghost/connected.png','/res/skins/ghost/connected.2x.png'];
const allowedPaths = new Set([...Object.values(imagePaths),...connectedPaths,backgroundPath,soundPath]);

export async function importAppearance(file, normalizeImage) {
  const kind = path.extname(file).slice(1).toLowerCase();
  if (!['ttc','tpse'].includes(kind)) throw Error('Choose a .ttc or .tpse file');
  const info=await stat(file);
  if (!info.isFile() || info.size > 64 * 1024 ** 2) throw Error('Choose an export smaller than 64 MB');
  let data;
  try { data=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,'')); }
  catch { throw Error('This settings export is not valid JSON'); }
  if (!object(data)) throw Error('Invalid settings export');
  const result={kind,name:path.basename(file),video:{},assets:{},warnings:[]};
  if (kind==='ttc') {
    result.video=videoPreferences(data.video);
    if (!Object.keys(result.video).length) throw Error('This TTC has no supported video settings');
    if (data.video.background_url) result.warnings.push('Background URLs require an embedded image in a TPSE pack.');
    return result;
  }
  const image = (value, dimensions) => normalizeImage(embedded(value,/^image\/(png|jpeg|webp)$/), dimensions);
  for (const [key,address] of Object.entries(imagePaths)) {
    if (data[key] == null) continue;
    try { result.assets[address]=image(data[key]).toString('base64'); }
    catch(error) { result.warnings.push(key+': '+error.message); }
  }
  for (const [key,group,size] of [['skin','minos',2048],['ghost','ghost',1024]]) {
    if (data[key]==null) continue;
    try {
      const normal=image(data[key],{sourceSize:size,width:size/2,height:size/2});
      const large=image(data[key],{sourceSize:size,width:size,height:size});
      result.assets['/res/skins/'+group+'/connected.png']=normal.toString('base64');
      result.assets['/res/skins/'+group+'/connected.2x.png']=large.toString('base64');
    } catch(error) { result.warnings.push(key+': '+error.message); }
  }
  const backgrounds=Array.isArray(data.backgrounds)?data.backgrounds:[];
  if (backgrounds.length && data.bgEnabled !== false) {
    const still=backgrounds.find(background=>background?.type==='image' && typeof background.id==='string');
    if (still) {
      try { result.assets[backgroundPath]=image(data['background-'+still.id]).toString('base64'); }
      catch(error) { result.warnings.push('Background: '+error.message); }
    }
    if (backgrounds.length>1 || !still) result.warnings.push('The first supported still image is used as the export background.');
  }
  if (data.customSounds || data.customSoundAtlas) {
    try { result.assets[soundPath]=soundBank(data).toString('base64'); }
    catch(error) { result.warnings.push('Sound effects: '+error.message); }
  }
  if (data.skinAnim || data.ghostAnim || data.animatedBackground) result.warnings.push('Animated skins and backgrounds require TETR.IO PLUS.');
  if (data.music?.length || data.musicGraph) result.warnings.push('Custom music and music graphs require TETR.IO PLUS.');
  if (!Object.keys(result.assets).length) throw Error(result.warnings.join(' ') || 'This TPSE has no supported appearance or sound assets');
  return result;
}

export async function readAppearance(file) {
  if (!file) return null;
  if ((await stat(file)).size > maxAppearanceBytes) throw Error('Imported appearance is too large');
  const data=JSON.parse(await readFile(file,'utf8'));
  if (!object(data)) throw Error('Invalid imported appearance');
  const assets={};
  for (const [address,value] of Object.entries(data.assets||{})) {
    if (!allowedPaths.has(address) || typeof value!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('Invalid appearance asset');
    assets[address]=value;
  }
  return {video:videoPreferences(data.video),assets};
}

export function appearanceResponse(appearance,url) {
  if (!appearance || url.origin!=='https://tetr.io') return null;
  const address=/^\/res\/bg\/\d+\.jpg$/.test(url.pathname)?backgroundPath:url.pathname;
  const value=appearance.assets?.[address];
  if (!value) return null;
  return {status:200,headers:{'content-type':address===soundPath?'application/octet-stream':'image/png','access-control-allow-origin':'*'},body:Buffer.from(value,'base64')};
}
