// Compatibility experiment: keep the original Pixi renderer and shaders, but
// execute WebGL in a local ANGLE context without Chromium's compositor.
(() => {
  if (typeof require !== 'function') return;
  if(process.env.REPLAY_FORMAT_CACHE==='1'){
    const original=Number.prototype.toLocaleString,cache=new Map();
    const stats=window.__numberFormatMetrics={hits:0,misses:0};
    Number.prototype.toLocaleString=function(locales){'use strict';
      if(arguments.length!==1||locales!=='en-US'||typeof this!=='number'||!Number.isSafeInteger(this))return Reflect.apply(original,this,arguments);
      if(cache.has(this)){stats.hits++;return cache.get(this)}
      const value=original.call(this,locales);if(cache.size>=4096)cache.clear();cache.set(this,value);stats.misses++;return value;
    };
  }
  const { createCanvas, WebGL2RenderingContext } = require(window.__nativeWebGLModule);
  if(process.env.REPLAY_NATIVE_GL_TRUSTED==='1'){
    const prototype=Object.getPrototypeOf(WebGL2RenderingContext.prototype);
    const originalCreate=prototype._createNativeContext;
    prototype._createNativeContext=function(...args){
      const native=this._n;
      this._n=Object.create(native,{createContext:{value:options=>native.createContext({...options,webgl:false,robustness:false})}});
      return originalCreate.apply(this,args);
    };
  }
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const nativeCanvases = new WeakMap();
  const imageCache = new WeakMap();
  // Optional real-time counters distinguish DOM uploads from ANGLE calls.
  // The replay's performance.now() advances virtually, so use Node's clock.
  const profile=process.env.REPLAY_GL_PROFILE==='1';
  const metrics=window.__nativeGLMetrics={};
  function timed(name,operation){
    const start=process.hrtime.bigint();
    try{return operation()}finally{const value=metrics[name]??={calls:0,ms:0};value.calls++;value.ms+=Number(process.hrtime.bigint()-start)/1e6;}
  }
  const scratch = document.createElement('canvas');
  const scratch2d = originalGetContext.call(scratch, '2d', { willReadFrequently: true });
  function readNativeImage(canvas){
    const image=canvas.getImageData();
    // readPixels returns premultiplied drawing-buffer colors, whereas browser
    // ImageData/putImageData use straight alpha. Avoid applying opacity twice.
    if(canvas._ctx.getContextAttributes().premultipliedAlpha){
      const bytes=image.data;
      for(let i=0;i<bytes.length;i+=4){const alpha=bytes[i+3];if(alpha&&alpha!==255){bytes[i]=Math.min(255,Math.round(bytes[i]*255/alpha));bytes[i+1]=Math.min(255,Math.round(bytes[i+1]*255/alpha));bytes[i+2]=Math.min(255,Math.round(bytes[i+2]*255/alpha));}}
    }
    return image;
  }
  function sourcePixels(source) {
    const native = nativeCanvases.get(source);
    if (native) return readNativeImage(native);
    if (source.data || ArrayBuffer.isView(source)) return source;
    if(source instanceof HTMLCanvasElement){
      const context=originalGetContext.call(source,'2d');
      if(context)return context.getImageData(0,0,source.width,source.height);
    }
    const immutable = source instanceof HTMLImageElement || source instanceof ImageBitmap;
    if (immutable && imageCache.has(source)) return imageCache.get(source);
    scratch.width = source.naturalWidth || source.width;
    scratch.height = source.naturalHeight || source.height;
    scratch2d.clearRect(0, 0, scratch.width, scratch.height);
    scratch2d.drawImage(source, 0, 0);
    const pixels = scratch2d.getImageData(0, 0, scratch.width, scratch.height);
    if (immutable) imageCache.set(source, pixels);
    return pixels;
  }
  for (const property of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
    Object.defineProperty(HTMLCanvasElement.prototype, property, {
      ...descriptor,
      set(value) {
        descriptor.set.call(this, value);
        const native = nativeCanvases.get(this);
        if (native) native[property] = this[property];
      },
    });
  }
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    if (!/^(experimental-)?webgl2?$/.test(type)) return originalGetContext.call(this, type, options);
    let canvas = nativeCanvases.get(this);
    if (!canvas) {
      canvas = createCanvas(this.width, this.height);
      canvas.addEventListener('webglcontextcreationerror',event=>{canvas.__creationError=event.statusMessage});
      nativeCanvases.set(this, canvas);
    }
    window.__nativeGLFlush?.();
    const gl=canvas.getContext(type,options);
    if (!gl) throw Error('Native WebGL context creation failed: ' + type+(canvas.__creationError?' · '+canvas.__creationError:''));
    if (!gl.__bridged) {
      gl.__bridged = true;
      window.__installGLBatch?.(gl);
      const sourceToRGBA = gl._sourceToRGBA.bind(gl);
      gl._sourceToRGBA = source => profile?timed('sourcePixels',()=>sourceToRGBA(sourcePixels(source))):sourceToRGBA(sourcePixels(source));
      if(profile)for(const name of ['texImage2D','texSubImage2D','bufferData','bufferSubData','drawElements','drawArrays','uniformMatrix3fv','getParameter','bindFramebuffer']){
        const original=gl[name].bind(gl);gl[name]=(...args)=>timed(name,()=>original(...args));
      }
      // Pixi uses the real DOM canvas for dimensions, events and context loss.
      gl._canvas = this;
      window.__nativeWebGLContexts ??= [];
      window.__nativeWebGLContexts.push(gl);
    }
    return gl;
  };
  window.__nativeWebGLRead = canvas => {const native=nativeCanvases.get(canvas);return native?readNativeImage(native):undefined};
  window.__nativeWebGLContext = canvas => nativeCanvases.get(canvas)?._ctx;
  const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  const copy = document.createElement('canvas');
  const copy2d = originalGetContext.call(copy, '2d');
  CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
    const native = nativeCanvases.get(source);
    if (native) {
      const image = readNativeImage(native);
      copy.width = image.width; copy.height = image.height;
      copy2d.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
      source = copy;
    }
    return originalDrawImage.call(this, source, ...args);
  };
})();
