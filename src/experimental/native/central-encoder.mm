#include <node_api.h>
#include <IOSurface/IOSurface.h>
#include <pthread/qos.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <servers/bootstrap.h>
#include <unistd.h>
extern "C" {
#include <x264.h>
}
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

// Renderer processes retain their surface pool until the central encoder
// acknowledges consumption. Retained Mach ports carry surfaces; pixels stay
// shared, while the socket carries control messages and completion notices.
struct Fence{void*object;void*value;void*wait;void*release;};
struct ExportFrame{IOSurfaceRef surface;int64_t index;Fence fence;};
struct Notice{int kind;int64_t index;double value;int status;double encodeMs=0;};
static napi_value Fail(napi_env e,const char*s){napi_throw_error(e,nullptr,s);return nullptr;}
static napi_value Undefined(napi_env e){napi_value v;napi_get_undefined(e,&v);return v;}
static void Notify(napi_env env,napi_value callback,void*,void*data){
  auto p=(Notice*)data;
  if(env&&callback){napi_value a[5],global,result;napi_get_global(env,&global);napi_create_int32(env,p->kind,&a[0]);napi_create_int64(env,p->index,&a[1]);napi_create_double(env,p->value,&a[2]);napi_create_int32(env,p->status,&a[3]);napi_create_double(env,p->encodeMs,&a[4]);napi_call_function(env,global,callback,5,a,&result);}delete p;
}
static bool Callback(napi_env env,napi_value callback,const char*name,napi_threadsafe_function*out){napi_value label;napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&label);return napi_create_threadsafe_function(env,callback,nullptr,label,0,1,nullptr,nullptr,nullptr,Notify,out)==napi_ok;}
struct SurfaceMessage{mach_msg_header_t header;mach_msg_body_t body;mach_msg_port_descriptor_t port;int32_t session;int64_t index;int32_t key;};
struct Exporter{std::mutex mutex;std::condition_variable changed;std::deque<ExportFrame>queue;std::map<int64_t,IOSurfaceRef>ready;std::thread worker;bool stopping=false;napi_threadsafe_function notify;mach_port_t server=MACH_PORT_NULL;};
static Exporter*exporter=nullptr;
static napi_value StartExporter(napi_env env,napi_callback_info info){
  size_t n=2;napi_value a[2];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);if(n!=2||exporter)return Fail(env,"Exporter already running or callback missing");
  char service[256];size_t length;napi_get_value_string_utf8(env,a[0],service,sizeof(service),&length);
  auto s=new Exporter;if(bootstrap_look_up(bootstrap_port,service,&s->server)!=KERN_SUCCESS){delete s;return Fail(env,"Cannot find shared-surface Mach service");}
  if(!Callback(env,a[1],"shared-surface-ready",&s->notify)){mach_port_deallocate(mach_task_self(),s->server);delete s;return Fail(env,"Cannot create GPU export callback");}
  if(const char*value=getenv("REPLAY_ENCODER_QOS");value&&strcmp(value,"1")==0)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  if(const char*value=getenv("REPLAY_MAIN_INTERACTIVE");value&&strcmp(value,"1")==0)pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
  exporter=s;s->worker=std::thread([s]{
    for(;;){ExportFrame f;{std::unique_lock<std::mutex>lock(s->mutex);s->changed.wait(lock,[&]{return s->stopping||!s->queue.empty();});if(s->queue.empty())break;f=s->queue.front();s->queue.pop_front();}
      using Wait=uint32_t(*)(void*,void*,int,uint64_t);using Release=uint32_t(*)(void*,void*);
      auto result=((Wait)f.fence.wait)(f.fence.object,f.fence.value,0,UINT64_MAX);((Release)f.fence.release)(f.fence.object,f.fence.value);
      if(result==0x30F6){std::lock_guard<std::mutex>lock(s->mutex);s->ready.emplace(f.index,f.surface);}else CFRelease(f.surface);
      napi_call_threadsafe_function(s->notify,new Notice{0,f.index,0,result==0x30F6?0:-(int)result},napi_tsfn_nonblocking);
    }
  });return Undefined(env);
}
static napi_value Export(napi_env env,napi_callback_info info){
  size_t n=3;napi_value a[3];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);if(n!=3||!exporter)return Fail(env,"GPU exporter is not running");
  void*pointer;size_t size;bool buffer=false;napi_is_buffer(env,a[0],&buffer);if(!buffer||napi_get_buffer_info(env,a[0],&pointer,&size)!=napi_ok||size!=sizeof(IOSurfaceRef))return Fail(env,"Invalid surface handle");
  ExportFrame f{};memcpy(&f.surface,pointer,size);if(!f.surface||napi_get_value_int64(env,a[1],&f.index)!=napi_ok||f.index<0)return Fail(env,"Invalid shared frame");
  napi_is_buffer(env,a[2],&buffer);if(!buffer||napi_get_buffer_info(env,a[2],&pointer,&size)!=napi_ok||size!=sizeof(Fence))return Fail(env,"Invalid shared GPU fence");memcpy(&f.fence,pointer,size);
  if(!f.fence.object||!f.fence.value||!f.fence.wait||!f.fence.release)return Fail(env,"Incomplete shared GPU fence");
  {std::lock_guard<std::mutex>lock(exporter->mutex);if(exporter->stopping||exporter->queue.size()>=256)return Fail(env,"GPU export queue full");CFRetain(f.surface);exporter->queue.push_back(f);}exporter->changed.notify_one();return Undefined(env);
}
static napi_value SendFrame(napi_env env,napi_callback_info info){
  size_t n=3;napi_value a[3];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);int64_t index;int session;bool key;
  if(n!=3||!exporter||napi_get_value_int64(env,a[0],&index)!=napi_ok||napi_get_value_int32(env,a[1],&session)!=napi_ok||napi_get_value_bool(env,a[2],&key)!=napi_ok)return Fail(env,"Invalid Mach surface transfer");
  IOSurfaceRef surface;{std::lock_guard<std::mutex>lock(exporter->mutex);auto it=exporter->ready.find(index);if(it==exporter->ready.end())return Fail(env,"Shared surface is not GPU-ready");surface=it->second;exporter->ready.erase(it);}
  SurfaceMessage m{};m.header.msgh_bits=MACH_MSGH_BITS_COMPLEX|MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0);m.header.msgh_size=sizeof(m);m.header.msgh_remote_port=exporter->server;m.header.msgh_id=0x52504c59;m.body.msgh_descriptor_count=1;
  m.port.name=IOSurfaceCreateMachPort(surface);m.port.disposition=MACH_MSG_TYPE_MOVE_SEND;m.port.type=MACH_MSG_PORT_DESCRIPTOR;m.session=session;m.index=index;m.key=key;
  auto result=mach_msg(&m.header,MACH_SEND_MSG|MACH_SEND_TIMEOUT,sizeof(m),0,MACH_PORT_NULL,1000,MACH_PORT_NULL);CFRelease(surface);
  if(result!=KERN_SUCCESS){if(m.port.name)mach_port_deallocate(mach_task_self(),m.port.name);return Fail(env,"Mach surface transfer failed");}return Undefined(env);
}
static napi_value StopExporter(napi_env env,napi_callback_info){if(exporter){auto s=exporter;exporter=nullptr;{std::lock_guard<std::mutex>lock(s->mutex);s->stopping=true;}s->changed.notify_all();s->worker.join();for(auto [index,surface]:s->ready)CFRelease(surface);mach_port_deallocate(mach_task_self(),s->server);napi_release_threadsafe_function(s->notify,napi_tsfn_release);delete s;}return Undefined(env);}

