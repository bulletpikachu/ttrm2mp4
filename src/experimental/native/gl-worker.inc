// One ANGLE context is owned by either the main thread or this command worker,
// never both. Synchronous queries drain commands and return context ownership.
struct DeferredFence{std::mutex mutex;std::condition_variable changed;bool ready=false,failed=false;Fence metal{};std::atomic<int>refs;explicit DeferredFence(int n):refs(n){}};
struct GPUJob{std::vector<uint8_t>bytes;DeferredFence*fence=nullptr;};
struct GPUState{
  std::mutex mutex;std::condition_variable changed;std::deque<GPUJob>queue;std::thread worker;
  bool paused=true,ack=true,mainAttached=true,stopping=false;std::string error;
  EGLDisplay display=EGL_NO_DISPLAY;EGLContext context=EGL_NO_CONTEXT;EGLSurface draw=EGL_NO_SURFACE,read=EGL_NO_SURFACE;
  size_t queuedBytes=0;std::atomic<int64_t>jobs{0},executeNs{0},pauseNs{0},pauses{0},cpuUs{0},fenceNs{0};std::atomic<int>workerQos{0};
  id activity=nil;
};
static GPUState*gpuThread=nullptr;
static uint32_t ReleaseDeferred(void*object,void*);
static double lastThreadStats[8]={};
using GPUClock=std::chrono::steady_clock;
static int64_t GPUElapsed(GPUClock::time_point t){return std::chrono::duration_cast<std::chrono::nanoseconds>(GPUClock::now()-t).count();}
static int64_t GPUCPUTime(mach_port_t thread){thread_basic_info_data_t info{};mach_msg_type_number_t count=THREAD_BASIC_INFO_COUNT;if(thread_info(thread,THREAD_BASIC_INFO,(thread_info_t)&info,&count)!=KERN_SUCCESS)return 0;return(int64_t)(info.user_time.seconds+info.system_time.seconds)*1000000+info.user_time.microseconds+info.system_time.microseconds;}
static bool GPUCurrent(GPUState*s,bool attach){return Proc<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(s->display,attach?s->draw:EGL_NO_SURFACE,attach?s->read:EGL_NO_SURFACE,attach?s->context:EGL_NO_CONTEXT);}
static bool CaptureGPU(GPUState*s){
  s->display=Proc<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();s->context=Proc<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")();
  s->draw=Proc<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_DRAW);s->read=Proc<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_READ);
  return s->display!=EGL_NO_DISPLAY&&s->context!=EGL_NO_CONTEXT&&GPUCurrent(s,false);
}
static Fence WorkerFence(){
  const auto display=Proc<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();
  const EGLint attrs[]={EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_LO_ANGLE,1,EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_HI_ANGLE,0,EGL_NONE};
  auto sync=Proc<PFNEGLCREATESYNCKHRPROC>("eglCreateSyncKHR")(display,EGL_SYNC_METAL_SHARED_EVENT_ANGLE,attrs);if(sync==EGL_NO_SYNC_KHR)return{};
  void*event=Proc<PFNEGLCOPYMETALSHAREDEVENTANGLEPROC>("eglCopyMetalSharedEventANGLE")(display,sync);Proc<PFNEGLDESTROYSYNCKHRPROC>("eglDestroySyncKHR")(display,sync);
  Proc<PFNGLFLUSHPROC>("glFlush")();return{event,(void*)1,(void*)WaitMetal,(void*)ReleaseMetal};
}
static void GPUWork(GPUState*s){
  const auto ownThread=mach_thread_self();const auto cpuStart=GPUCPUTime(ownThread);
  if(const char*value=getenv("REPLAY_GPU_QOS")){
    if(strcmp(value,"utility")==0)pthread_set_qos_class_self_np(QOS_CLASS_UTILITY,0);
    else if(strcmp(value,"interactive")==0)pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
    else if(strcmp(value,"initiated")==0)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  }
  s->workerQos=(int)qos_class_self();
  bool attached=false;
  for(;;){
    GPUJob job;bool failed=false;
    {
      std::unique_lock<std::mutex>lock(s->mutex);
      s->changed.wait(lock,[&]{return s->stopping||!s->queue.empty()||s->paused;});
      if(s->queue.empty()&&s->paused){
        if(attached){if(!GPUCurrent(s,false))s->error="Cannot release worker GL context";attached=false;}
        s->ack=true;s->changed.notify_all();s->changed.wait(lock,[&]{return s->stopping||!s->paused||!s->queue.empty();});
      }
      if(s->queue.empty()&&s->stopping)break;
      if(s->queue.empty())continue;
      job=std::move(s->queue.front());s->queuedBytes-=job.bytes.size();s->queue.pop_front();
      if(!attached){if(!GPUCurrent(s,true))s->error="Cannot bind worker GL context";else attached=true;}
      failed=!s->error.empty();
    }
    const auto start=GPUClock::now();
    @autoreleasepool{
      if(job.fence){
        Fence fence{};if(!failed)fence=WorkerFence();
        {std::lock_guard<std::mutex>lock(job.fence->mutex);job.fence->failed=failed||!fence.display;job.fence->metal=fence;job.fence->ready=true;job.fence->changed.notify_all();}
        ReleaseDeferred(job.fence,nullptr);
      }else if(!failed&&!RunCommands(job.bytes.data(),job.bytes.size())){std::lock_guard<std::mutex>lock(s->mutex);s->error="Invalid GPU command buffer";}
    }
    const auto elapsed=GPUElapsed(start);s->executeNs+=elapsed;if(job.fence)s->fenceNs+=elapsed;s->jobs++;
  }
  if(attached)GPUCurrent(s,false);
  s->cpuUs=GPUCPUTime(ownThread)-cpuStart;mach_port_deallocate(mach_task_self(),ownThread);
}
static bool QueueGPU(GPUJob job){
  auto s=gpuThread;if(!s)return false;std::lock_guard<std::mutex>lock(s->mutex);
  if(!s->error.empty()||s->stopping||s->queue.size()>=256||s->queuedBytes+job.bytes.size()>67108864)return false;
  if(s->mainAttached){if(!CaptureGPU(s)){s->error="Cannot transfer main GL context";return false;}s->mainAttached=false;}
  s->paused=false;s->ack=false;s->queuedBytes+=job.bytes.size();s->queue.push_back(std::move(job));s->changed.notify_all();return true;
}
static bool PauseGPU(){
  auto s=gpuThread;if(!s)return true;const auto start=GPUClock::now();std::unique_lock<std::mutex>lock(s->mutex);
  if(!s->mainAttached){s->paused=true;s->changed.notify_all();s->changed.wait(lock,[&]{return s->ack;});if(!GPUCurrent(s,true)){s->error="Cannot restore main GL context";return false;}s->mainAttached=true;s->pauses++;}
  s->pauseNs+=GPUElapsed(start);return s->error.empty();
}
static bool StopGPU(){
  auto s=gpuThread;if(!s)return true;bool ok=PauseGPU();
  {std::lock_guard<std::mutex>lock(s->mutex);s->stopping=true;s->changed.notify_all();}s->worker.join();
  lastThreadStats[0]=s->jobs.load();lastThreadStats[1]=s->executeNs.load()/1e6;lastThreadStats[2]=s->pauseNs.load()/1e6;lastThreadStats[3]=s->pauses.load();lastThreadStats[4]=s->workerQos.load();lastThreadStats[5]=s->activity?1:0;
  lastThreadStats[6]=s->cpuUs.load()/1000.;
  lastThreadStats[7]=s->fenceNs.load()/1e6;
  if(s->activity){[[NSProcessInfo processInfo]endActivity:s->activity];[s->activity release];}
  delete s;gpuThread=nullptr;return ok;
}
static uint32_t WaitDeferred(void*object,void*,int,uint64_t){
  auto f=(DeferredFence*)object;std::unique_lock<std::mutex>lock(f->mutex);
  if(!f->changed.wait_for(lock,std::chrono::seconds(60),[&]{return f->ready;})||f->failed)return EGL_TIMEOUT_EXPIRED_KHR;
  return WaitMetal(f->metal.display,f->metal.sync,0,UINT64_MAX);
}
static uint32_t ReleaseDeferred(void*object,void*){
  auto f=(DeferredFence*)object;if(f->refs.fetch_sub(1)==1){if(f->metal.display)ReleaseMetal(f->metal.display,nullptr);delete f;}return 1;
}
static napi_value DeferredFences(napi_env env,int count){
  auto deferred=new DeferredFence(count+1);GPUJob job;job.fence=deferred;if(!QueueGPU(std::move(job))){delete deferred;return Fail(env,"Cannot queue GPU fence");}
  Fence fence{deferred,(void*)1,(void*)WaitDeferred,(void*)ReleaseDeferred};napi_value out;
  if(count==1)napi_create_buffer_copy(env,sizeof(fence),&fence,nullptr,&out);
  else{napi_create_array_with_length(env,count,&out);for(int i=0;i<count;i++){napi_value item;napi_create_buffer_copy(env,sizeof(fence),&fence,nullptr,&item);napi_set_element(env,out,i,item);}}
  return out;
}
static napi_value StartThread(napi_env env,napi_callback_info){if(!getProc||gpuThread)return Fail(env,"GPU worker cannot start");gpuThread=new GPUState;
  if(profileCommands)for(auto&p:commandProfiles)p={};
  subDataCalls=orphanCalls=orphanBytes=shadowReplacements=0;
  if(const char*value=getenv("REPLAY_CPU_ACTIVITY");value&&strcmp(value,"1")==0)gpuThread->activity=[[[NSProcessInfo processInfo]beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep reason:@"Offline replay export"]retain];
  gpuThread->worker=std::thread(GPUWork,gpuThread);return Number(env,1);}
