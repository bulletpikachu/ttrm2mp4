#include <node_api.h>
#include <IOSurface/IOSurface.h>
#include <cstdint>
extern "C" {
#include <x264.h>
}
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <deque>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <chrono>
#include <pthread/qos.h>
#include <sys/resource.h>
#ifndef REPLAY_X264_BUILD_LTO
#define REPLAY_X264_BUILD_LTO 0
#define REPLAY_X264_BUILD_NATIVE 0
#endif
#if defined(__aarch64__)
#include <arm_neon.h>
#endif
struct Fence{void*display=nullptr;void*sync=nullptr;void*wait=nullptr;void*destroy=nullptr;};
struct Frame{IOSurfaceRef surface;int64_t index;bool key;Fence fence;std::vector<uint8_t> bytes;};
struct Completion{int64_t index;int status;};
struct State{int width,height,fps;int mainQos=0,requestedQos=0,mainNice=0;std::atomic<int>workerQos{0};FILE*file=nullptr;x264_t*encoder=nullptr;napi_threadsafe_function notify;std::deque<Frame>queue;std::mutex mutex;std::condition_variable changed;std::thread worker;bool stopping=false,staging=false;std::atomic<int>error{0};std::atomic<int64_t>written{0},gpuWaitNs{0},lockNs{0},copyNs{0},encodeNs{0};};
using Clock=std::chrono::steady_clock;
static int64_t Elapsed(Clock::time_point start){return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now()-start).count();}
static State* current=nullptr;
static napi_value Fail(napi_env e,const char*text){napi_throw_error(e,nullptr,text);return nullptr;}
static void Notify(napi_env env,napi_value callback,void*,void*data){auto p=(Completion*)data;if(env&&callback){napi_value a[2],global,out;napi_get_global(env,&global);napi_create_int64(env,p->index,&a[0]);napi_create_int32(env,p->status,&a[1]);napi_call_function(env,global,callback,2,a,&out);}delete p;}
static void Write(State*s,x264_nal_t*nals,int count,int bytes){if(bytes<0){s->error=-1;return;}if(bytes>0){for(int i=0;i<count;i++)if(fwrite(nals[i].p_payload,1,nals[i].i_payload,s->file)!=(size_t)nals[i].i_payload)s->error=-2;s->written++;}}
static void Work(State*s){
  if(const char*value=getenv("REPLAY_ENCODER_QOS");value&&strcmp(value,"1")==0)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  s->workerQos=(int)qos_class_self();
  std::vector<uint8_t>cached;if(s->staging)cached.resize((size_t)s->width*s->height*3/2);
  for(;;){
    Frame frame;{std::unique_lock<std::mutex>lock(s->mutex);s->changed.wait(lock,[&]{return s->stopping||!s->queue.empty();});if(s->queue.empty()&&s->stopping)break;frame=std::move(s->queue.front());s->queue.pop_front();}
    int status=0;
    auto measured=Clock::now();
    if(frame.fence.sync){
      using Wait=uint32_t(*)(void*,void*,int,uint64_t);using Destroy=uint32_t(*)(void*,void*);
      const auto result=((Wait)frame.fence.wait)(frame.fence.display,frame.fence.sync,0,UINT64_MAX);
      ((Destroy)frame.fence.destroy)(frame.fence.display,frame.fence.sync);
      if(result!=0x30F6)status=-10000-(int)result; // EGL_CONDITION_SATISFIED_KHR
    }
    s->gpuWaitNs+=Elapsed(measured);measured=Clock::now();
    if(status){}
    else if(frame.surface&&IOSurfaceLock(frame.surface,kIOSurfaceLockReadOnly,nullptr)!=kIOReturnSuccess)status=-3;
    else{
      s->lockNs+=Elapsed(measured);measured=Clock::now();
      x264_picture_t in,out;x264_picture_init(&in);x264_picture_init(&out);in.img.i_csp=X264_CSP_NV12;in.img.i_plane=2;
      if(frame.surface)for(int i=0;i<2;i++){in.img.plane[i]=(uint8_t*)IOSurfaceGetBaseAddressOfPlane(frame.surface,i);in.img.i_stride[i]=(int)IOSurfaceGetBytesPerRowOfPlane(frame.surface,i);}
      else {in.img.plane[0]=frame.bytes.data();in.img.plane[1]=frame.bytes.data()+(size_t)s->width*s->height;in.img.i_stride[0]=in.img.i_stride[1]=s->width;}
      if(frame.surface&&s->staging){
        for(int plane=0;plane<2;plane++){
          auto destination=cached.data()+(plane?(size_t)s->width*s->height:0);
          for(int row=0;row<(plane?s->height/2:s->height);row++)memcpy(destination+(size_t)row*s->width,in.img.plane[plane]+(size_t)row*in.img.i_stride[plane],s->width);
          in.img.plane[plane]=destination;in.img.i_stride[plane]=s->width;
        }
        s->copyNs+=Elapsed(measured);measured=Clock::now();
      }
      in.i_pts=frame.index;in.i_type=frame.key?X264_TYPE_IDR:X264_TYPE_AUTO;
      x264_nal_t*nals=nullptr;int count=0;int bytes=x264_encoder_encode(s->encoder,&nals,&count,&in,&out);Write(s,nals,count,bytes);status=s->error.load();
      s->encodeNs+=Elapsed(measured);
      if(frame.surface)IOSurfaceUnlock(frame.surface,kIOSurfaceLockReadOnly,nullptr);
    }
    if(frame.surface)CFRelease(frame.surface);if(status)s->error=status;
    napi_call_threadsafe_function(s->notify,new Completion{frame.index,status},napi_tsfn_nonblocking);
  }
  while(x264_encoder_delayed_frames(s->encoder)>0){x264_nal_t*nals=nullptr;int count=0;x264_picture_t out;x264_picture_init(&out);int bytes=x264_encoder_encode(s->encoder,&nals,&count,nullptr,&out);Write(s,nals,count,bytes);if(bytes<0)break;}
}
static napi_value Open(napi_env env,napi_callback_info info){
  size_t argc=6;napi_value a[6];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);if(argc!=6||current)return Fail(env,"Expected width,height,fps,bitrate,path,callback with no encoder open");
  auto s=new State;napi_get_value_int32(env,a[0],&s->width);napi_get_value_int32(env,a[1],&s->height);napi_get_value_int32(env,a[2],&s->fps);
  if(const char*value=getenv("REPLAY_SURFACE_STAGING"))s->staging=strcmp(value,"1")==0;
  s->mainQos=(int)qos_class_self();s->mainNice=getpriority(PRIO_PROCESS,0);
  if(const char*value=getenv("REPLAY_ENCODER_QOS");value&&strcmp(value,"1")==0)s->requestedQos=pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  if(s->width<=0||s->height<=0||s->fps<=0){delete s;return Fail(env,"Invalid encoder size or fps");}
  size_t length=0;napi_get_value_string_utf8(env,a[4],nullptr,0,&length);std::vector<char>path(length+1);napi_get_value_string_utf8(env,a[4],path.data(),path.size(),&length);s->file=fopen(path.data(),"wb");if(!s->file){delete s;return Fail(env,"Cannot open output file");}
  x264_param_t param;x264_param_default_preset(&param,"ultrafast",nullptr);param.i_width=s->width;param.i_height=s->height;param.i_csp=X264_CSP_NV12;param.i_fps_num=s->fps;param.i_fps_den=1;param.i_timebase_num=1;param.i_timebase_den=s->fps;param.b_vfr_input=0;param.i_threads=4;
  if(const char*value=getenv("REPLAY_X264_THREADS")){int n=atoi(value);if(n>=1&&n<=32)param.i_threads=n;}
  if(const char*value=getenv("REPLAY_X264_SLICED"))param.b_sliced_threads=strcmp(value,"1")==0;
  param.rc.i_rc_method=X264_RC_CRF;param.rc.f_rf_constant=18;param.b_repeat_headers=1;param.b_annexb=1;param.i_keyint_max=s->fps*2;param.i_bframe=0;param.i_log_level=X264_LOG_WARNING;param.vui.b_fullrange=0;param.vui.i_colorprim=1;param.vui.i_transfer=13;param.vui.i_colmatrix=1;
  if(const char*value=getenv("REPLAY_X264_QP")){param.rc.i_rc_method=X264_RC_CQP;param.rc.i_qp_constant=atoi(value);}
  if(const char*value=getenv("REPLAY_X264_INTRA");value&&strcmp(value,"1")==0){param.i_keyint_max=1;param.i_keyint_min=1;param.i_scenecut_threshold=0;}
  const bool interactiveCodec=getenv("REPLAY_CODEC_INTERACTIVE")&&strcmp(getenv("REPLAY_CODEC_INTERACTIVE"),"1")==0;
  if(interactiveCodec)pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
  x264_param_apply_profile(&param,"high");s->encoder=x264_encoder_open(&param);
  if(interactiveCodec)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);
  if(!s->encoder){fclose(s->file);delete s;return Fail(env,"x264 initialization failed");}
  if(const char*value=getenv("REPLAY_MAIN_INTERACTIVE");value&&strcmp(value,"1")==0)pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
  napi_value label;napi_create_string_utf8(env,"x264-surface-encoder",NAPI_AUTO_LENGTH,&label);auto status=napi_create_threadsafe_function(env,a[5],nullptr,label,0,1,nullptr,nullptr,nullptr,Notify,&s->notify);if(status!=napi_ok){x264_encoder_close(s->encoder);fclose(s->file);delete s;return Fail(env,"Cannot create completion callback");}
  current=s;s->worker=std::thread(Work,s);napi_value out;napi_get_undefined(env,&out);return out;
}
static napi_value Encode(napi_env env,napi_callback_info info){
  size_t argc=4;napi_value a[4];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);if(argc<2||!current)return Fail(env,"Encoder is not open or arguments missing");
  bool buffer=false;napi_is_buffer(env,a[0],&buffer);void*data=nullptr;size_t length=0;if(!buffer||napi_get_buffer_info(env,a[0],&data,&length)!=napi_ok||length!=sizeof(IOSurfaceRef))return Fail(env,"Expected process-local IOSurface pointer");
  IOSurfaceRef surface=nullptr;memcpy(&surface,data,sizeof(surface));if(!surface||IOSurfaceGetPlaneCount(surface)!=2||(IOSurfaceGetWidth(surface)!=(size_t)current->width&&!(IOSurfaceGetPixelFormat(surface)==(uint32_t)'RGBA'&&IOSurfaceGetWidth(surface)*4==(size_t)current->width))||IOSurfaceGetHeight(surface)<(size_t)current->height)return Fail(env,"Unexpected surface shape");
  for(int plane=0;plane<2;plane++)if(IOSurfaceGetBytesPerRowOfPlane(surface,plane)<(size_t)current->width||IOSurfaceGetHeightOfPlane(surface,plane)<(size_t)(plane?current->height/2:current->height))return Fail(env,"Surface planes do not cover the logical NV12 image");
  int64_t index=0;bool key=false;napi_get_value_int64(env,a[1],&index);if(argc>2)napi_get_value_bool(env,a[2],&key);if(index<0)return Fail(env,"Negative frame index");
  Fence fence;
  if(argc>3){bool isBuffer=false;napi_is_buffer(env,a[3],&isBuffer);void*bytes=nullptr;size_t count=0;if(!isBuffer||napi_get_buffer_info(env,a[3],&bytes,&count)!=napi_ok||count!=sizeof(Fence))return Fail(env,"Invalid GPU fence");memcpy(&fence,bytes,sizeof(fence));if(!fence.display||!fence.sync||!fence.wait||!fence.destroy)return Fail(env,"Incomplete GPU fence");}
  {std::lock_guard<std::mutex>lock(current->mutex);if(current->queue.size()>=256)return Fail(env,"Native encoder queue full");CFRetain(surface);current->queue.push_back({surface,index,key,fence});}current->changed.notify_one();napi_value out;napi_get_undefined(env,&out);return out;
}
static napi_value Close(napi_env env,napi_callback_info){
  if(!current){napi_value out;napi_get_undefined(env,&out);return out;}auto s=current;current=nullptr;{std::lock_guard<std::mutex>lock(s->mutex);s->stopping=true;}s->changed.notify_one();s->worker.join();x264_encoder_close(s->encoder);fclose(s->file);int error=s->error.load();int64_t written=s->written.load();napi_release_threadsafe_function(s->notify,napi_tsfn_release);delete s;if(error)return Fail(env,"Native x264 encoding failed");napi_value out;napi_create_int64(env,written,&out);return out;
}
static napi_value EncodeBytesCommon(napi_env env,napi_callback_info info,bool packed){
  size_t argc=4;napi_value a[4];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);if(argc<2||!current)return Fail(env,"Encoder is not open or arguments missing");
  void*data=nullptr;size_t length=0;bool buffer=false;napi_is_buffer(env,a[0],&buffer);
  if(buffer){if(napi_get_buffer_info(env,a[0],&data,&length)!=napi_ok)return Fail(env,"Invalid byte buffer");}
  else {napi_typedarray_type type;napi_value backing;size_t offset;if(napi_get_typedarray_info(env,a[0],&type,&length,&data,&backing,&offset)!=napi_ok||(type!=napi_uint8_array&&type!=napi_uint8_clamped_array))return Fail(env,"Expected an NV12 byte array");}
  const size_t expected=(size_t)current->width*current->height*3/2;
  if(length!=(packed?expected/3*4:expected))return Fail(env,"Unexpected NV12 byte length");
  int64_t index=0;bool key=false;if(napi_get_value_int64(env,a[1],&index)!=napi_ok||index<0)return Fail(env,"Invalid frame index");if(argc>2)napi_get_value_bool(env,a[2],&key);
  std::vector<uint8_t> bytes(expected);
  if(packed){
    bool bgr=false;if(argc>3)napi_get_value_bool(env,a[3],&bgr);
    const auto source=(const uint8_t*)data;size_t pixels=length/4,i=0;
#if defined(__aarch64__)
    for(;i+16<=pixels;i+=16){const auto rgba=vld4q_u8(source+i*4);uint8x16x3_t rgb={{rgba.val[bgr?2:0],rgba.val[1],rgba.val[bgr?0:2]}};vst3q_u8(bytes.data()+i*3,rgb);}
#endif
    for(;i<pixels;i++){bytes[i*3]=source[i*4+(bgr?2:0)];bytes[i*3+1]=source[i*4+1];bytes[i*3+2]=source[i*4+(bgr?0:2)];}
  }else memcpy(bytes.data(),data,length);
  {std::lock_guard<std::mutex>lock(current->mutex);if(current->queue.size()>=64)return Fail(env,"Native byte encoder queue full");current->queue.push_back({nullptr,index,key,{},std::move(bytes)});}current->changed.notify_one();napi_value out;napi_get_undefined(env,&out);return out;
}
static napi_value EncodeBytes(napi_env env,napi_callback_info info){return EncodeBytesCommon(env,info,false);}
static napi_value EncodePackedRGB(napi_env env,napi_callback_info info){return EncodeBytesCommon(env,info,true);}
static napi_value Stats(napi_env env,napi_callback_info){napi_value out;napi_create_object(env,&out);if(!current)return out;for(auto item:{std::pair<const char*,double>{"gpuWaitMs",current->gpuWaitNs.load()/1e6},{"surfaceLockMs",current->lockNs.load()/1e6},{"copyMs",current->copyNs.load()/1e6},{"staging",current->staging?1.:0.},{"encodeMs",current->encodeNs.load()/1e6},{"mainQos",current->mainQos},{"workerQos",current->workerQos.load()},{"qosRequestStatus",current->requestedQos},{"mainNice",current->mainNice},{"buildLto",REPLAY_X264_BUILD_LTO},{"buildNativeCpu",REPLAY_X264_BUILD_NATIVE}}){napi_value value;napi_create_double(env,item.second,&value);napi_set_named_property(env,out,item.first,value);}return out;}
static napi_value Init(napi_env env,napi_value exports){for(auto item:{std::pair<const char*,napi_callback>{"open",Open},{"encode",Encode},{"encodeBytes",EncodeBytes},{"encodePackedRGB",EncodePackedRGB},{"close",Close},{"stats",Stats}}){napi_value fn;napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,nullptr,&fn);napi_set_named_property(env,exports,item.first,fn);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
