// Record common numeric/array GLES mutations into one owned command buffer.
// Queries and unsupported calls are synchronous barriers, preserving GL order.
(() => {
  if(typeof require!=='function')return;
  const commands=window.__glCommandSchema;
  const bridge=require(window.__glBatchModule);
  const asynchronous=process.env.REPLAY_GL_ASYNC==='1';let started=false;
  const shadow=asynchronous||process.env.REPLAY_GL_SHADOW==='1';
  const deduplicate=process.env.REPLAY_GL_DEDUPE==='1';
  const specialize=process.env.REPLAY_GL_SPECIALIZE==='1';
  if(specialize&&deduplicate)throw Error('GL specialization and deduplication cannot be combined');
  const verifyShadow=process.env.REPLAY_GL_SHADOW_VERIFY==='1';
  let loaded=false;
  let storage=new ArrayBuffer(1048576),words=new Float64Array(storage),bytes=new Uint8Array(storage),offset=0;
  const metrics=window.__glBatchMetrics={calls:0,batches:0,bytes:0,barriers:{}};
  function flush(){if(!offset)return;bridge.execute(new Uint8Array(storage,0,offset));metrics.batches++;metrics.bytes+=offset;offset=0;}
  function reserve(size){if(size>67108864)throw Error('Native GL command batch exceeds 64 MiB');if(size<=storage.byteLength)return;let capacity=storage.byteLength;while(capacity<size)capacity*=2;const next=new ArrayBuffer(capacity);new Uint8Array(next).set(bytes.subarray(0,offset));storage=next;words=new Float64Array(storage);bytes=new Uint8Array(storage);writer.words=words;writer.bytes=bytes;}
  const writer={words,bytes,allocate(size){const start=offset;reserve(start+size);offset=start+size;return start}};
  window.__nativeGLFlush=flush;
  window.__nativeGLStart=()=>{if(asynchronous&&!started){flush();bridge.startThread();started=true;metrics.asynchronous=true;}};
  window.__nativeGLThreadStats=()=>bridge.threadStats();
  window.__installGLBatch=gl=>{
    if(!loaded){bridge.load(window.__windowsNativeGLBatch?gl._n._replayEGL():window.__glBatchAngle);loaded=true;}
    const original=gl._n,proxy=Object.create(original);
    const define=(name,value)=>Object.defineProperty(proxy,name,{value,configurable:true,writable:true});
    // NAPI exports are non-writable. Define own properties explicitly, including
    // inherited exports in the trusted-context wrapper.
    const fallback=(name,args)=>{flush();bridge.barrier();if(process.env.REPLAY_GL_SHADOW_ORPHAN==='1')bridge.invalidateBufferShadows();metrics.barriers[name]=(metrics.barriers[name]||0)+1;const result=original[name](...args);
      if(state&&name==='deleteTextures')for(let i=0;i<args[0];i++)for(const [unit,id]of textures)if(id===args[1][i])textures.set(unit,0);
      if(state&&name==='deleteFramebuffers')for(let i=0;i<args[0];i++)for(const key of [gl.DRAW_FRAMEBUFFER_BINDING,gl.READ_FRAMEBUFFER_BINDING])if(state.get(key)[0]===args[1][i])state.set(key,[0]);
      if(state&&name==='deleteVertexArrays')for(let i=0;i<args[0];i++)if(state.get(gl.VERTEX_ARRAY_BINDING)[0]===args[1][i])state.set(gl.VERTEX_ARRAY_BINDING,[0]);
      return result;};
    for(let owner=original;owner&&owner!==Object.prototype;owner=Object.getPrototypeOf(owner))for(const name of Object.getOwnPropertyNames(owner))if(typeof original[name]==='function'&&!Object.hasOwn(proxy,name))define(name,(...args)=>fallback(name,args));
    let state,textures,enabled;
    if(shadow){
      const query=(method,key,out,expected)=>{
        if(verifyShadow){const actual=new out.constructor(expected.length);fallback(method,[key,actual]);for(let i=0;i<expected.length;i++)if(actual[i]!==expected[i])throw Error(`GL state cache mismatch ${key}: ${Array.from(actual)} vs ${expected}`);metrics.shadowChecks=(metrics.shadowChecks||0)+1;}
        out.set(expected);
      };
      state=new Map();for(const [key,length]of [[gl.ACTIVE_TEXTURE,1],[gl.DRAW_FRAMEBUFFER_BINDING,1],[gl.READ_FRAMEBUFFER_BINDING,1],[gl.CURRENT_PROGRAM,1],[gl.VERTEX_ARRAY_BINDING,1],[gl.VIEWPORT,4]]){const value=new Int32Array(length);original.getIntegerv(key,value);state.set(key,Array.from(value));}
      const mask=new Uint8Array(4);original.getBooleanv(gl.COLOR_WRITEMASK,mask);state.set(gl.COLOR_WRITEMASK,Array.from(mask));
      textures=new Map();for(let i=0;i<32;i++)textures.set(gl.TEXTURE0+i,0);const tex=new Int32Array(1);original.getIntegerv(gl.TEXTURE_BINDING_2D,tex);textures.set(state.get(gl.ACTIVE_TEXTURE)[0],tex[0]);
      enabled=new Map([gl.BLEND,gl.DEPTH_TEST,gl.STENCIL_TEST,gl.SCISSOR_TEST,gl.CULL_FACE].map(cap=>[cap,original.isEnabled(cap)]));
      define('getIntegerv',(key,out)=>{if(state.has(key)&&key!==gl.COLOR_WRITEMASK)return query('getIntegerv',key,out,state.get(key));if(key===gl.TEXTURE_BINDING_2D)return query('getIntegerv',key,out,[textures.get(state.get(gl.ACTIVE_TEXTURE)[0])||0]);return fallback('getIntegerv',[key,out])});
      define('getBooleanv',(key,out)=>{if(key===gl.COLOR_WRITEMASK)return query('getBooleanv',key,out,state.get(key));return fallback('getBooleanv',[key,out])});
      define('isEnabled',cap=>{if(!enabled.has(cap))return fallback('isEnabled',[cap]);const value=enabled.get(cap);if(verifyShadow){if(fallback('isEnabled',[cap])!==value)throw Error('GL capability cache mismatch '+cap);metrics.shadowChecks=(metrics.shadowChecks||0)+1;}return value;});
    }
    const specialized=specialize?window.__createGLWriters(writer,gl,state,textures,enabled,metrics):null;
    if(specialized)metrics.specialized=true;
    for(const [opcode,command]of commands.entries())if(typeof original[command.name]==='function'){
      if(specialized){define(command.name,specialized[command.name]);continue;}
      const {types}=command,pointer=types.indexOf('d'),header=(types.length+2)*8;
      define(command.name,(...args)=>{
        if(state&&deduplicate){
          let same=false;
          const equal=(key,values)=>{const previous=state.get(key);return previous&&previous.length===values.length&&values.every((value,i)=>Number(value)===previous[i]);};
          switch(command.name){
            case'activeTexture':same=equal(gl.ACTIVE_TEXTURE,args);break;
            case'bindFramebuffer':same=(args[0]===gl.FRAMEBUFFER?equal(gl.DRAW_FRAMEBUFFER_BINDING,[args[1]])&&equal(gl.READ_FRAMEBUFFER_BINDING,[args[1]]):args[0]===gl.DRAW_FRAMEBUFFER?equal(gl.DRAW_FRAMEBUFFER_BINDING,[args[1]]):args[0]===gl.READ_FRAMEBUFFER&&equal(gl.READ_FRAMEBUFFER_BINDING,[args[1]]));break;
            case'useProgram':same=equal(gl.CURRENT_PROGRAM,args);break;
            case'bindVertexArray':same=equal(gl.VERTEX_ARRAY_BINDING,args);break;
            case'viewport':same=equal(gl.VIEWPORT,args);break;
            case'colorMask':same=equal(gl.COLOR_WRITEMASK,args);break;
            case'bindTexture':same=args[0]===gl.TEXTURE_2D&&textures.get(state.get(gl.ACTIVE_TEXTURE)[0])===args[1];break;
            case'enable':same=enabled.get(args[0])===true;break;
            case'disable':same=enabled.get(args[0])===false;break;
          }
          if(same){metrics.deduplicated=(metrics.deduplicated||0)+1;return;}
        }
        if(state)switch(command.name){
          case'activeTexture':state.set(gl.ACTIVE_TEXTURE,[args[0]]);break;
          case'bindFramebuffer':if(args[0]===gl.FRAMEBUFFER||args[0]===gl.DRAW_FRAMEBUFFER)state.set(gl.DRAW_FRAMEBUFFER_BINDING,[args[1]]);if(args[0]===gl.FRAMEBUFFER||args[0]===gl.READ_FRAMEBUFFER)state.set(gl.READ_FRAMEBUFFER_BINDING,[args[1]]);break;
          case'useProgram':state.set(gl.CURRENT_PROGRAM,[args[0]]);break;
          case'bindVertexArray':state.set(gl.VERTEX_ARRAY_BINDING,[args[0]]);break;
          case'viewport':state.set(gl.VIEWPORT,args.slice());break;
          case'colorMask':state.set(gl.COLOR_WRITEMASK,args.map(Number));break;
          case'bindTexture':if(args[0]===gl.TEXTURE_2D)textures.set(state.get(gl.ACTIVE_TEXTURE)[0],args[1]);break;
          case'enable':if(enabled.has(args[0]))enabled.set(args[0],true);break;
          case'disable':if(enabled.has(args[0]))enabled.set(args[0],false);break;
        }
        let payload;
        if(pointer>=0&&args[pointer]!=null){const data=args[pointer];payload=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);}
        const end=offset+header+(payload?(payload.length+7)&~7:0);reserve(end);
        const at=offset/8;words[at]=opcode;words[at+1]=end;
        for(let i=0;i<types.length;i++)words[at+2+i]=i===pointer?(payload?offset+header:0):types[i]==='u'?Number(args[i])>>>0:Number(args[i]);
        if(payload)bytes.set(payload,offset+header);offset=end;metrics.calls++;
      });
    }
    if(shadow&&process.env.REPLAY_GL_POOL==='1')for(const name of ['genBuffers','genVertexArrays'])if(typeof original[name]==='function'){
      let pool=new Uint32Array(0),cursor=0;
      const pools=metrics.resourcePools??={};
      const stats=pools[name]??={allocations:0,names:0,hits:0};
      define(name,(count,out)=>{
        if(!Number.isInteger(count)||count<0||count>4096||!ArrayBuffer.isView(out)||out.BYTES_PER_ELEMENT!==4||out.length<count)return fallback(name,[count,out]);
        if(cursor+count>pool.length){pool=new Uint32Array(Math.max(1024,count));fallback(name,[pool.length,pool]);if(pool.some(id=>id===0))throw Error('Cannot reserve native GL object names');cursor=0;stats.allocations++;stats.names+=pool.length;}
        out.set(pool.subarray(cursor,cursor+count));cursor+=count;stats.hits+=count;
      });
    }
    if(asynchronous&&process.env.REPLAY_GL_DEFER_FLUSH==='1'){
      const submit=proxy.flush;
      define('flush',(...args)=>{if(started){metrics.deferredFlushes=(metrics.deferredFlushes||0)+1;return}return submit(...args)});
    }
    gl._n=proxy;
    // DrawingBuffer retains its own NAPI reference. Its multisample resolves
    // must join the same ordered stream as the draws they resolve.
    if(gl._drawingBuffer)gl._drawingBuffer.n=proxy;
  };
})();