static napi_value Barrier(napi_env env,napi_callback_info){if(!PauseGPU())return Fail(env,"GPU worker barrier failed");return Number(env,0);}
static napi_value ThreadStats(napi_env env,napi_callback_info){
  double values[8];for(int i=0;i<8;i++)values[i]=lastThreadStats[i];
  if(gpuThread){values[0]=gpuThread->jobs.load();values[1]=gpuThread->executeNs.load()/1e6;values[2]=gpuThread->pauseNs.load()/1e6;values[3]=gpuThread->pauses.load();values[4]=gpuThread->workerQos.load();values[5]=gpuThread->activity?1:0;values[6]=gpuThread->cpuUs.load()/1000.;values[7]=gpuThread->fenceNs.load()/1e6;}
  const char*keys[]={"jobs","executeMs","pauseMs","pauses","workerQos","cpuActivity","cpuMs","fenceMs"};napi_value out;napi_create_object(env,&out);for(int i=0;i<8;i++){napi_value value;napi_create_double(env,values[i],&value);napi_set_named_property(env,out,keys[i],value);}
  if(orphanBuffers&&!gpuThread){napi_value item;napi_create_object(env,&item);for(auto field:{std::pair<const char*,double>{"subDataCalls",(double)subDataCalls},{"fullReplacements",(double)orphanCalls},{"bytes",(double)orphanBytes},{"shadowReplacements",(double)shadowReplacements},{"shadowBytes",(double)shadowBytes}}){napi_value value;napi_create_double(env,field.second,&value);napi_set_named_property(env,item,field.first,value);}napi_set_named_property(env,out,"bufferOrphaning",item);}
  if(profileCommands&&!gpuThread){napi_value array;napi_create_array(env,&array);uint32_t cursor=0;for(size_t i=0;i<sizeof(CommandArgs)/sizeof(*CommandArgs);i++){const auto&p=commandProfiles[i];if(!p.calls)continue;napi_value item,name;napi_create_object(env,&item);napi_create_string_utf8(env,CommandNames[i],NAPI_AUTO_LENGTH,&name);napi_set_named_property(env,item,"name",name);for(auto field:{std::pair<const char*,double>{"calls",(double)p.calls},{"samples",(double)p.samples},{"firstMs",p.firstNs/1e6},{"sampleMs",p.nanos/1e6},{"estimatedMs",p.firstNs/1e6+(p.samples?p.nanos/1e6*(p.calls-1)/p.samples:0)}}){napi_value value;napi_create_double(env,field.second,&value);napi_set_named_property(env,item,field.first,value);}napi_set_element(env,array,cursor++,item);}napi_set_named_property(env,out,"commands",array);}
  return out;
}
