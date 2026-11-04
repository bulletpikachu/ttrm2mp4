// EGL_ANDROID_blob_cache callbacks run on arbitrary driver threads. Keep all
// work native, validate cached bytes before passing them back to ANGLE, and keep
// callback storage alive through EGL teardown. This caches shaders, never frames.
#include <windows.h>
#include <bcrypt.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <array>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <unordered_map>
#include <stdexcept>

namespace ReplayShaderCache {
using Bytes=std::vector<unsigned char>;
using Digest=std::array<unsigned char,32>;
using Clock=std::chrono::steady_clock;
constexpr size_t MaxValue=64*1024*1024,MaxKey=4096,MaxDisk=256*1024*1024;
struct State {
  std::filesystem::path root;
  std::string identity;
  BCRYPT_ALG_HANDLE algorithm=nullptr;
  std::mutex mutex;
  std::unordered_map<std::string,Bytes> memory;
  size_t memoryBytes=0,diskBytes=0;
  uint64_t lookups=0,hits=0,misses=0,writes=0,corrupt=0,ioErrors=0,bytesRead=0,bytesWritten=0,sequence=0;
  double callbackMs=0;
};
static State*state=nullptr; // Driver callbacks can outlive N-API cleanup hooks.
static void Check(bool condition,const char*message){if(!condition)throw std::runtime_error(message);}
static Digest Hash(const void*data,size_t size){
  Digest digest{};
  Check(size<=MAXDWORD&&BCryptHash(state->algorithm,nullptr,0,(PUCHAR)data,(ULONG)size,digest.data(),(ULONG)digest.size())>=0,"Shader cache SHA-256 failed");
  return digest;
}
static std::string Hex(const Digest&digest){std::string text;for(auto value:digest){text.push_back("0123456789abcdef"[value>>4]);text.push_back("0123456789abcdef"[value&15]);}return text;}
static void Remember(const std::string&name,const Bytes&value){
  auto found=state->memory.find(name);if(found!=state->memory.end()){state->memoryBytes-=found->second.size();state->memory.erase(found);}
  if(state->memoryBytes+value.size()>MaxValue){state->memory.clear();state->memoryBytes=0;}
  state->memory.emplace(name,value);state->memoryBytes+=value.size();
}
static void Prune(){
  struct Entry{std::filesystem::path path;std::filesystem::file_time_type time;uintmax_t size;};std::vector<Entry>entries;size_t size=0;
  for(const auto&entry:std::filesystem::directory_iterator(state->root)){
    const auto name=entry.path().filename().string();
    if(name.size()!=68||name.substr(64)!=".bin"||!std::all_of(name.begin(),name.begin()+64,[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');})||!entry.is_regular_file())continue;
    auto bytes=entry.file_size();size+=(size_t)bytes;entries.push_back({entry.path(),entry.last_write_time(),bytes});
  }
  std::sort(entries.begin(),entries.end(),[](const Entry&a,const Entry&b){return a.time<b.time;});
  for(const auto&entry:entries){if(size<=MaxDisk)break;std::error_code error;if(std::filesystem::remove(entry.path,error))size-=(size_t)entry.size;}
  state->diskBytes=size;
}
struct Timer{Clock::time_point start=Clock::now();~Timer(){state->callbackMs+=std::chrono::duration<double,std::milli>(Clock::now()-start).count();}};
static void Set(const void*key,EGLsizeiANDROID keySize,const void*value,EGLsizeiANDROID valueSize){
  if(!key||!value||keySize<=0||valueSize<=0||(size_t)keySize>MaxKey||(size_t)valueSize>MaxValue)return;
  std::lock_guard<std::mutex>lock(state->mutex);Timer timer;
  std::filesystem::path temporary;
  try{
    const auto name=Hex(Hash(key,(size_t)keySize));
    Bytes payload((size_t)keySize+(size_t)valueSize);memcpy(payload.data(),key,(size_t)keySize);memcpy(payload.data()+keySize,value,(size_t)valueSize);
    const auto digest=Hash(payload.data(),payload.size());const uint32_t lengths[]={(uint32_t)keySize,(uint32_t)valueSize};
    const auto target=state->root/(name+".bin");
    temporary=state->root/(name+"."+std::to_string(GetCurrentProcessId())+"."+std::to_string(++state->sequence)+".partial");
    {std::ofstream file(temporary,std::ios::binary|std::ios::trunc);file.write("TTRMSH01",8);file.write((const char*)lengths,sizeof(lengths));file.write((const char*)digest.data(),digest.size());file.write((const char*)payload.data(),payload.size());file.close();Check(file.good(),"Shader cache write failed");}
    Check(MoveFileExW(temporary.c_str(),target.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH),"Shader cache atomic publication failed");
    state->writes++;state->bytesWritten+=payload.size()+48;state->diskBytes+=payload.size()+48;
    Remember(name,Bytes((const unsigned char*)value,(const unsigned char*)value+valueSize));
    if(state->diskBytes>MaxDisk)Prune();
  }catch(...){state->ioErrors++;if(!temporary.empty()){std::error_code error;std::filesystem::remove(temporary,error);}}
}
static EGLsizeiANDROID Get(const void*key,EGLsizeiANDROID keySize,void*value,EGLsizeiANDROID valueSize){
  if(!key||keySize<=0||(size_t)keySize>MaxKey)return 0;
  std::lock_guard<std::mutex>lock(state->mutex);Timer timer;state->lookups++;
  try{
    const auto name=Hex(Hash(key,(size_t)keySize));auto found=state->memory.find(name);
    if(found==state->memory.end()){
      std::ifstream file(state->root/(name+".bin"),std::ios::binary|std::ios::ate);
      if(!file){state->misses++;return 0;}
      const auto size=file.tellg();
      if(size<48||size>(std::streamoff)(MaxValue+MaxKey+48)){state->corrupt++;return 0;}
      file.seekg(0);Bytes bytes((size_t)size);file.read((char*)bytes.data(),bytes.size());
      uint32_t lengths[2]{};memcpy(lengths,bytes.data()+8,8);
      if(!file.good()||memcmp(bytes.data(),"TTRMSH01",8)||lengths[0]!=(uint32_t)keySize||!lengths[1]||lengths[1]>MaxValue||48+(size_t)lengths[0]+lengths[1]!=bytes.size()||memcmp(bytes.data()+48,key,(size_t)keySize)) {state->corrupt++;return 0;}
      const auto digest=Hash(bytes.data()+48,bytes.size()-48);
      if(memcmp(digest.data(),bytes.data()+16,32)){state->corrupt++;return 0;}
      state->bytesRead+=bytes.size();Remember(name,Bytes(bytes.begin()+48+keySize,bytes.end()));found=state->memory.find(name);
    }
    const auto&bytes=found->second;if(value&&valueSize>=(EGLsizeiANDROID)bytes.size())memcpy(value,bytes.data(),bytes.size());
    state->hits++;return(EGLsizeiANDROID)bytes.size();
  }catch(...){state->ioErrors++;return 0;}
}
static void Start(EGLDisplay display,PFNEGLGETPROCADDRESSPROC proc,const std::string&vendor,const std::string&version){
  const auto count=GetEnvironmentVariableW(L"REPLAY_WINDOWS_SHADER_CACHE",nullptr,0);if(!count)return;
  Check(!state,"Shader cache already initialized");
  std::vector<wchar_t>directory(count);Check(GetEnvironmentVariableW(L"REPLAY_WINDOWS_SHADER_CACHE",directory.data(),count)>0,"Cannot read shader cache directory");
  auto query=(PFNEGLQUERYSTRINGPROC)proc("eglQueryString");auto install=(PFNEGLSETBLOBCACHEFUNCSANDROIDPROC)proc("eglSetBlobCacheFuncsANDROID");
  const char*extensions=query?query(display,EGL_EXTENSIONS):nullptr;
  Check(install&&extensions&&(std::string(" ")+extensions+" ").find(" EGL_ANDROID_blob_cache ")!=std::string::npos,"ANGLE shader blob cache is unavailable");
  EGLAttrib deviceValue=0,d3dValue=0;auto queryDisplay=(PFNEGLQUERYDISPLAYATTRIBEXTPROC)proc("eglQueryDisplayAttribEXT");auto queryDevice=(PFNEGLQUERYDEVICEATTRIBEXTPROC)proc("eglQueryDeviceAttribEXT");
  Check(queryDisplay&&queryDevice&&queryDisplay(display,EGL_DEVICE_EXT,&deviceValue)&&queryDevice((EGLDeviceEXT)deviceValue,EGL_D3D11_DEVICE_ANGLE,&d3dValue),"Cannot identify shader cache D3D11 device");
  Microsoft::WRL::ComPtr<IDXGIDevice>dxgi;Check(SUCCEEDED(((ID3D11Device*)d3dValue)->QueryInterface(IID_PPV_ARGS(&dxgi))),"Cannot identify shader cache DXGI device");
  Microsoft::WRL::ComPtr<IDXGIAdapter>adapter;Check(SUCCEEDED(dxgi->GetAdapter(&adapter)),"Cannot identify shader cache adapter");DXGI_ADAPTER_DESC desc{};LARGE_INTEGER driver{};
  Check(SUCCEEDED(adapter->GetDesc(&desc))&&SUCCEEDED(adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice),&driver)),"Cannot identify shader cache driver version");
  state=new State;
  Check(BCryptOpenAlgorithmProvider(&state->algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0,"Cannot open shader cache SHA-256 provider");
  state->identity=std::string("format1|")+REPLAY_SHADER_CACHE_BUILD+"|"+vendor+"|"+version+"|"+std::to_string(desc.VendorId)+":"+std::to_string(desc.DeviceId)+":"+std::to_string(desc.SubSysId)+":"+std::to_string(desc.Revision)+":"+std::to_string(driver.QuadPart);
  state->root=std::filesystem::absolute(std::filesystem::path(directory.data()))/Hex(Hash(state->identity.data(),state->identity.size()));
  std::filesystem::create_directories(state->root);Prune();
  auto getError=(PFNEGLGETERRORPROC)proc("eglGetError");Check(getError,"Cannot query shader cache registration error");getError();
  install(display,Set,Get);Check(getError()==EGL_SUCCESS,"Cannot register shader blob callbacks");
}
static napi_value Stats(napi_env env,napi_callback_info){
  napi_value out;napi_create_object(env,&out);napi_value enabled;napi_get_boolean(env,state!=nullptr,&enabled);napi_set_named_property(env,out,"enabled",enabled);if(!state)return out;
  std::lock_guard<std::mutex>lock(state->mutex);
  const auto root=state->root.u8string();napi_value text;napi_create_string_utf8(env,root.c_str(),root.size(),&text);napi_set_named_property(env,out,"directory",text);
  napi_create_string_utf8(env,state->identity.c_str(),state->identity.size(),&text);napi_set_named_property(env,out,"identity",text);
  for(const auto&item:{std::pair<const char*,double>{"lookups",(double)state->lookups},{"hits",(double)state->hits},{"misses",(double)state->misses},{"writes",(double)state->writes},{"corrupt",(double)state->corrupt},{"ioErrors",(double)state->ioErrors},{"bytesRead",(double)state->bytesRead},{"bytesWritten",(double)state->bytesWritten},{"memoryBytes",(double)state->memoryBytes},{"callbackMs",state->callbackMs}}){napi_value number;napi_create_double(env,item.second,&number);napi_set_named_property(env,out,item.first,number);}
  return out;
}
} // namespace ReplayShaderCache
