import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCanvas} from '../.native-deps/node-webgl-windows/dist/index.js';

assert.equal(process.platform,'win32');
if(process.argv[2]==='--case'){
  const pixels=[];let gl;
  for(let context=0;context<2;context++){
    gl=createCanvas(32,32).getContext('webgl2');assert(gl);
    function shader(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);assert(gl.getShaderParameter(shader,gl.COMPILE_STATUS),gl.getShaderInfoLog(shader));return shader;}
    for(let i=0;i<4;i++){
      const program=gl.createProgram();
      gl.attachShader(program,shader(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'));
      gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es\nprecision highp float;uniform float shade;out vec4 color;void main(){color=vec4(${i}.0/4.0,shade,0.75,1);}`));
      gl.linkProgram(program);assert(gl.getProgramParameter(program,gl.LINK_STATUS),gl.getProgramInfoLog(program));gl.useProgram(program);gl.uniform1f(gl.getUniformLocation(program,'shade'),.5);gl.drawArrays(gl.TRIANGLES,0,3);gl.finish();
      const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      for(const [channel,expected]of [i/4*255,127.5,191.25,255].entries())assert(Math.abs(pixel[channel]-expected)<=1,'Cached program rendered the expected pixel');
      pixels.push([...pixel]);assert.equal(gl.getError(),gl.NO_ERROR);
    }
  }
  console.log(JSON.stringify({pixels,cache:gl._n._replayShaderCacheStats()}));
}else{
  const directory=await mkdtemp(path.join(tmpdir(),'replay-shader-cache-check-')),script=fileURLToPath(import.meta.url);
  function run(cache){const child=spawnSync(process.execPath,[script,'--case'],{env:{...process.env,REPLAY_WINDOWS_SHADER_CACHE:cache},encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(child.status,0,child.error?.message||child.stderr);return JSON.parse(child.stdout.trim());}
  try{
    const cache=path.join(directory,'cache space-測試');
    const cold=run(cache);assert(cold.cache.enabled);assert(cold.cache.writes>0,'Cold shaders populate the cache');assert(cold.cache.misses>0);assert.equal(cold.cache.ioErrors,0);
    const warm=run(cache);assert(warm.cache.hits>0,'A fresh process loads cached shaders');assert(warm.cache.bytesRead>0);assert.deepEqual(warm.pixels,cold.pixels);assert.equal(warm.cache.ioErrors,0);
    const files=(await readdir(cold.cache.directory)).filter(name=>name.endsWith('.bin'));assert(files.length>0);
    for(const name of files){const file=path.join(cold.cache.directory,name),bytes=await readFile(file);bytes[bytes.length-1]^=1;await writeFile(file,bytes);}
    const repaired=run(cache);assert(repaired.cache.corrupt>0,'Corrupt cache data is rejected before the driver receives it');assert(repaired.cache.writes>0);assert.deepEqual(repaired.pixels,cold.pixels);
    const race=path.join(directory,'race');
    async function concurrent(){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,'--case'],{env:{...process.env,REPLAY_WINDOWS_SHADER_CACHE:race},windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',errors='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>errors+=data);child.once('error',reject);child.once('close',code=>{try{assert.equal(code,0,errors);resolve(JSON.parse(out.trim()));}catch(error){reject(error)}});});}
    const racers=await Promise.all([concurrent(),concurrent()]);for(const result of racers)assert.deepEqual(result.pixels,cold.pixels);
    const afterRace=run(race);assert(afterRace.cache.hits>0);assert.equal(afterRace.cache.corrupt,0);assert.deepEqual(afterRace.pixels,cold.pixels);
    console.log('PASS: cross-process shader hits preserve pixels; corrupt entries recompile safely; concurrent writers leave valid entries.');
    console.log(JSON.stringify({cold:cold.cache,warm:warm.cache,repaired:repaired.cache}));
  }finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));assert(path.basename(directory).startsWith('replay-shader-cache-check-'));await rm(directory,{recursive:true,force:true});}
}
