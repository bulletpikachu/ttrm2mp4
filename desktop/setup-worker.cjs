const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),os=require('node:os');
const root=path.resolve(__dirname,'..');
process.env.REPLAY_RESOURCE_ROOT=root;
const [replayPath,directory]=process.argv.slice(2);
const abort=new AbortController();let child;
const send=event=>{if(process.connected)process.send({type:'setup-event',event});};
const stop=()=>{abort.abort();child?.kill('SIGTERM');};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
(async()=>{
  const {prepareClient}=await import(pathToFileURL(path.join(root,'src/offline/prepare-client.mjs')).href);
  const result=await prepareClient({replayPath,directory,signal:abort.signal,onProgress:event=>send({type:'setup-progress',...event})});
  if(abort.signal.aborted)throw Error('Setup cancelled');
  send({type:'setup-progress',stage:'Checking an offline preview',progress:.97});
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'replay-setup-check-'));
  try{
    const {portableEnvironment}=await import(pathToFileURL(path.join(root,'src/offline/runtime.mjs')).href);
    await new Promise((resolve,reject)=>{
      const args=[path.join(root,'src/render.mjs'),replayPath,path.join(scratch,'check.mp4'),'--client',result.directory,'--engine','electron','--width','1280','--height','720','--duration','0.1','--export-rounds','--deterministic'];
      child=spawn(process.execPath,args,{env:portableEnvironment(),windowsHide:true,stdio:['ignore','ignore','pipe']});
      let errors='';child.stderr.on('data',data=>{errors=(errors+data).slice(-3000)});
      child.once('error',reject);child.once('close',code=>{child=null;code===0&&!abort.signal.aborted?resolve():reject(Error(abort.signal.aborted?'Setup cancelled':'Offline preview failed: '+errors));});
    });
  }finally{await fs.rm(scratch,{recursive:true,force:true});}
  send({type:'setup-ready',directory:result.directory,version:result.manifest.hardVersion});
})().catch(error=>{send({type:abort.signal.aborted?'setup-cancelled':'setup-error',message:error.message});process.exitCode=1;}).finally(()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(process.connected)process.disconnect();});
