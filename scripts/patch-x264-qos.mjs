import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function patchX264QoS(source){
  const file=path.join(source,'common/threadpool.c');
  let text=await readFile(file,'utf8');
  if(text.includes('REPLAY_CODEC_WORKER_QOS'))return;
  const include='#include "common.h"';
  const start='REALIGN_STACK static void *threadpool_thread( x264_threadpool_t *pool )\n{';
  if(text.split(include).length!==2||text.split(start).length!==2)throw Error('Pinned x264 thread initialization changed');
  text=text.replace(include,include+'\n#if SYS_MACOSX\n#include <pthread/qos.h>\n#endif');
  text=text.replace(start,start+`
#if SYS_MACOSX
    /* Scheduling only: all codec computations and quality settings unchanged. */
    const char *replay_qos = getenv("REPLAY_CODEC_WORKER_QOS");
    if( replay_qos )
    {
        qos_class_t qos = !strcmp(replay_qos,"interactive") ? QOS_CLASS_USER_INTERACTIVE : QOS_CLASS_USER_INITIATED;
        int status = pthread_set_qos_class_self_np(qos,0);
        if( status ) fprintf(stderr,"Replay codec QoS request failed: %d\\n",status);
        pthread_setname_np("replay-x264");
    }
#endif`);
  await writeFile(file,text);
}
