#include <node_api.h>
#include <IOSurface/IOSurface.h>
#include <cstring>
static IOSurfaceRef Surface(napi_env env,napi_value arg){
  bool buffer=false;napi_is_buffer(env,arg,&buffer);void* bytes=nullptr;size_t length=0;
  if(!buffer||napi_get_buffer_info(env,arg,&bytes,&length)!=napi_ok||length!=sizeof(IOSurfaceRef)){napi_throw_error(env,nullptr,"Expected IOSurface pointer buffer");return nullptr;}
  IOSurfaceRef surface=nullptr;memcpy(&surface,bytes,sizeof(surface));if(!surface)napi_throw_error(env,nullptr,"Null IOSurface");return surface;
}
static void NoOp(napi_env,void*,void*){}
static napi_value Lock(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1],out;napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(!argc){napi_throw_error(env,nullptr,"Missing surface");return nullptr;}auto s=Surface(env,args[0]);if(!s)return nullptr;
  if(IOSurfaceGetPlaneCount(s)!=2){napi_throw_error(env,nullptr,"Expected two-plane NV12 surface");return nullptr;}
  IOReturn status=IOSurfaceLock(s,kIOSurfaceLockReadOnly,nullptr);if(status!=kIOReturnSuccess){napi_throw_error(env,nullptr,"IOSurface lock failed");return nullptr;}
  napi_create_array_with_length(env,2,&out);
  for(int i=0;i<2;i++){
    napi_value item,data,value;napi_create_object(env,&item);
    size_t stride=IOSurfaceGetBytesPerRowOfPlane(s,i),height=IOSurfaceGetHeightOfPlane(s,i);
    // The JS owner must retain the texture and lock until all writes complete.
    // Returned Buffers become invalid as soon as unlock/release is called.
    napi_status status=napi_create_external_buffer(env,stride*height,(char*)IOSurfaceGetBaseAddressOfPlane(s,i),NoOp,nullptr,&data);
    bool copied=false;
    if(status==napi_no_external_buffers_allowed){status=napi_create_buffer_copy(env,stride*height,IOSurfaceGetBaseAddressOfPlane(s,i),nullptr,&data);copied=true;}
    if(status!=napi_ok){IOSurfaceUnlock(s,kIOSurfaceLockReadOnly,nullptr);napi_throw_error(env,nullptr,"Cannot expose surface plane");return nullptr;}
    napi_set_named_property(env,item,"data",data);napi_get_boolean(env,copied,&value);napi_set_named_property(env,item,"copied",value);
    napi_create_double(env,stride,&value);napi_set_named_property(env,item,"stride",value);
    napi_create_double(env,height,&value);napi_set_named_property(env,item,"height",value);
    napi_set_element(env,out,i,item);
  }
  return out;
}
static napi_value Unlock(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1],out;napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(!argc){napi_throw_error(env,nullptr,"Missing surface");return nullptr;}auto s=Surface(env,args[0]);if(!s)return nullptr;
  IOSurfaceUnlock(s,kIOSurfaceLockReadOnly,nullptr);napi_get_undefined(env,&out);return out;
}
static napi_value Marker(napi_env env,napi_callback_info info){
  size_t argc=2;napi_value args[2],out;napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(argc<2){napi_throw_error(env,nullptr,"Expected surface and marker row");return nullptr;}
  auto surface=Surface(env,args[0]);if(!surface)return nullptr;int32_t row=0;napi_get_value_int32(env,args[1],&row);
  if(row<0||(size_t)row>=IOSurfaceGetHeightOfPlane(surface,0)||IOSurfaceGetWidthOfPlane(surface,0)<192){napi_throw_error(env,nullptr,"Invalid marker geometry");return nullptr;}
  if(IOSurfaceLock(surface,kIOSurfaceLockReadOnly,nullptr)!=kIOReturnSuccess){napi_throw_error(env,nullptr,"Marker lock failed");return nullptr;}
  const uint8_t* bytes=(const uint8_t*)IOSurfaceGetBaseAddressOfPlane(surface,0)+row*IOSurfaceGetBytesPerRowOfPlane(surface,0);
  uint32_t magic=0,index=0;for(int i=0;i<16;i++)if(bytes[i*4+2]>128)magic|=1u<<i;for(int i=0;i<32;i++)if(bytes[(i+16)*4+2]>128)index|=1u<<i;
  IOSurfaceUnlock(surface,kIOSurfaceLockReadOnly,nullptr);napi_create_object(env,&out);napi_value value;napi_get_boolean(env,magic==0xA55A,&value);napi_set_named_property(env,out,"valid",value);napi_create_uint32(env,index,&value);napi_set_named_property(env,out,"index",value);return out;
}
static napi_value Init(napi_env env,napi_value exports){napi_value fn;napi_create_function(env,"lock",NAPI_AUTO_LENGTH,Lock,nullptr,&fn);napi_set_named_property(env,exports,"lock",fn);napi_create_function(env,"unlock",NAPI_AUTO_LENGTH,Unlock,nullptr,&fn);napi_set_named_property(env,exports,"unlock",fn);napi_create_function(env,"marker",NAPI_AUTO_LENGTH,Marker,nullptr,&fn);napi_set_named_property(env,exports,"marker",fn);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
