#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <node_api.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>
#include <stdexcept>
#include <string>
#include <array>
#include <cmath>
using Microsoft::WRL::ComPtr;
static PFNEGLGETPROCADDRESSPROC proc;
template<class T> static T P(const char* name) { auto result=reinterpret_cast<T>(proc(name));if(!result)throw std::runtime_error(std::string("Missing ANGLE function: ")+name);return result; }
static void Check(bool ok,const char* text){if(!ok)throw std::runtime_error(text);}
static void Set(napi_env env,napi_value object,const char*key,napi_value value){napi_set_named_property(env,object,key,value);}
static napi_value Text(napi_env env,const std::string&text){napi_value out;napi_create_string_utf8(env,text.c_str(),text.size(),&out);return out;}
static napi_value Number(napi_env env,int value){napi_value out;napi_create_int32(env,value,&out);return out;}
#include "windows-nvenc-probe.inc"
static napi_value Probe(napi_env env,napi_callback_info info){
  try{
    size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);void*pointer=nullptr;
    Check(argc==1&&napi_get_value_external(env,args[0],&pointer)==napi_ok&&pointer,"Expected ANGLE procedure pointer");proc=reinterpret_cast<PFNEGLGETPROCADDRESSPROC>(pointer);
    auto display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();auto context=P<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")();
    Check(display!=EGL_NO_DISPLAY&&context!=EGL_NO_CONTEXT,"No current native ANGLE context");
    EGLAttrib deviceValue=0;Check(P<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&deviceValue),"Cannot query EGL device");
    EGLAttrib d3dValue=0;Check(P<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)deviceValue,EGL_D3D11_DEVICE_ANGLE,&d3dValue),"Cannot query ANGLE D3D11 device");
    auto device=reinterpret_cast<ID3D11Device*>(d3dValue);Check(device,"ANGLE returned no D3D11 device");
    ComPtr<IDXGIDevice>dxgi;Check(SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&dxgi))),"Cannot query DXGI device");ComPtr<IDXGIAdapter>adapter;dxgi->GetAdapter(&adapter);DXGI_ADAPTER_DESC description{};adapter->GetDesc(&description);
    char name[256]{};WideCharToMultiByte(CP_UTF8,0,description.Description,-1,name,sizeof(name),nullptr,nullptr);
    D3D11_TEXTURE2D_DESC desc{};desc.Width=desc.Height=256;desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_DEFAULT;desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;desc.MiscFlags=D3D11_RESOURCE_MISC_SHARED;
    ComPtr<ID3D11Texture2D>texture;Check(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&texture)),"Cannot create shared BGRA texture");
    const EGLint configAttrs[]={EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_BIND_TO_TEXTURE_RGBA,EGL_TRUE,EGL_NONE};
    EGLConfig config=nullptr;EGLint count=0;Check(P<PFNEGLCHOOSECONFIGPROC>("eglChooseConfig")(display,configAttrs,&config,1,&count)&&count==1,"Cannot choose shared-texture config");
    const EGLint attrs[]={EGL_WIDTH,256,EGL_HEIGHT,256,EGL_TEXTURE_FORMAT,EGL_TEXTURE_RGBA,EGL_TEXTURE_TARGET,EGL_TEXTURE_2D,EGL_NONE};
    auto surface=P<PFNEGLCREATEPBUFFERFROMCLIENTBUFFERPROC>("eglCreatePbufferFromClientBuffer")(display,EGL_D3D_TEXTURE_ANGLE,(EGLClientBuffer)texture.Get(),config,attrs);Check(surface!=EGL_NO_SURFACE,"Cannot import D3D11 texture into ANGLE");
    struct Restore{EGLDisplay display;EGLContext context;EGLSurface draw,read,surface;GLint drawFbo,readFbo;GLfloat color[4];~Restore(){P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_DRAW_FRAMEBUFFER,drawFbo);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_READ_FRAMEBUFFER,readFbo);P<PFNGLCLEARCOLORPROC>("glClearColor")(color[0],color[1],color[2],color[3]);P<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,draw,read,context);P<PFNEGLDESTROYSURFACEPROC>("eglDestroySurface")(display,surface);}}restore{display,context,P<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_DRAW),P<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_READ),surface};
    P<PFNGLGETINTEGERVPROC>("glGetIntegerv")(GL_DRAW_FRAMEBUFFER_BINDING,&restore.drawFbo);P<PFNGLGETINTEGERVPROC>("glGetIntegerv")(GL_READ_FRAMEBUFFER_BINDING,&restore.readFbo);P<PFNGLGETFLOATVPROC>("glGetFloatv")(GL_COLOR_CLEAR_VALUE,restore.color);
    Check(P<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,surface,surface,context),"Cannot bind imported D3D texture");
    P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,0);P<PFNGLCLEARCOLORPROC>("glClearColor")(.25f,.5f,.75f,1.f);P<PFNGLCLEARPROC>("glClear")(GL_COLOR_BUFFER_BIT);P<PFNGLFINISHPROC>("glFinish")();
    Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"GL error while drawing shared texture");
    D3D11_TEXTURE2D_DESC stagingDesc=desc;stagingDesc.Usage=D3D11_USAGE_STAGING;stagingDesc.BindFlags=stagingDesc.MiscFlags=0;stagingDesc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D>staging;Check(SUCCEEDED(device->CreateTexture2D(&stagingDesc,nullptr,&staging)),"Cannot create probe readback");ComPtr<ID3D11DeviceContext>immediate;device->GetImmediateContext(&immediate);immediate->CopyResource(staging.Get(),texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};Check(SUCCEEDED(immediate->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped)),"Cannot read back shared texture");
    auto data=(const unsigned char*)mapped.pData;std::array<int,4>pixel{data[0],data[1],data[2],data[3]};immediate->Unmap(staging.Get(),0);
    Check(std::abs(pixel[0]-191)<=1&&std::abs(pixel[1]-128)<=1&&std::abs(pixel[2]-64)<=1&&pixel[3]==255,"Shared D3D11 texture has incorrect pixels");
    const auto encoded=EncodeProbeTexture(device,texture.Get());
    napi_value result,channels,video;napi_create_object(env,&result);napi_create_array_with_length(env,4,&channels);for(int i=0;i<4;i++)napi_set_element(env,channels,i,Number(env,pixel[i]));Set(env,result,"adapter",Text(env,name));Set(env,result,"bgra",channels);Set(env,result,"status",Text(env,"ANGLE shared D3D11 texture: known-color readback and native NVENC H264 passed"));napi_create_buffer_copy(env,encoded.size(),encoded.data(),nullptr,&video);Set(env,result,"h264",video);return result;
  }catch(const std::exception&error){napi_throw_error(env,nullptr,error.what());return nullptr;}
}
NAPI_MODULE_INIT(){napi_value fn;napi_create_function(env,"probe",NAPI_AUTO_LENGTH,Probe,nullptr,&fn);napi_set_named_property(env,exports,"probe",fn);return exports;}
