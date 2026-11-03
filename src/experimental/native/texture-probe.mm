#include <node_api.h>
#include <IOSurface/IOSurface.h>
#include <cstring>
static napi_value Inspect(napi_env env,napi_callback_info info){
  size_t argc=1; napi_value args[1],result; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  bool isBuffer=false;if(argc)napi_is_buffer(env,args[0],&isBuffer);
  void* bytes=nullptr;size_t length=0;
  if(!isBuffer||napi_get_buffer_info(env,args[0],&bytes,&length)!=napi_ok||length!=sizeof(IOSurfaceRef)){napi_throw_error(env,nullptr,"Expected a process-local IOSurface pointer buffer");return nullptr;}
  IOSurfaceRef surface=nullptr;std::memcpy(&surface,bytes,sizeof(surface));
  if(!surface){napi_throw_error(env,nullptr,"Null IOSurface");return nullptr;}
  napi_create_object(env,&result);
  auto set=[&](const char*key,size_t value){napi_value v;napi_create_double(env,(double)value,&v);napi_set_named_property(env,result,key,v);};
  set("width",IOSurfaceGetWidth(surface));set("height",IOSurfaceGetHeight(surface));set("pixelFormat",IOSurfaceGetPixelFormat(surface));set("planes",IOSurfaceGetPlaneCount(surface));
  return result;
}
static napi_value Init(napi_env env,napi_value exports){napi_value fn;napi_create_function(env,"inspect",NAPI_AUTO_LENGTH,Inspect,nullptr,&fn);napi_set_named_property(env,exports,"inspect",fn);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