struct Input{IOSurfaceRef surface;int64_t index;bool key;};
struct Session{int id,width,height;FILE*file=nullptr;x264_t*codec=nullptr;napi_threadsafe_function notify;std::deque<Input>queue;bool closing=false;int status=0;int64_t frames=0,received=0,expected=0,last=-1;double encodeMs=0;};
struct Scheduler{std::mutex mutex;std::condition_variable changed;std::map<int,Session*>sessions;std::thread worker,receiver;bool stopping=false;int next=1,minBatch=1;mach_port_t port=MACH_PORT_NULL;};
static Scheduler*scheduler=nullptr;
static void Write(Session*s,x264_nal_t*nals,int count,int bytes){if(bytes<0){s->status=-1;return;}if(bytes){for(int i=0;i<count;i++)if(fwrite(nals[i].p_payload,1,nals[i].i_payload,s->file)!=(size_t)nals[i].i_payload)s->status=-2;s->frames++;}}
static void Encode(Session*s,Input f){
  auto start=std::chrono::steady_clock::now();int status=0;
  if(IOSurfaceLock(f.surface,kIOSurfaceLockReadOnly,nullptr)!=kIOReturnSuccess)status=-3;
  else{
    x264_picture_t in,out;x264_picture_init(&in);x264_picture_init(&out);in.img.i_csp=X264_CSP_NV12;in.img.i_plane=2;
    for(int i=0;i<2;i++){in.img.plane[i]=(uint8_t*)IOSurfaceGetBaseAddressOfPlane(f.surface,i);in.img.i_stride[i]=(int)IOSurfaceGetBytesPerRowOfPlane(f.surface,i);}
    in.i_pts=f.index;in.i_type=f.key?X264_TYPE_IDR:X264_TYPE_AUTO;x264_nal_t*nals=nullptr;int count=0;auto bytes=x264_encoder_encode(s->codec,&nals,&count,&in,&out);Write(s,nals,count,bytes);status=s->status;
    IOSurfaceUnlock(f.surface,kIOSurfaceLockReadOnly,nullptr);
  }
  s->encodeMs+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  if(status)s->status=status;CFRelease(f.surface);napi_call_threadsafe_function(s->notify,new Notice{1,f.index,0,status},napi_tsfn_nonblocking);
}
static void Work(Scheduler*g){
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  for(;;){Session*s=nullptr;std::vector<Input>batch;bool close=false;
    {std::unique_lock<std::mutex>lock(g->mutex);g->changed.wait(lock,[&]{if(g->stopping)return true;for(auto [id,p]:g->sessions)if((p->closing&&p->received==p->expected)||(!p->queue.empty()&&(p->closing||p->queue.size()>=(size_t)g->minBatch)))return true;return false;});if(g->stopping)break;
      for(auto [id,p]:g->sessions)if(p->closing&&p->received==p->expected&&p->queue.empty()){s=p;close=true;break;}
      if(!s)for(auto [id,p]:g->sessions)if(!p->queue.empty()&&(!s||p->queue.size()>s->queue.size()))s=p;
      if(close)g->sessions.erase(s->id);
      else for(int i=0;i<32&&!s->queue.empty();i++){batch.push_back(s->queue.front());s->queue.pop_front();}
    }
    if(close){
      while(x264_encoder_delayed_frames(s->codec)>0){x264_nal_t*nals=nullptr;int count=0;x264_picture_t out;x264_picture_init(&out);auto bytes=x264_encoder_encode(s->codec,&nals,&count,nullptr,&out);Write(s,nals,count,bytes);if(bytes<0)break;}
      x264_encoder_close(s->codec);if(fclose(s->file))s->status=-4;
      napi_call_threadsafe_function(s->notify,new Notice{2,0,(double)s->frames,s->status,s->encodeMs},napi_tsfn_nonblocking);napi_release_threadsafe_function(s->notify,napi_tsfn_release);delete s;
    }else for(auto f:batch)Encode(s,f);
  }
}
static napi_value Listen(napi_env env,napi_callback_info){
  if(scheduler)return Fail(env,"Shared-surface service already running");auto g=new Scheduler;
  if(const char*value=getenv("REPLAY_CENTRAL_MIN_BATCH")){g->minBatch=atoi(value);if(g->minBatch<1||g->minBatch>32){delete g;return Fail(env,"Central minimum batch must be 1–32");}}
  char name[256];snprintf(name,sizeof(name),"local.replay-render.%d.%llu",getpid(),mach_absolute_time());
  if(mach_port_allocate(mach_task_self(),MACH_PORT_RIGHT_RECEIVE,&g->port)!=KERN_SUCCESS||mach_port_insert_right(mach_task_self(),g->port,g->port,MACH_MSG_TYPE_MAKE_SEND)!=KERN_SUCCESS||bootstrap_register(bootstrap_port,name,g->port)!=KERN_SUCCESS){if(g->port)mach_port_destroy(mach_task_self(),g->port);delete g;return Fail(env,"Cannot register shared-surface Mach service");}
  mach_port_limits_t limits{64};mach_port_set_attributes(mach_task_self(),g->port,MACH_PORT_LIMITS_INFO,(mach_port_info_t)&limits,MACH_PORT_LIMITS_INFO_COUNT);
  scheduler=g;g->worker=std::thread(Work,g);g->receiver=std::thread([g]{
    for(;;){struct{SurfaceMessage message;uint8_t trailer[128];}storage{};auto&m=storage.message;
      auto result=mach_msg(&m.header,MACH_RCV_MSG,0,sizeof(storage),g->port,MACH_MSG_TIMEOUT_NONE,MACH_PORT_NULL);if(result!=KERN_SUCCESS)break;
      if(m.header.msgh_id!=0x52504c59||m.header.msgh_size!=sizeof(SurfaceMessage)||!(m.header.msgh_bits&MACH_MSGH_BITS_COMPLEX)||m.body.msgh_descriptor_count!=1||m.port.type!=MACH_MSG_PORT_DESCRIPTOR){mach_msg_destroy(&m.header);continue;}
      IOSurfaceRef surface=IOSurfaceLookupFromMachPort(m.port.name);mach_port_deallocate(mach_task_self(),m.port.name);
      std::lock_guard<std::mutex>lock(g->mutex);auto it=g->sessions.find(m.session);if(it==g->sessions.end()){if(surface)CFRelease(surface);continue;}auto s=it->second;
      if(!surface||m.index<=s->last||s->queue.size()>=256||(s->closing&&s->received>=s->expected)||IOSurfaceGetPlaneCount(surface)!=2||IOSurfaceGetWidth(surface)!=(size_t)s->width||IOSurfaceGetHeight(surface)!=(size_t)s->height){if(surface)CFRelease(surface);s->status=-5;napi_call_threadsafe_function(s->notify,new Notice{1,m.index,0,-5},napi_tsfn_nonblocking);continue;}
      s->last=m.index;s->received++;s->queue.push_back({surface,m.index,m.key!=0});g->changed.notify_one();
    }
  });napi_value out;napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&out);return out;
}
static napi_value Open(napi_env env,napi_callback_info info){
  size_t n=6;napi_value a[6];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);if(n!=6)return Fail(env,"Expected width,height,fps,threads,path,callback");int w,h,fps,threads;
  if(napi_get_value_int32(env,a[0],&w)!=napi_ok||napi_get_value_int32(env,a[1],&h)!=napi_ok||napi_get_value_int32(env,a[2],&fps)!=napi_ok||napi_get_value_int32(env,a[3],&threads)!=napi_ok||w<2||h<2||w%2||h%2||w>3840||h>2160||fps<1||fps>60||threads<1||threads>32)return Fail(env,"Invalid central encoder dimensions/threads");
  size_t length=0;napi_get_value_string_utf8(env,a[4],nullptr,0,&length);std::vector<char>path(length+1);napi_get_value_string_utf8(env,a[4],path.data(),path.size(),&length);
  auto s=new Session;s->width=w;s->height=h;s->file=fopen(path.data(),"wb");if(!s->file){delete s;return Fail(env,"Cannot open central video output");}
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  x264_param_t p;x264_param_default_preset(&p,"ultrafast",nullptr);p.i_width=w;p.i_height=h;p.i_csp=X264_CSP_NV12;p.i_fps_num=fps;p.i_fps_den=1;p.i_timebase_num=1;p.i_timebase_den=fps;p.b_vfr_input=0;p.i_threads=threads;p.rc.i_rc_method=X264_RC_CRF;p.rc.f_rf_constant=18;p.b_repeat_headers=1;p.b_annexb=1;p.i_keyint_max=fps*2;p.i_bframe=0;p.i_log_level=X264_LOG_WARNING;p.vui.b_fullrange=0;p.vui.i_colorprim=1;p.vui.i_transfer=13;p.vui.i_colmatrix=1;x264_param_apply_profile(&p,"high");
  s->codec=x264_encoder_open(&p);if(!s->codec){fclose(s->file);delete s;return Fail(env,"Cannot initialize central x264");}
  if(!Callback(env,a[5],"central-x264",&s->notify)){x264_encoder_close(s->codec);fclose(s->file);delete s;return Fail(env,"Cannot create central callback");}
  if(!scheduler){x264_encoder_close(s->codec);fclose(s->file);napi_release_threadsafe_function(s->notify,napi_tsfn_abort);delete s;return Fail(env,"Mach surface service is not running");}
  {std::lock_guard<std::mutex>lock(scheduler->mutex);s->id=scheduler->next++;scheduler->sessions.emplace(s->id,s);}napi_value result;napi_create_int32(env,s->id,&result);return result;
}
static napi_value Submit(napi_env env,napi_callback_info info){
  size_t n=4;napi_value a[4];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);int id;uint32_t surfaceID;Input f{};
  if(n!=4||!scheduler||napi_get_value_int32(env,a[0],&id)!=napi_ok||napi_get_value_uint32(env,a[1],&surfaceID)!=napi_ok||napi_get_value_int64(env,a[2],&f.index)!=napi_ok||f.index<0||napi_get_value_bool(env,a[3],&f.key)!=napi_ok)return Fail(env,"Invalid central frame");
  auto g=scheduler;std::lock_guard<std::mutex>lock(g->mutex);auto found=g->sessions.find(id);if(found==g->sessions.end()||found->second->closing||found->second->queue.size()>=256)return Fail(env,"Central session closed or queue full");auto s=found->second;
  f.surface=IOSurfaceLookup(surfaceID);if(!f.surface)return Fail(env,"Shared IOSurface lookup failed");
  if(IOSurfaceGetPlaneCount(f.surface)!=2||IOSurfaceGetWidth(f.surface)!=(size_t)s->width||IOSurfaceGetHeight(f.surface)!=(size_t)s->height){CFRelease(f.surface);return Fail(env,"Shared IOSurface has incorrect dimensions");}
  s->received++;s->queue.push_back(f);g->changed.notify_one();return Undefined(env);
}
static napi_value Finish(napi_env env,napi_callback_info info){size_t n=2;napi_value a[2];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);int id;int64_t expected;if(n!=2||!scheduler||napi_get_value_int32(env,a[0],&id)!=napi_ok||napi_get_value_int64(env,a[1],&expected)!=napi_ok||expected<0)return Fail(env,"Invalid central session");auto g=scheduler;std::lock_guard<std::mutex>lock(g->mutex);auto found=g->sessions.find(id);if(found==g->sessions.end()||found->second->closing||expected<found->second->received)return Fail(env,"Central session already closed or has excess frames");found->second->closing=true;found->second->expected=expected;g->changed.notify_one();return Undefined(env);}
static napi_value Qos(napi_env env,napi_callback_info){napi_value value;napi_create_int32(env,(int)qos_class_self(),&value);return value;}
static napi_value Init(napi_env env,napi_value out){for(auto item:{std::pair<const char*,napi_callback>{"startExporter",StartExporter},{"exportFrame",Export},{"sendFrame",SendFrame},{"stopExporter",StopExporter},{"listen",Listen},{"open",Open},{"submit",Submit},{"finish",Finish},{"qos",Qos}}){napi_value fn;napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,nullptr,&fn);napi_set_named_property(env,out,item.first,fn);}return out;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
