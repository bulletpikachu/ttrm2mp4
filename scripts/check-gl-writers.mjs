import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const commands=JSON.parse(await readFile(new URL('../src/experimental/gl-commands.json',import.meta.url),'utf8'));
const batch=await readFile(new URL('../src/experimental/gl-batch.js',import.meta.url),'utf8');
const generated=await readFile(new URL('../src/experimental/gl-writers.generated.js',import.meta.url),'utf8');
function recorder(specialized){
  const chunks=[],bridge={load(){},barrier(){},execute(bytes){chunks.push(Buffer.from(bytes))}};
  const gl={ACTIVE_TEXTURE:0x84e0,TEXTURE0:0x84c0,TEXTURE_2D:0xde1,TEXTURE_BINDING_2D:0x8069,DRAW_FRAMEBUFFER_BINDING:0x8ca6,READ_FRAMEBUFFER_BINDING:0x8caa,FRAMEBUFFER:0x8d40,DRAW_FRAMEBUFFER:0x8ca9,READ_FRAMEBUFFER:0x8ca8,CURRENT_PROGRAM:0x8b8d,VERTEX_ARRAY_BINDING:0x85b5,VIEWPORT:0xba2,COLOR_WRITEMASK:0xc23,BLEND:0xbe2,DEPTH_TEST:0xb71,STENCIL_TEST:0xb90,SCISSOR_TEST:0xc11,CULL_FACE:0xb44};
  const original=Object.fromEntries(commands.map(c=>[c.name,()=>{}]));
  original.getIntegerv=(key,out)=>out.set(key===gl.ACTIVE_TEXTURE?[gl.TEXTURE0]:key===gl.VIEWPORT?[0,0,1920,1080]:[0]);
  original.getBooleanv=(key,out)=>out.fill(1);original.isEnabled=()=>false;
  for(const name of ['deleteTextures','deleteFramebuffers','deleteVertexArrays'])original[name]=()=>{};
  gl._n=original;gl._drawingBuffer={n:original};
  const context=vm.createContext({window:{__glCommandSchema:commands},process:{env:{REPLAY_GL_ASYNC:'1',REPLAY_GL_SPECIALIZE:specialized?'1':'0'}},require:()=>bridge});
  if(specialized)vm.runInContext(generated,context);vm.runInContext(batch,context);context.window.__installGLBatch(gl);
  return{gl,chunks,flush:()=>context.window.__nativeGLFlush(),metrics:context.window.__glBatchMetrics};
}
const reference=recorder(false),fast=recorder(true),recorders=[reference,fast];
let callCount=0;
// Cover every schema, scalar conversions, subarray offsets, payload alignment,
// repeated buffer growth, reused batches, and independently owned payloads.
for(let pass=0;pass<600;pass++){
  for(const command of commands){
    const {name,types}=command,pointer=types.indexOf('d');
    const args=[...types].map(type=>type==='b'?pass%2===0:type==='f'?(pass-300)/13:type==='i'?pass%4:2);
    if(pointer>=0){
      if(name==='bufferData')args[1]=73;
      if(name==='bufferSubData')args[2]=73;
      const length=Number(new Function('v','return '+command.bytes)(args));
      const backing=new Uint8Array(length+16);for(let i=0;i<backing.length;i++)backing[i]=(pass+i*17)%256;args[pointer]=backing.subarray(8,8+length);
    }
    if(name==='stencilMask')args[0]=-1;
    for(const r of recorders)r.gl._n[name](...args);
    if(pointer>=0)args[pointer].fill(0xff);
    callCount++;
  }
  if(pass%400===399)for(const r of recorders)r.flush();
}
for(const r of recorders){r.gl._n.bufferData(0x8892,4096,null,0x88e8);r.gl._n.bufferData(0x8892,0,new Uint8Array(0),0x88e8);}
callCount+=2;
const large=new Uint8Array(8*1024*1024);large.fill(37);
for(const r of recorders)r.gl._n.bufferData(0x8892,large.length,large,0x88e8);large.fill(99);callCount++;
for(const r of recorders)r.flush();
assert.deepEqual(fast.chunks,reference.chunks,'Specialized commands must preserve every binary byte');
assert.ok(fast.chunks.some(chunk=>chunk.length>8*1024*1024),'Writer test must grow its command storage');
assert.equal(fast.metrics.calls,callCount);assert.equal(fast.metrics.specialized,true);
const invoke=(name,...args)=>{for(const r of recorders)r.gl._n[name](...args)};
const g=fast.gl;
invoke('activeTexture',g.TEXTURE0+4);invoke('bindTexture',g.TEXTURE_2D,123);invoke('deleteTextures',1,new Uint32Array([123]));
invoke('bindFramebuffer',g.FRAMEBUFFER,7);invoke('deleteFramebuffers',1,new Uint32Array([7]));
invoke('bindVertexArray',9);invoke('deleteVertexArrays',1,new Uint32Array([9]));
invoke('viewport',3,4,640,360);invoke('colorMask',true,false,true,false);invoke('enable',g.BLEND);
for(const r of recorders){
  const query=(key,length=1)=>{const out=new Int32Array(length);r.gl._n.getIntegerv(key,out);return[...out]};
  assert.deepEqual(query(g.ACTIVE_TEXTURE),[g.TEXTURE0+4]);
  for(const key of [g.TEXTURE_BINDING_2D,g.DRAW_FRAMEBUFFER_BINDING,g.READ_FRAMEBUFFER_BINDING,g.VERTEX_ARRAY_BINDING])assert.deepEqual(query(key),[0]);
  assert.deepEqual(query(g.VIEWPORT,4),[3,4,640,360]);const mask=new Uint8Array(4);r.gl._n.getBooleanv(g.COLOR_WRITEMASK,mask);assert.deepEqual([...mask],[1,0,1,0]);assert.equal(r.gl._n.isEnabled(g.BLEND),true);r.flush();
}
assert.deepEqual(fast.chunks,reference.chunks);
// Decode the copied payload after mutating its original source.
const a=recorder(true),source=new Float32Array([1.25,2.5]);a.gl._n.uniform1fv(3,2,source);source.fill(-1);a.flush();
const data=a.chunks[0],offset=data.readDoubleLE(32);assert.equal(data.readFloatLE(offset),1.25);assert.equal(data.readFloatLE(offset+4),2.5);
console.log(`PASS: ${callCount} commands across ${commands.length} schemas are byte-identical, with owned payloads and matching shadow state.`);
