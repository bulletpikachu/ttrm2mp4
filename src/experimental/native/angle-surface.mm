#include <node_api.h>
#include <CoreVideo/CoreVideo.h>
#include <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <GLES2/gl2ext_angle.h>
#include <dlfcn.h>
#include <string>
#include <vector>
#include <cstring>
#include <cmath>
#include <cstdint>
#include <deque>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <chrono>
#include <pthread/qos.h>
#include <mach/mach.h>
#include <unordered_map>

// Import NV12 planes into the *same* statically linked ANGLE instance used by
// node-webgl. The browser's ANGLE context is never accessed by this addon.
static void* library = nullptr;
static PFNEGLGETPROCADDRESSPROC getProc = nullptr;
template<class T> static T Proc(const char* name) { return reinterpret_cast<T>(getProc(name)); }
static napi_value Fail(napi_env e, const char* text) { napi_throw_error(e,nullptr,text); return nullptr; }
static napi_value Number(napi_env e,int value) { napi_value out;napi_create_int32(e,value,&out);return out; }
struct BufferStorage{GLsizeiptr size;GLenum usage;std::vector<uint8_t>shadow;};
struct BufferContext{GLuint arrayBuffer=0;std::unordered_map<GLuint,BufferStorage>storage;};
static std::unordered_map<EGLContext,BufferContext>bufferContexts;
static BufferContext*bufferContext=nullptr;
static const bool shadowOrphan=getenv("REPLAY_GL_SHADOW_ORPHAN")&&strcmp(getenv("REPLAY_GL_SHADOW_ORPHAN"),"1")==0;
static const bool orphanBuffers=shadowOrphan||(getenv("REPLAY_GL_ORPHAN")&&strcmp(getenv("REPLAY_GL_ORPHAN"),"1")==0);
static int64_t subDataCalls=0,orphanCalls=0,orphanBytes=0;
static int64_t shadowBytes=0,shadowReplacements=0;
static void ClearBufferShadows(){for(auto&context:bufferContexts)for(auto&entry:context.second.storage)std::vector<uint8_t>().swap(entry.second.shadow);shadowBytes=0;}
static void OrphanBufferData(GLenum target,GLsizeiptr size,const void*data,GLenum usage){
  static auto replace=Proc<PFNGLBUFFERDATAPROC>("glBufferData");
  if(target==GL_ARRAY_BUFFER&&bufferContext&&bufferContext->arrayBuffer&&size>=0&&(usage==GL_STATIC_DRAW||usage==GL_DYNAMIC_DRAW||usage==GL_STREAM_DRAW)){
    auto&entry=bufferContext->storage[bufferContext->arrayBuffer];shadowBytes-=entry.shadow.size();entry={size,usage,{}};
    if(size>0&&size<=67108864-shadowBytes){entry.shadow=std::vector<uint8_t>((size_t)size);if(data)memcpy(entry.shadow.data(),data,size);shadowBytes+=size;}
  }
  if(target!=GL_ARRAY_BUFFER)ClearBufferShadows();
  replace(target,size,data,usage);
}
static void OrphanBufferSubData(GLenum target,GLintptr offset,GLsizeiptr size,const void*data){
  static auto replace=Proc<PFNGLBUFFERDATAPROC>("glBufferData");
  static auto update=Proc<PFNGLBUFFERSUBDATAPROC>("glBufferSubData");
  subDataCalls++;
  if(target==GL_ARRAY_BUFFER&&offset>=0&&size>0&&bufferContext&&bufferContext->arrayBuffer){
    auto found=bufferContext->storage.find(bufferContext->arrayBuffer);
    if(found!=bufferContext->storage.end()&&shadowOrphan&&found->second.shadow.size()==(size_t)found->second.size&&offset<=found->second.size&&size<=found->second.size-offset){
      auto&entry=found->second;memcpy(entry.shadow.data()+offset,data,size);
      replace(target,entry.size,entry.shadow.data(),entry.usage);shadowReplacements++;orphanCalls++;orphanBytes+=entry.size;return;
    }
    if(found!=bufferContext->storage.end()&&offset==0&&found->second.size==size){
      // A complete replacement has no live tail to preserve. GLES retains the
      // old store for earlier draws; buffer identity, usage and bytes stay equal.
      replace(target,size,data,found->second.usage);orphanCalls++;orphanBytes+=size;return;
    }
  }
  if(shadowOrphan&&target!=GL_ARRAY_BUFFER)ClearBufferShadows();
  update(target,offset,size,data);
}
#include "gl-commands.inc"
static bool RunCommands(const uint8_t*data,size_t length){
  if(orphanBuffers)bufferContext=&bufferContexts[Proc<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")()];
  for(size_t cursor=0;cursor<length;){
    if(length-cursor<16)return false;
    const auto p=(const double*)(data+cursor);
    if(!std::isfinite(p[0])||p[0]<0||p[0]>=sizeof(CommandArgs)/sizeof(*CommandArgs)||p[0]!=std::floor(p[0])||!std::isfinite(p[1])||p[1]<0||p[1]>length||p[1]!=std::floor(p[1]))return false;
    const size_t opcode=(size_t)p[0],end=(size_t)p[1],header=cursor+(CommandArgs[opcode]+2)*8;
    if(end<header||end%8||header>length||!ExecuteCommand(opcode,p+2,data,header,end))return false;cursor=end;
  }
  return true;
}
struct Surface { CVPixelBufferRef pixel=nullptr; IOSurfaceRef owned=nullptr; EGLDisplay display; EGLSurface planes[2]={EGL_NO_SURFACE,EGL_NO_SURFACE}; GLuint textures[2]={0,0}; GLenum target=0; };
static std::vector<Surface*> surfaces;
struct Fence { void* display; void* sync; void* wait; void* destroy; };
static uint32_t WaitMetal(void* object,void* value,int,uint64_t) {
  id<MTLSharedEvent> event=(id<MTLSharedEvent>)object;
  return [event waitUntilSignaledValue:(uint64_t)value timeoutMS:60000]?EGL_CONDITION_SATISFIED_KHR:EGL_TIMEOUT_EXPIRED_KHR;
}
static uint32_t ReleaseMetal(void* object,void*) { [(id<MTLSharedEvent>)object release];return 1; }
#include "gl-worker.inc"
#include "metal-probe.inc"
#include "implicit-resolve.inc"
#include "packed-nv12.inc"
static napi_value InvalidateBufferShadows(napi_env env,napi_callback_info){if(!PauseGPU())return Fail(env,"Buffer shadow invalidation requires an idle context");ClearBufferShadows();return Number(env,0);}
static napi_value Execute(napi_env env,napi_callback_info info){
  if(!getProc)return Fail(env,"ANGLE is not loaded");
  size_t argc=1;napi_value a[1];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);
  napi_typedarray_type type;size_t length,byteOffset;void*pointer;napi_value backing;
  if(argc!=1||napi_get_typedarray_info(env,a[0],&type,&length,&pointer,&backing,&byteOffset)!=napi_ok||type!=napi_uint8_array||byteOffset%8||length%8||length>67108864)return Fail(env,"Expected aligned GL command bytes");
  auto data=(const uint8_t*)pointer;
  if(gpuThread){GPUJob job;job.bytes.assign(data,data+length);if(!QueueGPU(std::move(job)))return Fail(env,"Cannot queue GPU commands");}
  else if(!RunCommands(data,length))return Fail(env,"Invalid GL command payload");
  return Number(env,0);
}
static napi_value FenceAfterDraw(napi_env env,napi_callback_info info) {
  if(!getProc)return Fail(env,"ANGLE is not loaded");
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);int count=1;
  if(argc&&(napi_get_value_int32(env,args[0],&count)!=napi_ok||count<1||count>32))return Fail(env,"Fence batch must be 1–32");
  if(gpuThread)return DeferredFences(env,count);
  auto display=Proc<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();
  auto create=Proc<PFNEGLCREATESYNCKHRPROC>("eglCreateSyncKHR");
  const EGLint attrs[]={EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_LO_ANGLE,1,EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_HI_ANGLE,0,EGL_NONE};
  EGLSyncKHR sync=create(display,EGL_SYNC_METAL_SHARED_EVENT_ANGLE,attrs);
  if(sync==EGL_NO_SYNC_KHR)return Fail(env,"Cannot create GPU completion fence");
  auto copy=Proc<PFNEGLCOPYMETALSHAREDEVENTANGLEPROC>("eglCopyMetalSharedEventANGLE");
  void* event=copy(display,sync);
  Proc<PFNEGLDESTROYSYNCKHRPROC>("eglDestroySyncKHR")(display,sync);
  if(!event)return Fail(env,"Cannot export Metal completion event");
  Fence fence{event,(void*)1,(void*)WaitMetal,(void*)ReleaseMetal};
  Proc<PFNGLFLUSHPROC>("glFlush")();
  napi_value out;
  if(count==1)napi_create_buffer_copy(env,sizeof(fence),&fence,nullptr,&out);
  else{napi_create_array_with_length(env,count,&out);for(int i=0;i<count;i++){[(id<MTLSharedEvent>)event retain];napi_value item;napi_create_buffer_copy(env,sizeof(fence),&fence,nullptr,&item);napi_set_element(env,out,i,item);}[(id<MTLSharedEvent>)event release];}
  return out;
}
static napi_value Load(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value a[1];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);
  size_t size=0;napi_get_value_string_utf8(env,a[0],nullptr,0,&size);std::vector<char> path(size+1);napi_get_value_string_utf8(env,a[0],path.data(),path.size(),&size);
  library=dlopen(path.data(),RTLD_NOW|RTLD_LOCAL);if(!library)return Fail(env,dlerror());
  getProc=(PFNEGLGETPROCADDRESSPROC)dlsym(library,"eglGetProcAddress");if(!getProc)return Fail(env,"ANGLE entry points unavailable");
  return Number(env,1);
}
static napi_value Create(napi_env env,napi_callback_info info) {
  size_t argc=5;napi_value a[5];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);if((argc!=4&&argc!=5)||!getProc)return Fail(env,"Expected width,height,yFramebuffer,uvFramebuffer[,packed] after load");
  bool packed=false;if(argc==5&&napi_get_value_bool(env,a[4],&packed)!=napi_ok)return Fail(env,"Invalid surface packing flag");
  int w,h;GLuint fb[2];napi_get_value_int32(env,a[0],&w);napi_get_value_int32(env,a[1],&h);napi_get_value_uint32(env,a[2],&fb[0]);napi_get_value_uint32(env,a[3],&fb[1]);
  if(w<=0||h<=0||(w&1)||(h&1))return Fail(env,"Invalid NV12 size");
  if(packed&&(w%4||fb[0]!=fb[1]))return Fail(env,"Packed NV12 requires width divisible by four and one MRT framebuffer");
  auto getDisplay=Proc<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay");auto getConfigs=Proc<PFNEGLGETCONFIGSPROC>("eglGetConfigs");auto getConfig=Proc<PFNEGLGETCONFIGATTRIBPROC>("eglGetConfigAttrib");auto create=Proc<PFNEGLCREATEPBUFFERFROMCLIENTBUFFERPROC>("eglCreatePbufferFromClientBuffer");auto bind=Proc<PFNEGLBINDTEXIMAGEPROC>("eglBindTexImage");
  auto gen=Proc<PFNGLGENTEXTURESPROC>("glGenTextures");auto bindTex=Proc<PFNGLBINDTEXTUREPROC>("glBindTexture");auto param=Proc<PFNGLTEXPARAMETERIPROC>("glTexParameteri");auto bindFB=Proc<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer");auto attach=Proc<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D");auto check=Proc<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus");auto getInt=Proc<PFNGLGETINTEGERVPROC>("glGetIntegerv");
  auto s=new Surface;s->display=getDisplay();if(s->display==EGL_NO_DISPLAY){delete s;return Fail(env,"No current native ANGLE context");}
  EGLint count=0;getConfigs(s->display,nullptr,0,&count);std::vector<EGLConfig>configs(count);getConfigs(s->display,configs.data(),count,&count);EGLConfig config=nullptr;EGLint target=0;
  for(auto candidate:configs){EGLint value=0;if(getConfig(s->display,candidate,EGL_BIND_TO_TEXTURE_TARGET_ANGLE,&value)&&value){config=candidate;target=value;break;}}
  if(!config){delete s;return Fail(env,"ANGLE does not expose IOSurface texture import");}
  s->target=target==EGL_TEXTURE_2D?GL_TEXTURE_2D:0x84F5;
  if(packed){s->owned=PackedNV12Surface(w,h);if(!s->owned){delete s;return Fail(env,"Cannot allocate packed NV12 surface");}}
  else{
    CFMutableDictionaryRef attributes=CFDictionaryCreateMutable(nullptr,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);CFDictionaryRef properties=CFDictionaryCreate(nullptr,nullptr,nullptr,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);CFDictionarySetValue(attributes,kCVPixelBufferIOSurfacePropertiesKey,properties);CFRelease(properties);
    CVReturn result=CVPixelBufferCreate(nullptr,w,h,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,attributes,&s->pixel);CFRelease(attributes);if(result!=kCVReturnSuccess){delete s;return Fail(env,"Cannot allocate NV12 IOSurface");}
  }
  IOSurfaceRef surface=s->owned?s->owned:CVPixelBufferGetIOSurface(s->pixel);GLint previousRead=0,previousDraw=0,previousTexture=0;getInt(GL_READ_FRAMEBUFFER_BINDING,&previousRead);getInt(GL_DRAW_FRAMEBUFFER_BINDING,&previousDraw);getInt(s->target==GL_TEXTURE_2D?GL_TEXTURE_BINDING_2D:0x84F6,&previousTexture);
  gen(2,s->textures);
  for(int i=0;i<2;i++) {
    const EGLint attrs[]={EGL_WIDTH,packed?w/4:(i?w/2:w),EGL_HEIGHT,packed?h:(i?h/2:h),EGL_IOSURFACE_PLANE_ANGLE,i,EGL_TEXTURE_TARGET,target,EGL_TEXTURE_FORMAT,EGL_TEXTURE_RGBA,EGL_TEXTURE_TYPE_ANGLE,GL_UNSIGNED_BYTE,EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,packed?GL_RGBA:(i?GL_RG:GL_RED),EGL_NONE};
    s->planes[i]=create(s->display,EGL_IOSURFACE_ANGLE,(EGLClientBuffer)surface,config,attrs);if(s->planes[i]==EGL_NO_SURFACE)return Fail(env,"Cannot import NV12 IOSurface plane");
    bindTex(s->target,s->textures[i]);param(s->target,GL_TEXTURE_MIN_FILTER,GL_NEAREST);param(s->target,GL_TEXTURE_MAG_FILTER,GL_NEAREST);param(s->target,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);param(s->target,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
    if(!bind(s->display,s->planes[i],EGL_BACK_BUFFER))return Fail(env,"Cannot bind IOSurface plane texture");
    bindFB(GL_FRAMEBUFFER,fb[i]);attach(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0+(packed?i:0),s->target,s->textures[i],0);if(check(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)return Fail(env,"IOSurface framebuffer is incomplete");
  }
  if(packed){const GLenum attachments[]={GL_COLOR_ATTACHMENT0,GL_COLOR_ATTACHMENT1};Proc<PFNGLDRAWBUFFERSPROC>("glDrawBuffers")(2,attachments);if(check(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)return Fail(env,"Packed NV12 MRT framebuffer is incomplete");}
  bindTex(s->target,previousTexture);bindFB(GL_READ_FRAMEBUFFER,previousRead);bindFB(GL_DRAW_FRAMEBUFFER,previousDraw);
  surfaces.push_back(s);napi_value out,handle;napi_create_object(env,&out);napi_create_buffer_copy(env,sizeof(surface),&surface,nullptr,&handle);napi_set_named_property(env,out,"handle",handle);napi_set_named_property(env,out,"id",Number(env,(int)surfaces.size()-1));return out;
}
static napi_value Close(napi_env env,napi_callback_info) {
  if(!StopGPU())return Fail(env,"Cannot stop GPU command thread");
  if(getProc){auto release=Proc<PFNEGLRELEASETEXIMAGEPROC>("eglReleaseTexImage");auto destroy=Proc<PFNEGLDESTROYSURFACEPROC>("eglDestroySurface");auto del=Proc<PFNGLDELETETEXTURESPROC>("glDeleteTextures");for(auto s:surfaces){for(auto plane:s->planes)if(plane!=EGL_NO_SURFACE){release(s->display,plane,EGL_BACK_BUFFER);destroy(s->display,plane);}del(2,s->textures);if(s->pixel)CVPixelBufferRelease(s->pixel);if(s->owned)CFRelease(s->owned);delete s;}surfaces.clear();}
  return Number(env,0);
}
static napi_value Init(napi_env env,napi_value exports){for(auto item:{std::pair<const char*,napi_callback>{"load",Load},{"create",Create},{"fence",FenceAfterDraw},{"execute",Execute},{"startThread",StartThread},{"barrier",Barrier},{"threadStats",ThreadStats},{"probeMetalInterop",ProbeMetalInterop},{"configureImplicitResolve",ConfigureImplicitResolve},{"invalidateBufferShadows",InvalidateBufferShadows},{"close",Close}}){napi_value fn;napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,nullptr,&fn);napi_set_named_property(env,exports,item.first,fn);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
