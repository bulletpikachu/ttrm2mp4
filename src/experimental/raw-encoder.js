// Experimental local-only Electron backend. The trusted cached game is loaded
// with browser networking disabled before this module is installed.
window.__createRawEncoder = ({width,height,fps}) => {
  const {spawn}=require('node:child_process');
  const {once}=require('node:events');
  const settings=window.__rawEncoderOptions;
  const child=spawn(settings.ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y',
    '-f','rawvideo','-pixel_format',settings.format,'-video_size',`${width}x${height}`,'-framerate',String(fps),'-i','pipe:0',
    '-an','-c:v','h264_videotoolbox','-profile:v','high','-b:v','12M','-pix_fmt','yuv420p','-realtime','0','-bf','0','-f','h264',settings.output],
    {stdio:['pipe','ignore','pipe']});
  let error,stderr='';
  child.on('error',e=>{error=e});child.stdin.on('error',e=>{error=e});
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-6000)});
  const completed=once(child,'exit');
  const pack=settings.format==='nv12'?window.__createNV12Packer(width,height):null;
  return {
    capture:source=>pack?pack(source):source.getContext('2d').getImageData(0,0,width,height),
    async write(image){
      if(error)throw error;
      const bytes=Buffer.from(image.data.buffer,image.data.byteOffset,image.data.byteLength);
      if(!child.stdin.write(bytes))await once(child.stdin,'drain');
      if(error)throw error;
    },
    async finish(){child.stdin.end();const[code]=await completed;if(error)throw error;if(code!==0)throw Error(`FFmpeg failed (${code}): ${stderr}`)},
  };
};
