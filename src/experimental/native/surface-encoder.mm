#include <node_api.h>
#include <IOSurface/IOSurface.h>
#include <VideoToolbox/VideoToolbox.h>
#include <CoreVideo/CoreVideo.h>
#include <CoreMedia/CoreMedia.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <mutex>
#include <atomic>
struct Token { int64_t frame; OSStatus status; };
struct Encoder { VTCompressionSessionRef session=nullptr; FILE* file=nullptr; napi_threadsafe_function notify=nullptr; std::mutex mutex; std::atomic<int> error{0}; std::atomic<int64_t> written{0}; int width=0,height=0,fps=60; };
static Encoder* current=nullptr;
static void Notify(napi_env env,napi_value callback,void*,void* data){
  Token* token=static_cast<Token*>(data);
  if(env&&callback){napi_value args[2],unused,global;napi_get_global(env,&global);napi_create_int64(env,token->frame,&args[0]);napi_create_int32(env,token->status,&args[1]);napi_call_function(env,global,callback,2,args,&unused);}
  delete token;
}
static void Output(void* ref,void* source,OSStatus status,VTEncodeInfoFlags flags,CMSampleBufferRef sample){
  Encoder* s=static_cast<Encoder*>(ref);Token* token=static_cast<Token*>(source);token->status=status;
  if(status==noErr&&sample&&CMSampleBufferDataIsReady(sample)){
    std::lock_guard<std::mutex> lock(s->mutex);
    bool key=true;CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
    if(attachments&&CFArrayGetCount(attachments)){CFDictionaryRef attachment=(CFDictionaryRef)CFArrayGetValueAtIndex(attachments,0);key=!CFDictionaryContainsKey(attachment,kCMSampleAttachmentKey_NotSync);}
    const unsigned char start[4]={0,0,0,1};
    if(key){
      CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);size_t count=0;int length=0;
      OSStatus r=CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,0,nullptr,nullptr,&count,&length);
      if(r==noErr)for(size_t i=0;i<count;i++){const uint8_t* bytes=nullptr;size_t size=0;r=CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,i,&bytes,&size,nullptr,nullptr);if(r!=noErr)break;if(fwrite(start,1,4,s->file)!=4||fwrite(bytes,1,size,s->file)!=size)s->error=EIO;}
      else s->error=r;
    }
    CMBlockBufferRef block=CMSampleBufferGetDataBuffer(sample);size_t size=CMBlockBufferGetDataLength(block);std::vector<uint8_t> bytes(size);
    OSStatus r=CMBlockBufferCopyDataBytes(block,0,size,bytes.data());
    if(r!=noErr)s->error=r;
    else {size_t pos=0;while(pos+4<=size){uint32_t n=0;memcpy(&n,bytes.data()+pos,4);n=CFSwapInt32BigToHost(n);pos+=4;if(n>size-pos){s->error=-1;break;}if(fwrite(start,1,4,s->file)!=4||fwrite(bytes.data()+pos,1,n,s->file)!=n)s->error=EIO;pos+=n;}if(pos!=size)s->error=-2;}
    s->written++;
  }else{if(status==noErr)token->status=-3;s->error=token->status;}
  napi_call_threadsafe_function(s->notify,token,napi_tsfn_nonblocking);
}
static napi_value Fail(napi_env env,const char* message,int code){std::string text=std::string(message)+" ("+std::to_string(code)+")";napi_throw_error(env,nullptr,text.c_str());return nullptr;}
static napi_value Open(napi_env env,napi_callback_info info){
  size_t argc=6;napi_value a[6];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);
  if(argc!=6||current)return Fail(env,"Expected width, height, fps, bitrate, path, callback; encoder must be closed",-1);
  Encoder* s=new Encoder();int32_t bitrate=0;
  napi_get_value_int32(env,a[0],&s->width);napi_get_value_int32(env,a[1],&s->height);napi_get_value_int32(env,a[2],&s->fps);napi_get_value_int32(env,a[3],&bitrate);
  if(s->width<=0||s->height<=0||s->fps<=0||bitrate<=0){delete s;return Fail(env,"Invalid encoder settings",-1);}
  size_t len=0;napi_get_value_string_utf8(env,a[4],nullptr,0,&len);std::vector<char> name(len+1);napi_get_value_string_utf8(env,a[4],name.data(),name.size(),&len);
  s->file=fopen(name.data(),"wb");if(!s->file){delete s;return Fail(env,"Cannot open output",errno);}
  napi_value label;napi_create_string_utf8(env,"surface-encoder",NAPI_AUTO_LENGTH,&label);napi_status nr=napi_create_threadsafe_function(env,a[5],nullptr,label,0,1,nullptr,nullptr,nullptr,Notify,&s->notify);
  if(nr!=napi_ok){fclose(s->file);delete s;return Fail(env,"Cannot create encoder notification",nr);}
  const void* keys[]={kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder};const void* vals[]={kCFBooleanTrue};
  CFDictionaryRef specification=CFDictionaryCreate(kCFAllocatorDefault,keys,vals,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  OSStatus code=VTCompressionSessionCreate(kCFAllocatorDefault,s->width,s->height,kCMVideoCodecType_H264,specification,nullptr,nullptr,Output,s,&s->session);CFRelease(specification);
  auto set=[&](CFStringRef key,CFTypeRef value){if(code==noErr)code=VTSessionSetProperty(s->session,key,value);};
  auto number=[&](CFStringRef key,int value){CFNumberRef n=CFNumberCreate(kCFAllocatorDefault,kCFNumberIntType,&value);set(key,n);CFRelease(n);};
  if(code==noErr){set(kVTCompressionPropertyKey_RealTime,kCFBooleanFalse);set(kVTCompressionPropertyKey_AllowFrameReordering,kCFBooleanFalse);set(kVTCompressionPropertyKey_ProfileLevel,kVTProfileLevel_H264_High_AutoLevel);number(kVTCompressionPropertyKey_AverageBitRate,bitrate);number(kVTCompressionPropertyKey_ExpectedFrameRate,s->fps);number(kVTCompressionPropertyKey_MaxKeyFrameInterval,s->fps*2);}
  if(code==noErr)code=VTCompressionSessionPrepareToEncodeFrames(s->session);
  if(code!=noErr){if(s->session){VTCompressionSessionInvalidate(s->session);CFRelease(s->session);}napi_release_threadsafe_function(s->notify,napi_tsfn_release);fclose(s->file);delete s;return Fail(env,"Cannot initialize hardware encoder",code);}
  current=s;napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value Encode(napi_env env,napi_callback_info info){
  size_t argc=3;napi_value a[3];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);
  if(argc<2||!current)return Fail(env,"Encoder not open or arguments missing",-1);
  void* bytes=nullptr;size_t len=0;bool isBuffer=false;napi_is_buffer(env,a[0],&isBuffer);
  if(!isBuffer||napi_get_buffer_info(env,a[0],&bytes,&len)!=napi_ok||len!=sizeof(IOSurfaceRef))return Fail(env,"Expected IOSurface pointer buffer",-1);
  IOSurfaceRef surface=nullptr;memcpy(&surface,bytes,sizeof(surface));if(!surface)return Fail(env,"Null IOSurface",-1);
  if(IOSurfaceGetWidth(surface)!=(size_t)current->width||IOSurfaceGetHeight(surface)!=(size_t)current->height)return Fail(env,"Unexpected surface dimensions",-1);
  int64_t frame=0;napi_get_value_int64(env,a[1],&frame);if(frame<0)return Fail(env,"Negative frame number",-1);
  CVPixelBufferRef pixel=nullptr;OSStatus code=CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault,surface,nullptr,&pixel);if(code!=noErr)return Fail(env,"Cannot wrap IOSurface",code);
  CVBufferSetAttachment(pixel,kCVImageBufferColorPrimariesKey,kCVImageBufferColorPrimaries_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(pixel,kCVImageBufferYCbCrMatrixKey,kCVImageBufferYCbCrMatrix_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(pixel,kCVImageBufferTransferFunctionKey,kCVImageBufferTransferFunction_sRGB,kCVAttachmentMode_ShouldPropagate);
  Token* token=new Token{frame,0};VTEncodeInfoFlags flags=0;bool key=false;if(argc>2)napi_get_value_bool(env,a[2],&key);
  CFDictionaryRef options=nullptr;if(key){const void*keys[]={kVTEncodeFrameOptionKey_ForceKeyFrame};const void*values[]={kCFBooleanTrue};options=CFDictionaryCreate(kCFAllocatorDefault,keys,values,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);}
  code=VTCompressionSessionEncodeFrame(current->session,pixel,CMTimeMake(frame,current->fps),CMTimeMake(1,current->fps),options,token,&flags);
  CVPixelBufferRelease(pixel);if(options)CFRelease(options);
  if(code!=noErr){delete token;return Fail(env,"Hardware frame encoding failed",code);}
  napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value Close(napi_env env,napi_callback_info){
  if(!current){napi_value empty;napi_get_undefined(env,&empty);return empty;}
  Encoder* s=current;current=nullptr;
  OSStatus code=VTCompressionSessionCompleteFrames(s->session,kCMTimeInvalid);VTCompressionSessionInvalidate(s->session);CFRelease(s->session);s->session=nullptr;
  fclose(s->file);s->file=nullptr;int error=s->error.load();int64_t frames=s->written.load();napi_release_threadsafe_function(s->notify,napi_tsfn_release);delete s;
  if(code!=noErr||error)return Fail(env,"Encoding did not complete",code?code:error);
  napi_value result;napi_create_int64(env,frames,&result);return result;
}
static napi_value Init(napi_env env,napi_value exports){
  for(auto item:{std::pair<const char*,napi_callback>{"open",Open},{"encode",Encode},{"close",Close}}){napi_value fn;napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,nullptr,&fn);napi_set_named_property(env,exports,item.first,fn);}return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
