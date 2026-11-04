#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_4.h>
#include <d3d12.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <node_api.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <stdexcept>
#include <string>
#include <cstdio>
#include <cstring>
#include <cstdlib>
using Microsoft::WRL::ComPtr;
static PFNEGLGETPROCADDRESSPROC proc;
template<class T>static T P(const char*name){auto p=reinterpret_cast<T>(proc(name));if(!p)throw std::runtime_error(std::string("Missing ANGLE function: ")+name);return p;}
static void HR(HRESULT h,const char*where){if(FAILED(h)){char hex[32];sprintf_s(hex,"0x%08lx",(unsigned long)h);throw std::runtime_error(std::string(where)+": "+hex);}}
static void Check(bool ok,const char*where){if(!ok)throw std::runtime_error(where);}
struct Handle{HANDLE h=nullptr;~Handle(){if(h)CloseHandle(h);}};
struct QueueDrain{
  ID3D12CommandQueue*queue;ID3D12Fence*fence;HANDLE event;bool submitted=false;
  ~QueueDrain(){if(submitted&&SUCCEEDED(queue->Signal(fence,2))&&SUCCEEDED(fence->SetEventOnCompletion(2,event)))WaitForSingleObject(event,10000);}
};
static napi_value Text(napi_env e,const std::string&s){napi_value v;napi_create_string_utf8(e,s.c_str(),s.size(),&v);return v;}
static void Set(napi_env e,napi_value o,const char*k,napi_value v){napi_set_named_property(e,o,k,v);}
static void Bool(napi_env e,napi_value o,const char*k,bool v){napi_value b;napi_get_boolean(e,v,&b);Set(e,o,k,b);}
#include "windows-d3d12-nvenc-probe.inc"
#include "windows-compute-probe.inc"
#include "windows-nv12-compute.inc"
#include "windows-compute-state.inc"
#include "windows-compute-convert-probe.inc"
struct GLRestore{
  GLint draw,read,texture;GLfloat clear[4];GLboolean mask[4],scissor;
  GLRestore(){auto get=P<PFNGLGETINTEGERVPROC>("glGetIntegerv");get(GL_DRAW_FRAMEBUFFER_BINDING,&draw);get(GL_READ_FRAMEBUFFER_BINDING,&read);get(GL_TEXTURE_BINDING_2D,&texture);P<PFNGLGETFLOATVPROC>("glGetFloatv")(GL_COLOR_CLEAR_VALUE,clear);P<PFNGLGETBOOLEANVPROC>("glGetBooleanv")(GL_COLOR_WRITEMASK,mask);scissor=P<PFNGLISENABLEDPROC>("glIsEnabled")(GL_SCISSOR_TEST);}
  ~GLRestore(){P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_DRAW_FRAMEBUFFER,draw);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_READ_FRAMEBUFFER,read);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,texture);P<PFNGLCLEARCOLORPROC>("glClearColor")(clear[0],clear[1],clear[2],clear[3]);P<PFNGLCOLORMASKPROC>("glColorMask")(mask[0],mask[1],mask[2],mask[3]);if(scissor)P<PFNGLENABLEPROC>("glEnable")(GL_SCISSOR_TEST);else P<PFNGLDISABLEPROC>("glDisable")(GL_SCISSOR_TEST);}
};
struct Image{
  EGLDisplay display;EGLImageKHR image=EGL_NO_IMAGE_KHR;GLuint texture=0,fbo=0;
  Image(EGLDisplay d):display(d){}
  ~Image(){if(fbo)P<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&fbo);if(texture)P<PFNGLDELETETEXTURESPROC>("glDeleteTextures")(1,&texture);if(image!=EGL_NO_IMAGE_KHR)P<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR")(display,image);}
};
static napi_value Test(napi_env env,ID3D11Device*device11,ID3D12Device*device12,EGLDisplay display,bool nv12){
  napi_value result;napi_create_object(env,&result);Set(env,result,"format",Text(env,nv12?"NV12":"BGRA"));
  try{
    D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;
    D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;desc.Width=desc.Height=256;desc.DepthOrArraySize=desc.MipLevels=1;desc.Format=nv12?DXGI_FORMAT_NV12:DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_UNKNOWN;desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
    ComPtr<ID3D12Resource>texture12;HR(device12->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&texture12)),"Create committed D3D12 texture");
    Handle resourceHandle;HR(device12->CreateSharedHandle(texture12.Get(),nullptr,GENERIC_ALL,nullptr,&resourceHandle.h),"Share D3D12 texture");
    ComPtr<ID3D11Device1>device1;HR(device11->QueryInterface(IID_PPV_ARGS(&device1)),"D3D11.1 device");
    ComPtr<ID3D11Texture2D>texture11;HR(device1->OpenSharedResource1(resourceHandle.h,IID_PPV_ARGS(&texture11)),"Open D3D12 texture in ANGLE's D3D11 device");
    D3D11_TEXTURE2D_DESC reflected{};texture11->GetDesc(&reflected);Check(reflected.Width==256&&reflected.Height==256&&reflected.Format==desc.Format,"Shared texture description changed");
    GLRestore restore;Image y(display),uv(display);
    auto request=reinterpret_cast<void(GL_APIENTRYP)(const char*)>(proc("glRequestExtensionANGLE"));if(request){request("GL_OES_EGL_image");request("GL_EXT_texture_format_BGRA8888");}
    for(int plane=0;plane<(nv12?2:1);plane++){
      auto&image=plane?uv:y;const EGLint attrs[]={EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,nv12?(plane?GL_RG_EXT:GL_RED_EXT):GL_BGRA_EXT,EGL_D3D11_TEXTURE_PLANE_ANGLE,plane,EGL_NONE};
      image.image=P<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR")(display,EGL_NO_CONTEXT,EGL_D3D11_TEXTURE_ANGLE,(EGLClientBuffer)texture11.Get(),attrs);Check(image.image!=EGL_NO_IMAGE_KHR,"Import shared D3D12 texture plane into ANGLE");
      P<PFNGLGENTEXTURESPROC>("glGenTextures")(1,&image.texture);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,image.texture);
      using BindImage=void(GL_APIENTRYP)(GLenum,void*);P<BindImage>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,image.image);
      P<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&image.fbo);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,image.fbo);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,image.texture,0);Check(P<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"Shared plane framebuffer incomplete");
      P<PFNGLDISABLEPROC>("glDisable")(GL_SCISSOR_TEST);P<PFNGLCOLORMASKPROC>("glColorMask")(TRUE,TRUE,TRUE,TRUE);P<PFNGLCLEARCOLORPROC>("glClearColor")(plane?.5f:.25f,plane?.75f:.5f,.75f,1.f);P<PFNGLCLEARPROC>("glClear")(GL_COLOR_BUFFER_BIT);
    }
    P<PFNGLFLUSHPROC>("glFlush")();Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"Shared-plane GL error");
    ComPtr<ID3D11Device5>device5;HR(device11->QueryInterface(IID_PPV_ARGS(&device5)),"D3D11.4 device");ComPtr<ID3D11Fence>fence11;HR(device5->CreateFence(0,D3D11_FENCE_FLAG_SHARED,IID_PPV_ARGS(&fence11)),"Create shared D3D11 fence");
    Handle fenceHandle;HR(fence11->CreateSharedHandle(nullptr,GENERIC_ALL,nullptr,&fenceHandle.h),"Share D3D11 fence");ComPtr<ID3D12Fence>fence12;HR(device12->OpenSharedHandle(fenceHandle.h,IID_PPV_ARGS(&fence12)),"Open D3D11 fence in D3D12");
    ComPtr<ID3D11DeviceContext>immediate;device11->GetImmediateContext(&immediate);ComPtr<ID3D11DeviceContext4>context4;HR(immediate.As(&context4),"D3D11.4 context");HR(context4->Signal(fence11.Get(),1),"Signal GL completion fence");immediate->Flush();
    D3D12_COMMAND_QUEUE_DESC queueDesc{};queueDesc.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;ComPtr<ID3D12CommandQueue>queue;HR(device12->CreateCommandQueue(&queueDesc,IID_PPV_ARGS(&queue)),"Create D3D12 queue");HR(queue->Wait(fence12.Get(),1),"Queue GPU wait for ANGLE");
    const UINT planes=nv12?2:1;D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprints[2]{};UINT rows[2]{};UINT64 rowSizes[2]{},bytes=0;device12->GetCopyableFootprints(&desc,0,planes,0,footprints,rows,rowSizes,&bytes);
    D3D12_HEAP_PROPERTIES readHeap{};readHeap.Type=D3D12_HEAP_TYPE_READBACK;D3D12_RESOURCE_DESC buffer{};buffer.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;buffer.Width=bytes;buffer.Height=buffer.DepthOrArraySize=buffer.MipLevels=1;buffer.SampleDesc.Count=1;buffer.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    ComPtr<ID3D12Resource>readback;HR(device12->CreateCommittedResource(&readHeap,D3D12_HEAP_FLAG_NONE,&buffer,D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&readback)),"Create D3D12 readback");
    ComPtr<ID3D12CommandAllocator>allocator;HR(device12->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&allocator)),"Create copy allocator");ComPtr<ID3D12GraphicsCommandList>list;HR(device12->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,allocator.Get(),nullptr,IID_PPV_ARGS(&list)),"Create copy list");
    D3D12_RESOURCE_BARRIER barrier{};barrier.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;barrier.Transition={texture12.Get(),D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE};list->ResourceBarrier(1,&barrier);
    for(UINT plane=0;plane<planes;plane++){D3D12_TEXTURE_COPY_LOCATION from{},to{};from.pResource=texture12.Get();from.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;from.SubresourceIndex=plane;to.pResource=readback.Get();to.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;to.PlacedFootprint=footprints[plane];list->CopyTextureRegion(&to,0,0,0,&from,nullptr);}
    barrier.Transition.StateBefore=D3D12_RESOURCE_STATE_COPY_SOURCE;barrier.Transition.StateAfter=D3D12_RESOURCE_STATE_COMMON;list->ResourceBarrier(1,&barrier);HR(list->Close(),"Close copy list");
    ComPtr<ID3D12Fence>done;HR(device12->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&done)),"Create copy completion fence");Handle event;event.h=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(event.h,"Create completion event");QueueDrain drain{queue.Get(),done.Get(),event.h};
    ID3D12CommandList*lists[]={list.Get()};queue->ExecuteCommandLists(1,lists);drain.submitted=true;HR(queue->Signal(done.Get(),1),"Signal copy completion");HR(done->SetEventOnCompletion(1,event.h),"Register copy completion");Check(WaitForSingleObject(event.h,10000)==WAIT_OBJECT_0,"D3D12 copy timed out");drain.submitted=false;
    void*data=nullptr;D3D12_RANGE range{0,(SIZE_T)bytes};HR(readback->Map(0,&range,&data),"Map D3D12 readback");napi_value pixels;napi_create_array_with_length(env,planes,&pixels);bool correct=true;
    for(UINT plane=0;plane<planes;plane++){
      auto p=(const unsigned char*)data+footprints[plane].Offset;napi_value values;napi_create_array_with_length(env,4,&values);
      for(int i=0;i<4;i++){napi_value n;napi_create_uint32(env,p[i],&n);napi_set_element(env,values,i,n);const int wanted=nv12?(plane?(i%2?191:128):64):(i==0?191:i==1?128:i==2?64:255);correct&=abs((int)p[i]-wanted)<=1;}
      napi_set_element(env,pixels,plane,values);
    }
    D3D12_RANGE written{0,0};readback->Unmap(0,&written);Check(correct,"D3D12 readback pixels differ from ANGLE writes");Set(env,result,"pixels",pixels);Bool(env,result,"gpuFenceInterop",true);
    const auto encoded=EncodeD3D12Probe(device12,texture12.Get(),fence12.Get(),1,nv12);napi_value video;napi_create_buffer_copy(env,encoded.size(),encoded.data(),nullptr,&video);Set(env,result,"h264",video);Bool(env,result,"nvencD3D12",true);Bool(env,result,"passed",true);
  }catch(const std::exception&error){Bool(env,result,"passed",false);Set(env,result,"error",Text(env,error.what()));}
  return result;
}
static napi_value Probe(napi_env env,napi_callback_info info){
  try{
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);void*p=nullptr;Check(n==1&&napi_get_value_external(env,args[0],&p)==napi_ok&&p,"Expected ANGLE procedure pointer");proc=(PFNEGLGETPROCADDRESSPROC)p;
    auto display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();EGLAttrib e=0,d=0;Check(P<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&e),"Query EGL device");Check(P<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)e,EGL_D3D11_DEVICE_ANGLE,&d),"Query ANGLE D3D11 device");
    auto device11=reinterpret_cast<ID3D11Device*>(d);ComPtr<IDXGIDevice>dxgi;HR(device11->QueryInterface(IID_PPV_ARGS(&dxgi)),"Query DXGI device");ComPtr<IDXGIAdapter>adapter;HR(dxgi->GetAdapter(&adapter),"Query adapter");ComPtr<ID3D12Device>device12;HR(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&device12)),"Create D3D12 device on ANGLE adapter");
    napi_value results;napi_create_array_with_length(env,2,&results);napi_set_element(env,results,0,Test(env,device11,device12.Get(),display,false));napi_set_element(env,results,1,Test(env,device11,device12.Get(),display,true));return results;
  }catch(const std::exception&error){napi_throw_error(env,nullptr,error.what());return nullptr;}
}
NAPI_MODULE_INIT(){napi_value fn;napi_create_function(env,"probe",NAPI_AUTO_LENGTH,Probe,nullptr,&fn);Set(env,exports,"probe",fn);napi_create_function(env,"computeNV12",NAPI_AUTO_LENGTH,ProbeComputeNV12,nullptr,&fn);Set(env,exports,"computeNV12",fn);napi_create_function(env,"convertNV12",NAPI_AUTO_LENGTH,ProbeConvertNV12,nullptr,&fn);Set(env,exports,"convertNV12",fn);return exports;}
