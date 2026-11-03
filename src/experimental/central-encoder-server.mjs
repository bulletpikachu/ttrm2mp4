import net from 'node:net';
import path from 'node:path';
import {chmod} from 'node:fs/promises';
import {createRequire} from 'node:module';
const native=createRequire(import.meta.url)('./native/central-encoder.node');
const [socketPath,root,threadCount]=process.argv.slice(2),threads=Number(threadCount);
const service=native.listen();
const sockets=new Set();let failed=false;
function fail(error){if(failed)return;failed=true;console.error(error.stack||error);for(const socket of sockets)socket.destroy();process.exit(1);}
const server=net.createServer(socket=>{
  sockets.add(socket);let input='',session=null,closing=false,last=-1;
  const send=message=>{if(!socket.destroyed)socket.write(JSON.stringify(message)+'\n')};
  socket.on('data',chunk=>{
    try{
      input+=chunk;if(input.length>1048576)throw Error('Central encoder message exceeds 1 MiB');
      for(let newline;(newline=input.indexOf('\n'))>=0;){const message=JSON.parse(input.slice(0,newline));input=input.slice(newline+1);
        switch(message.type){
          case'open':{
            if(session!==null)throw Error('Central encoder round already open');
            const output=path.resolve(message.output);if(!output.startsWith(path.resolve(root)+path.sep))throw Error('Central output is outside the export directory');
            closing=false;last=-1;
            session=native.open(message.width,message.height,message.fps,threads,output,(kind,index,value,status,encodeMs)=>{
              if(status)return fail(Error('Central encoder error '+status));
              if(kind===1)send({type:'frame',index});
              else if(kind===2){session=null;send({type:'closed',frames:value,encodeMs})}
            });send({type:'opened',session});break;
          }
          case'frame':if(session===null||closing||!Number.isSafeInteger(message.index)||message.index<=last)throw Error('Central frames are out of order');else{last=message.index;native.submit(session,message.surface,message.index,!!message.key);break;}
          case'close':if(session===null||closing||!Number.isSafeInteger(message.frames)||message.frames<0)throw Error('Central round cannot close');else{closing=true;native.finish(session,message.frames);break;}
          default:throw Error('Unknown central encoder message');
        }
      }
    }catch(error){fail(error)}
  });
  socket.on('error',fail);socket.on('close',()=>{sockets.delete(socket);if(session!==null&&!failed)fail(Error('Renderer disconnected before central encoding finished'))});
});
server.on('error',fail);
server.listen(socketPath,async()=>{await chmod(socketPath,0o600);process.send?.({type:'ready',service});});
process.once('SIGTERM',()=>process.exit(0));
