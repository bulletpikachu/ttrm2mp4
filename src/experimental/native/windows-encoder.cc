// D3D11/NVENC replay pipeline with a bounded asynchronous texture pool and
// a synchronous reference path. Completed bitstreams release texture ownership.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <node_api.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <nvEncodeAPI.h>
#include <memory>
#include <fstream>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#include <chrono>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <unordered_map>
#include <functional>
#include <d3d11_4.h>
#include <d3d12.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
using Microsoft::WRL::ComPtr;
using Clock=std::chrono::steady_clock;
static PFNEGLGETPROCADDRESSPROC proc;
template<class T>static T P(const char*name){auto f=reinterpret_cast<T>(proc(name));if(!f)throw std::runtime_error(std::string("Missing GL function: ")+name);return f;}
static void Check(bool condition,const char*message){if(!condition)throw std::runtime_error(message);}
static bool Enabled(const char*name){const char*value=getenv(name);return value&&value[0]=='1'&&value[1]=='\0';}
static void NVCheck(NVENCSTATUS result,const char*message){if(result!=NV_ENC_SUCCESS)throw std::runtime_error(std::string(message)+": NVENC "+std::to_string((int)result));}
static double Ms(Clock::time_point start){return std::chrono::duration<double,std::milli>(Clock::now()-start).count();}
template<class T>static T Proc(const char*name){return P<T>(name);}
struct BufferStorage{GLsizeiptr size;GLenum usage;std::vector<uint8_t>shadow;};
struct BufferContext{GLuint arrayBuffer=0;std::unordered_map<GLuint,BufferStorage>storage;};
static BufferContext*bufferContext=nullptr;static const bool orphanBuffers=false,shadowOrphan=false;
static void GL_APIENTRY OrphanBufferData(GLenum target,GLsizeiptr size,const void*data,GLenum usage){P<PFNGLBUFFERDATAPROC>("glBufferData")(target,size,data,usage);}
static void GL_APIENTRY OrphanBufferSubData(GLenum target,GLintptr offset,GLsizeiptr size,const void*data){P<PFNGLBUFFERSUBDATAPROC>("glBufferSubData")(target,offset,size,data);}
#include "gl-commands.inc"
static int64_t commandBatches=0,commandCount=0;
static void RunCommands(const uint8_t*data,size_t length){
  Check(((uintptr_t)data%8)==0,"Unaligned native GL command buffer");
  for(size_t cursor=0;cursor<length;){Check(length-cursor>=16,"Truncated native GL header");auto values=(const double*)(data+cursor);Check(std::isfinite(values[0])&&values[0]>=0&&values[0]<sizeof(CommandArgs)/sizeof(*CommandArgs)&&values[0]==std::floor(values[0])&&std::isfinite(values[1])&&values[1]>=0&&values[1]<=length&&values[1]==std::floor(values[1]),"Invalid native GL command header");size_t opcode=(size_t)values[0],end=(size_t)values[1],header=cursor+(CommandArgs[opcode]+2)*8;Check(end>=header&&end%8==0&&header<=length,"Invalid native GL command bounds");if(!ExecuteCommand(opcode,values+2,data,header,end)){std::string message=std::string("Invalid native GL payload: ")+CommandNames[opcode];for(size_t i=0;i<CommandArgs[opcode];i++)message+=" "+std::to_string(values[i+2]);throw std::runtime_error(message);}cursor=end;commandCount++;}commandBatches++;
}
struct GLState{
  bool restoreSurface=false;
  EGLDisplay display;EGLContext context;EGLSurface draw,read;
  GLint drawFbo,readFbo,program,vao,active,tex0,tex1,viewport[4];GLboolean mask[4];
  const GLenum caps[6]={GL_BLEND,GL_DEPTH_TEST,GL_STENCIL_TEST,GL_SCISSOR_TEST,GL_CULL_FACE,GL_RASTERIZER_DISCARD};GLboolean enabled[6];
  GLState(){
    display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();context=P<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")();draw=P<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_DRAW);read=P<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_READ);
    auto get=P<PFNGLGETINTEGERVPROC>("glGetIntegerv");get(GL_DRAW_FRAMEBUFFER_BINDING,&drawFbo);get(GL_READ_FRAMEBUFFER_BINDING,&readFbo);get(GL_CURRENT_PROGRAM,&program);get(GL_VERTEX_ARRAY_BINDING,&vao);get(GL_ACTIVE_TEXTURE,&active);get(GL_VIEWPORT,viewport);P<PFNGLGETBOOLEANVPROC>("glGetBooleanv")(GL_COLOR_WRITEMASK,mask);
    for(int i=0;i<6;i++)enabled[i]=P<PFNGLISENABLEDPROC>("glIsEnabled")(caps[i]);
    P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);get(GL_TEXTURE_BINDING_2D,&tex0);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE1);get(GL_TEXTURE_BINDING_2D,&tex1);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(active);
  }
  ~GLState(){
    if(restoreSurface)P<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,draw,read,context);
    P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_DRAW_FRAMEBUFFER,drawFbo);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_READ_FRAMEBUFFER,readFbo);
    P<PFNGLUSEPROGRAMPROC>("glUseProgram")(program);P<PFNGLBINDVERTEXARRAYPROC>("glBindVertexArray")(vao);
    P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,tex0);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE1);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,tex1);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(active);
    P<PFNGLVIEWPORTPROC>("glViewport")(viewport[0],viewport[1],viewport[2],viewport[3]);P<PFNGLCOLORMASKPROC>("glColorMask")(mask[0],mask[1],mask[2],mask[3]);
    for(int i=0;i<6;i++)if(enabled[i])P<PFNGLENABLEPROC>("glEnable")(caps[i]);else P<PFNGLDISABLEPROC>("glDisable")(caps[i]);
  }
};
#include "windows-gl-driver.inc"
struct VideoEncoder{
  const DWORD mainThread=GetCurrentThreadId();const uint64_t mainCPUStart=GLDriver::CPU();const Clock::time_point mainWallStart=Clock::now();
  const int mainPriorityBefore=GetThreadPriority(GetCurrentThread());
  int totalFrames=0,gpuBatch=1,gpuSubmissions=0,entropyMode=0;uint64_t bytes=0;double composeMs=0,finishMs=0,encodeMs=0,poolWaitMs=0,submitWaitMs=0,encodeEventMs=0,encodeSubmitMs=0,bitstreamMs=0;
  virtual ~VideoEncoder()=default;
  virtual void Open(const std::string&)=0;virtual void Compose(GLuint,GLuint,GLuint,GLuint)=0;virtual void Encode(bool,int64_t)=0;virtual int Close(bool flush=true)=0;virtual std::vector<uint8_t>Snapshot()=0;
};
struct Encoder:VideoEncoder{
  int width,height,fps,frames=0;EGLDisplay display=EGL_NO_DISPLAY;EGLSurface surface=EGL_NO_SURFACE;
  EGLImageKHR image=EGL_NO_IMAGE_KHR;GLuint colorTexture=0,framebuffer=0;
  ComPtr<ID3D11Device>device;ComPtr<ID3D11DeviceContext>immediate;ComPtr<ID3D11Texture2D>texture,staging;
  HMODULE library=nullptr;NV_ENCODE_API_FUNCTION_LIST api{};void*session=nullptr;NV_ENC_REGISTERED_PTR registered=nullptr;NV_ENC_INPUT_PTR input=nullptr;NV_ENC_OUTPUT_PTR output=nullptr;bool locked=false;
  std::ofstream file;
  Encoder(int w,int h,int rate):width(w),height(h),fps(rate){
    Check(!Enabled("REPLAY_WINDOWS_COMPUTE_INPLACE"),"In-place conversion requires asynchronous compute encoding");
    Check(!Enabled("REPLAY_WINDOWS_COMPUTE"),"Compute conversion requires asynchronous D3D12 NV12 encoding");
    Check(!Enabled("REPLAY_WINDOWS_D3D12"),"D3D12 encoding requires REPLAY_WINDOWS_ASYNC=1");
    display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();Check(display!=EGL_NO_DISPLAY,"No current native ANGLE display");
    EGLAttrib e=0,d=0;Check(P<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&e),"Query EGL device failed");Check(P<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)e,EGL_D3D11_DEVICE_ANGLE,&d),"Query D3D11 device failed");device=reinterpret_cast<ID3D11Device*>(d);Check(device.Get(),"No D3D11 device");device->GetImmediateContext(&immediate);
    D3D11_TEXTURE2D_DESC desc{};desc.Width=w;desc.Height=h;desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_DEFAULT;desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;desc.MiscFlags=D3D11_RESOURCE_MISC_SHARED;
    Check(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&texture)),"Create encoder texture failed");
    if(!Enabled("REPLAY_WINDOWS_PBUFFER")){
      // Same import/attachment path exercised by ANGLE's D3DTextureTest.
      GLState state;const EGLint attrs[]={EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,GL_BGRA_EXT,EGL_NONE};
      auto request=reinterpret_cast<void(GL_APIENTRYP)(const char*)>(proc("glRequestExtensionANGLE"));if(request){request("GL_OES_EGL_image");request("GL_EXT_texture_format_BGRA8888");}
      image=P<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR")(display,EGL_NO_CONTEXT,EGL_D3D11_TEXTURE_ANGLE,(EGLClientBuffer)texture.Get(),attrs);Check(image!=EGL_NO_IMAGE_KHR,"Import D3D encoder EGLImage failed");
      P<PFNGLGENTEXTURESPROC>("glGenTextures")(1,&colorTexture);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,colorTexture);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);P<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,image);
      auto imageError=P<PFNGLGETERRORPROC>("glGetError")();if(imageError!=GL_NO_ERROR)throw std::runtime_error("D3D EGLImage binding error: "+std::to_string(imageError));
      P<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&framebuffer);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,framebuffer);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,colorTexture,0);Check(P<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"D3D encoder framebuffer incomplete");
    }else{
    const EGLint configAttrs[]={EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_BIND_TO_TEXTURE_RGBA,EGL_TRUE,EGL_NONE};EGLConfig config;EGLint count=0;
    Check(P<PFNEGLCHOOSECONFIGPROC>("eglChooseConfig")(display,configAttrs,&config,1,&count)&&count==1,"Choose encoder EGL config failed");
    const EGLint attrs[]={EGL_WIDTH,w,EGL_HEIGHT,h,EGL_TEXTURE_FORMAT,EGL_TEXTURE_RGBA,EGL_TEXTURE_TARGET,EGL_TEXTURE_2D,EGL_NONE};
    surface=P<PFNEGLCREATEPBUFFERFROMCLIENTBUFFERPROC>("eglCreatePbufferFromClientBuffer")(display,EGL_D3D_TEXTURE_ANGLE,(EGLClientBuffer)texture.Get(),config,attrs);Check(surface!=EGL_NO_SURFACE,"Import encoder texture failed");
    }
    library=LoadLibraryExW(L"nvEncodeAPI64.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);Check(library,"NVENC driver unavailable");auto create=(decltype(&NvEncodeAPICreateInstance))GetProcAddress(library,"NvEncodeAPICreateInstance");Check(create,"NVENC API unavailable");api.version=NV_ENCODE_API_FUNCTION_LIST_VER;NVCheck(create(&api),"Create NVENC interface");
  }
  ~Encoder(){Close(false);if(framebuffer)P<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&framebuffer);if(colorTexture)P<PFNGLDELETETEXTURESPROC>("glDeleteTextures")(1,&colorTexture);if(image!=EGL_NO_IMAGE_KHR)P<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR")(display,image);if(surface!=EGL_NO_SURFACE)P<PFNEGLDESTROYSURFACEPROC>("eglDestroySurface")(display,surface);if(library)FreeLibrary(library);}
  void Open(const std::string&path){
    Check(!session,"Encoder segment already open");frames=0;file.open(std::filesystem::u8path(path),std::ios::binary|std::ios::trunc);Check(file.good(),"Cannot open native video segment");
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};open.version=NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;open.device=device.Get();open.deviceType=NV_ENC_DEVICE_TYPE_DIRECTX;open.apiVersion=NVENCAPI_VERSION;NVCheck(api.nvEncOpenEncodeSessionEx(&open,&session),"Open D3D11 NVENC session");
    NV_ENC_PRESET_CONFIG preset{};preset.version=NV_ENC_PRESET_CONFIG_VER;preset.presetCfg.version=NV_ENC_CONFIG_VER;NVCheck(api.nvEncGetEncodePresetConfigEx(session,NV_ENC_CODEC_H264_GUID,NV_ENC_PRESET_P1_GUID,NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,&preset),"Get hardware preset");
    NV_ENC_CONFIG config=preset.presetCfg;config.profileGUID=NV_ENC_H264_PROFILE_HIGH_GUID;config.gopLength=fps*2;config.frameIntervalP=1;config.rcParams.rateControlMode=NV_ENC_PARAMS_RC_CONSTQP;config.rcParams.constQP={18,18,18};
    if(Enabled("REPLAY_WINDOWS_CAVLC"))config.encodeCodecConfig.h264Config.entropyCodingMode=NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;entropyMode=(int)config.encodeCodecConfig.h264Config.entropyCodingMode;
    auto&vui=config.encodeCodecConfig.h264Config.h264VUIParameters;vui.videoSignalTypePresentFlag=1;vui.videoFormat=NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;vui.colourDescriptionPresentFlag=1;vui.colourPrimaries=NV_ENC_VUI_COLOR_PRIMARIES_BT709;vui.transferCharacteristics=NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SRGB;vui.colourMatrix=NV_ENC_VUI_MATRIX_COEFFS_SMPTE170M;
    NV_ENC_INITIALIZE_PARAMS init{};init.version=NV_ENC_INITIALIZE_PARAMS_VER;init.encodeGUID=NV_ENC_CODEC_H264_GUID;init.presetGUID=NV_ENC_PRESET_P1_GUID;init.tuningInfo=NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;init.encodeWidth=init.darWidth=init.maxEncodeWidth=width;init.encodeHeight=init.darHeight=init.maxEncodeHeight=height;init.frameRateNum=fps;init.frameRateDen=1;init.enablePTD=1;init.encodeConfig=&config;NVCheck(api.nvEncInitializeEncoder(session,&init),"Initialize H264 encoder");
    NV_ENC_CREATE_BITSTREAM_BUFFER buffer{};buffer.version=NV_ENC_CREATE_BITSTREAM_BUFFER_VER;NVCheck(api.nvEncCreateBitstreamBuffer(session,&buffer),"Create H264 buffer");output=buffer.bitstreamBuffer;
    NV_ENC_REGISTER_RESOURCE reg{};reg.version=NV_ENC_REGISTER_RESOURCE_VER;reg.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;reg.width=width;reg.height=height;reg.resourceToRegister=texture.Get();reg.bufferFormat=NV_ENC_BUFFER_FORMAT_ARGB;reg.bufferUsage=NV_ENC_INPUT_IMAGE;NVCheck(api.nvEncRegisterResource(session,&reg),"Register D3D texture");registered=reg.registeredResource;
  }
  void Compose(GLuint program,GLuint vao,GLuint game,GLuint header){
    const auto start=Clock::now();GLState state;
    if(surface!=EGL_NO_SURFACE){Check(P<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,surface,surface,state.context),"Bind encoder texture failed");state.restoreSurface=true;}
    P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,framebuffer);P<PFNGLVIEWPORTPROC>("glViewport")(0,0,width,height);for(auto cap:state.caps)P<PFNGLDISABLEPROC>("glDisable")(cap);P<PFNGLCOLORMASKPROC>("glColorMask")(true,true,true,true);
    P<PFNGLUSEPROGRAMPROC>("glUseProgram")(program);P<PFNGLBINDVERTEXARRAYPROC>("glBindVertexArray")(vao);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,game);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE1);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,header);P<PFNGLDRAWARRAYSPROC>("glDrawArrays")(GL_TRIANGLES,0,3);
    const auto wait=Clock::now();P<PFNGLFINISHPROC>("glFinish")();finishMs+=Ms(wait);Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"GL error during native composition");composeMs+=Ms(start);
  }
  void Encode(bool key,int64_t index){
    Check(session,"No encoder segment");const auto start=Clock::now();NV_ENC_MAP_INPUT_RESOURCE map{};map.version=NV_ENC_MAP_INPUT_RESOURCE_VER;map.registeredResource=registered;NVCheck(api.nvEncMapInputResource(session,&map),"Map D3D texture");input=map.mappedResource;
    NV_ENC_PIC_PARAMS pic{};pic.version=NV_ENC_PIC_PARAMS_VER;pic.inputBuffer=input;pic.bufferFmt=map.mappedBufferFmt;pic.inputWidth=width;pic.inputHeight=height;pic.outputBitstream=output;pic.pictureStruct=NV_ENC_PIC_STRUCT_FRAME;pic.inputTimeStamp=index;pic.inputDuration=1;if(key)pic.encodePicFlags=NV_ENC_PIC_FLAG_FORCEIDR|NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;NVCheck(api.nvEncEncodePicture(session,&pic),"Encode D3D frame");
    NV_ENC_LOCK_BITSTREAM lock{};lock.version=NV_ENC_LOCK_BITSTREAM_VER;lock.outputBitstream=output;NVCheck(api.nvEncLockBitstream(session,&lock),"Read encoded frame");locked=true;file.write((const char*)lock.bitstreamBufferPtr,lock.bitstreamSizeInBytes);bytes+=lock.bitstreamSizeInBytes;Check(file.good(),"Native segment write failed");NVCheck(api.nvEncUnlockBitstream(session,output),"Unlock encoded frame");locked=false;NVCheck(api.nvEncUnmapInputResource(session,input),"Unmap D3D frame");input=nullptr;frames++;totalFrames++;encodeMs+=Ms(start);
  }
  int Close(bool flush=true){
    const int result=frames;
    if(session){if(flush){NV_ENC_PIC_PARAMS eos{};eos.version=NV_ENC_PIC_PARAMS_VER;eos.encodePicFlags=NV_ENC_PIC_FLAG_EOS;NVCheck(api.nvEncEncodePicture(session,&eos),"Flush native encoder");}
      if(locked)api.nvEncUnlockBitstream(session,output);if(input)api.nvEncUnmapInputResource(session,input);if(output)api.nvEncDestroyBitstreamBuffer(session,output);if(registered)api.nvEncUnregisterResource(session,registered);api.nvEncDestroyEncoder(session);
      session=nullptr;input=nullptr;output=nullptr;registered=nullptr;locked=false;}
    if(file.is_open())file.close();return result;
  }
  std::vector<uint8_t> Snapshot(){
    if(!staging){D3D11_TEXTURE2D_DESC desc;texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=desc.MiscFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;Check(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&staging)),"Create image audit staging texture failed");}
    immediate->CopyResource(staging.Get(),texture.Get());D3D11_MAPPED_SUBRESOURCE map{};Check(SUCCEEDED(immediate->Map(staging.Get(),0,D3D11_MAP_READ,0,&map)),"Read image audit texture failed");std::vector<uint8_t>data((size_t)width*height*4);for(int y=0;y<height;y++)memcpy(data.data()+(size_t)y*width*4,(uint8_t*)map.pData+(size_t)y*map.RowPitch,(size_t)width*4);immediate->Unmap(staging.Get(),0);return data;
  }
};
#include "windows-nv12-compute.inc"
#include "windows-compute-state.inc"
#include "windows-async-encoder.inc"
static std::unique_ptr<VideoEncoder>encoder;
static int Int(napi_env e,napi_value v){int32_t n=0;Check(napi_get_value_int32(e,v,&n)==napi_ok,"Expected integer");return n;}
static napi_value Num(napi_env e,double n){napi_value out;napi_create_double(e,n,&out);return out;}
static std::string String(napi_env e,napi_value v){size_t n=0;Check(napi_get_value_string_utf8(e,v,nullptr,0,&n)==napi_ok,"Expected path");std::vector<char>s(n+1);napi_get_value_string_utf8(e,v,s.data(),s.size(),&n);return{s.data(),n};}
template<class F>static napi_value Call(napi_env e,F f){try{return f();}catch(const std::exception&error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
static napi_value RequestHighQoS(napi_env e,napi_callback_info){return Call(e,[&]{
  // Used only in an explicitly selected, short-lived export renderer process.
  // Windows 10 accepts SetProcessInformation but cannot report the old state.
  PROCESS_POWER_THROTTLING_STATE power{};power.Version=PROCESS_POWER_THROTTLING_CURRENT_VERSION;
  const BOOL known=GetProcessInformation(GetCurrentProcess(),ProcessPowerThrottling,&power,sizeof(power));
  const DWORD queryError=known?0:GetLastError();Check(known||queryError==ERROR_INVALID_PARAMETER,"Cannot query renderer power policy");
  if(!known){power={};power.Version=PROCESS_POWER_THROTTLING_CURRENT_VERSION;}
  power.ControlMask|=PROCESS_POWER_THROTTLING_EXECUTION_SPEED;power.StateMask&=~PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
  Check(SetProcessInformation(GetCurrentProcess(),ProcessPowerThrottling,&power,sizeof(power)),"Cannot request renderer performance QoS");
  napi_value out;napi_create_object(e,&out);
  for(const auto&item:{std::pair<const char*,double>{"queryError",(double)queryError},{"requestedControlMask",power.ControlMask},{"requestedStateMask",power.StateMask},{"processPriorityClass",GetPriorityClass(GetCurrentProcess())}})napi_set_named_property(e,out,item.first,Num(e,item.second));
  return out;
});}
static napi_value Initialize(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=4;napi_value a[4];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);void*p=nullptr;Check(n==4&&napi_get_value_external(e,a[0],&p)==napi_ok&&p,"Expected EGL pointer and dimensions");Check(!encoder,"Encoder is already initialized");proc=(PFNEGLGETPROCADDRESSPROC)p;const int w=Int(e,a[1]),h=Int(e,a[2]),fps=Int(e,a[3]);Check(w>=256&&h>=256&&w<=3840&&h<=2160&&!(w%2)&&!(h%2)&&fps>=1&&fps<=60,"Invalid native video dimensions/rate");if(Enabled("REPLAY_WINDOWS_ASYNC"))encoder=std::make_unique<AsyncEncoder>(w,h,fps);else encoder=std::make_unique<Encoder>(w,h,fps);return Num(e,0);});}
static napi_value ConfigureCompute(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=3;napi_value a[3];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);auto async=dynamic_cast<AsyncEncoder*>(encoder.get());Check(async&&async->computeConversion&&(n==1||n==3),"Compute encoder is not initialized");Check(GetCurrentThreadId()==async->mainThread&&!async->session&&!async->computeHeaderHeight,"Compute header must be configured once before opening a segment");const int h=Int(e,a[0]);Check(h>0&&h<=async->height,"Invalid compute header height");if(async->computeInPlace)Check(n==3&&Int(e,a[1])>0&&Int(e,a[2])>0,"In-place conversion requires source texture IDs");async->computeHeaderHeight=h;if(async->computeInPlace){driver.Pause();async->ConfigureComputeSource(Int(e,a[1]),Int(e,a[2]));}return Num(e,0);});}
static napi_value Open(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=1;napi_value a[1];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);Check(encoder&&n==1,"Encoder is not initialized");encoder->Open(String(e,a[0]));return Num(e,0);});}
static napi_value Compose(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=4;napi_value a[4];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);Check(encoder&&n==4,"Encoder is not initialized");encoder->Compose(Int(e,a[0]),Int(e,a[1]),Int(e,a[2]),Int(e,a[3]));return Num(e,0);});}
static napi_value Encode(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=2;napi_value a[2];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);Check(encoder&&n==2,"Encoder is not initialized");bool key=false;Check(napi_get_value_bool(e,a[0],&key)==napi_ok,"Expected keyframe flag");encoder->Encode(key,Int(e,a[1]));return Num(e,0);});}
static napi_value Close(napi_env e,napi_callback_info){return Call(e,[&]{return Num(e,encoder?encoder->Close():0);});}
static napi_value Snapshot(napi_env e,napi_callback_info){return Call(e,[&]{Check((bool)encoder,"Encoder is not initialized");auto data=encoder->Snapshot();napi_value out;napi_create_buffer_copy(e,data.size(),data.data(),nullptr,&out);return out;});}
static napi_value Stats(napi_env e,napi_callback_info){return Call(e,[&]{
  Check((bool)encoder,"Encoder is not initialized");Check(GetCurrentThreadId()==encoder->mainThread,"Encoder statistics must be read by the owning thread");
  napi_value out;napi_create_object(e,&out);
  auto async=dynamic_cast<AsyncEncoder*>(encoder.get());napi_set_named_property(e,out,"d3d12",Num(e,async&&async->d3d12?1:0));
  napi_set_named_property(e,out,"computeConversion",Num(e,async&&async->computeConversion?1:0));if(async){napi_set_named_property(e,out,"computeMs",Num(e,async->computeMs));napi_set_named_property(e,out,"computeSubmissions",Num(e,async->computeCounter));napi_set_named_property(e,out,"computeFrames",Num(e,async->computeFrames));}
  napi_set_named_property(e,out,"computeInPlace",Num(e,async&&async->computeInPlace?1:0));
  if(async){napi_set_named_property(e,out,"pendingLimit",Num(e,async->pendingLimit));napi_set_named_property(e,out,"surfaces",Num(e,async->slots.size()));napi_set_named_property(e,out,"pendingHighWater",Num(e,async->pendingHighWater));napi_set_named_property(e,out,"earlyDrains",Num(e,async->earlyDrains));}
  PROCESS_POWER_THROTTLING_STATE power{};power.Version=PROCESS_POWER_THROTTLING_CURRENT_VERSION;
  const BOOL powerKnown=GetProcessInformation(GetCurrentProcess(),ProcessPowerThrottling,&power,sizeof(power));
  napi_set_named_property(e,out,"powerQueryError",Num(e,powerKnown?0:GetLastError()));
  if(powerKnown){napi_set_named_property(e,out,"powerControlMask",Num(e,power.ControlMask));napi_set_named_property(e,out,"powerStateMask",Num(e,power.StateMask));}
  for(auto item:{std::pair<const char*,double>{"frames",encoder->totalFrames},{"bytes",(double)encoder->bytes},{"composeMs",encoder->composeMs},{"finishMs",encoder->finishMs},{"encodeMs",encoder->encodeMs},{"poolWaitMs",encoder->poolWaitMs},{"submitWaitMs",encoder->submitWaitMs},{"encodeEventMs",encoder->encodeEventMs},{"encodeSubmitMs",encoder->encodeSubmitMs},{"bitstreamMs",encoder->bitstreamMs},{"gpuBatch",encoder->gpuBatch},{"gpuSubmissions",encoder->gpuSubmissions},{"entropyMode",encoder->entropyMode},{"mainThreadCpuMs",(GLDriver::CPU()-encoder->mainCPUStart)/10000.0},{"mainThreadWallMs",Ms(encoder->mainWallStart)},{"mainThreadPriorityBefore",encoder->mainPriorityBefore},{"mainThreadPriority",GetThreadPriority(GetCurrentThread())},{"processPriorityClass",GetPriorityClass(GetCurrentProcess())}})napi_set_named_property(e,out,item.first,Num(e,item.second));
  return out;
});}
static napi_value Shutdown(napi_env e,napi_callback_info){return Call(e,[&]{if(encoder)Check(GetCurrentThreadId()==encoder->mainThread,"Encoder shutdown must run on its owning thread");driver.Stop();encoder.reset();return Num(e,0);});}
static napi_value Load(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=1;napi_value a[1];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);void*p=nullptr;Check(n==1&&napi_get_value_external(e,a[0],&p)==napi_ok&&p,"Expected native EGL pointer");proc=(PFNEGLGETPROCADDRESSPROC)p;return Num(e,0);});}
static napi_value Execute(napi_env e,napi_callback_info i){return Call(e,[&]{size_t n=1;napi_value a[1];napi_get_cb_info(e,i,&n,a,nullptr,nullptr);napi_typedarray_type type;size_t length,offset;void*data;napi_value backing;Check(n==1&&napi_get_typedarray_info(e,a[0],&type,&length,&data,&backing,&offset)==napi_ok&&type==napi_uint8_array&&length<=67108864,"Expected bounded GL command bytes");driver.Execute((const uint8_t*)data,length);return Num(e,0);});}
static napi_value Barrier(napi_env e,napi_callback_info){return Call(e,[&]{driver.Pause();return Num(e,0);});}
static napi_value StartThread(napi_env e,napi_callback_info){return Call(e,[&]{driver.Start();return Num(e,0);});}
static napi_value ThreadStats(napi_env e,napi_callback_info){return Call(e,[&]{driver.Pause();napi_value out,text;napi_create_object(e,&out);napi_create_string_utf8(e,driver.jobs?"asynchronous-command-driver":"synchronous-command-batching",NAPI_AUTO_LENGTH,&text);napi_set_named_property(e,out,"mode",text);for(auto item:{std::pair<const char*,double>{"batches",(double)commandBatches},{"commands",(double)commandCount},{"jobs",(double)driver.jobs},{"pauses",(double)driver.pauses},{"workMs",driver.workMs},{"cpuMs",driver.cpuMs}})napi_set_named_property(e,out,item.first,Num(e,item.second));return out;});}
NAPI_MODULE_INIT(){for(auto item:{std::pair<const char*,napi_callback>{"requestHighQoS",RequestHighQoS},{"initialize",Initialize},{"configureCompute",ConfigureCompute},{"open",Open},{"compose",Compose},{"encode",Encode},{"close",Close},{"snapshot",Snapshot},{"stats",Stats},{"shutdown",Shutdown},{"load",Load},{"execute",Execute},{"barrier",Barrier},{"threadStats",ThreadStats},{"startThread",StartThread}}){napi_value fn;napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,nullptr,&fn);napi_set_named_property(env,exports,item.first,fn);}return exports;}
