// Capability/ordering probe only. It never replaces the game's attachments.
static id<MTLDevice> AngleMetalDevice(){
  auto display=Proc<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();
  auto queryDisplay=Proc<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT");
  auto queryDevice=Proc<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT");
  EGLAttrib device=0,metal=0;
  if(!queryDisplay||!queryDevice||!queryDisplay(display,EGL_DEVICE_EXT,&device)||!queryDevice((EGLDeviceEXT)device,EGL_METAL_DEVICE_ANGLE,&metal))return nil;
  return (id<MTLDevice>)metal;
}
static napi_value ProbeMetalInterop(napi_env env,napi_callback_info){
  if(!getProc||!PauseGPU())return Fail(env,"Metal probe requires a current idle ANGLE context");
  @autoreleasepool{
    id<MTLDevice>device=AngleMetalDevice();if(!device)return Fail(env,"ANGLE did not expose its Metal device");
    auto display=Proc<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();
    auto createImage=Proc<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR");auto destroyImage=Proc<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR");
    auto imageStorage=Proc<PFNGLEGLIMAGETARGETRENDERBUFFERSTORAGEOESPROC>("glEGLImageTargetRenderbufferStorageOES");
    if(!createImage||!destroyImage||!imageStorage)return Fail(env,"Metal EGLImage entry points are unavailable");
    auto getInt=Proc<PFNGLGETINTEGERVPROC>("glGetIntegerv");auto getFloat=Proc<PFNGLGETFLOATVPROC>("glGetFloatv");auto getBool=Proc<PFNGLGETBOOLEANVPROC>("glGetBooleanv");auto getError=Proc<PFNGLGETERRORPROC>("glGetError");
    GLint read=0,draw=0,rbo=0,previousTexture=0;GLfloat clearColor[4];GLboolean colorMask[4];getInt(GL_READ_FRAMEBUFFER_BINDING,&read);getInt(GL_DRAW_FRAMEBUFFER_BINDING,&draw);getInt(GL_RENDERBUFFER_BINDING,&rbo);getInt(GL_TEXTURE_BINDING_2D,&previousTexture);getFloat(GL_COLOR_CLEAR_VALUE,clearColor);getBool(GL_COLOR_WRITEMASK,colorMask);
    bool scissor=Proc<PFNGLISENABLEDPROC>("glIsEnabled")(GL_SCISSOR_TEST);
    auto bindFB=Proc<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer");auto bindRB=Proc<PFNGLBINDRENDERBUFFERPROC>("glBindRenderbuffer");
    auto setClear=Proc<PFNGLCLEARCOLORPROC>("glClearColor");auto setMask=Proc<PFNGLCOLORMASKPROC>("glColorMask");
    auto request=Proc<PFNGLREQUESTEXTENSIONANGLEPROC>("glRequestExtensionANGLE");if(request)request("GL_OES_EGL_image");
    id<MTLCommandQueue>queue=[device newCommandQueue];
    NSString*source=@"#include <metal_stdlib>\nusing namespace metal;\nkernel void single(texture2d<float,access::read> t[[texture(0)]],device float4* o[[buffer(0)]]){o[0]=t.read(uint2(1,1));}\nkernel void multi(texture2d_ms<float,access::read> t[[texture(0)]],device float4* o[[buffer(0)]]){float4 v=0;for(uint i=0;i<t.get_num_samples();i++)v+=t.read(uint2(1,1),i);o[0]=v/float(t.get_num_samples());}";
    NSError*error=nil;id<MTLLibrary>metalLibrary=[device newLibraryWithSource:source options:nil error:&error];
    napi_value out,cases,name;napi_create_object(env,&out);napi_create_array(env,&cases);napi_set_named_property(env,out,"cases",cases);napi_create_string_utf8(env,[[device name]UTF8String],NAPI_AUTO_LENGTH,&name);napi_set_named_property(env,out,"device",name);
    const int sampleCounts[]={1,4,4};
    for(int caseIndex=0;caseIndex<3;caseIndex++){
      const bool renderToTexture=caseIndex==2;
      const int samples=sampleCounts[caseIndex];napi_value result;napi_create_object(env,&result);napi_set_named_property(env,result,"samples",Number(env,samples));napi_set_element(env,cases,caseIndex,result);
      auto failCase=[&](const char*message){napi_value value;napi_create_string_utf8(env,message,NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,result,"error",value);};
      napi_value kind;napi_create_string_utf8(env,renderToTexture?"multisampled-render-to-texture":"renderbuffer",NAPI_AUTO_LENGTH,&kind);napi_set_named_property(env,result,"kind",kind);
      if(renderToTexture&&request)request("GL_EXT_multisampled_render_to_texture");
      MTLTextureDescriptor*desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:4 height:4 mipmapped:NO];desc.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead;desc.storageMode=MTLStorageModePrivate;desc.sampleCount=renderToTexture?1:samples;if(samples>1&&!renderToTexture)desc.textureType=MTLTextureType2DMultisample;
      id<MTLTexture>texture=[device newTextureWithDescriptor:desc];
      EGLImageKHR image=EGL_NO_IMAGE_KHR;GLuint framebuffer=0,renderbuffer=0,imageTexture=0;id<MTLComputePipelineState>pipeline=nil;id<MTLFunction>function=nil;id<MTLBuffer>buffer=nil;
      if(!texture)failCase("Metal texture allocation failed");
      else{
        const EGLint attrs[]={EGL_IMAGE_PRESERVED_KHR,EGL_TRUE,EGL_NONE};image=createImage(display,EGL_NO_CONTEXT,EGL_METAL_TEXTURE_ANGLE,(EGLClientBuffer)texture,attrs);
        if(image==EGL_NO_IMAGE_KHR){napi_set_named_property(env,result,"eglError",Number(env,Proc<PFNEGLGETERRORPROC>("eglGetError")()));failCase("Metal texture EGLImage import failed");}
        else{
          Proc<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&framebuffer);bindFB(GL_FRAMEBUFFER,framebuffer);
          if(renderToTexture){
            Proc<PFNGLGENTEXTURESPROC>("glGenTextures")(1,&imageTexture);Proc<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,imageTexture);
            Proc<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,(GLeglImageOES)image);
            auto attach=Proc<PFNGLFRAMEBUFFERTEXTURE2DMULTISAMPLEEXTPROC>("glFramebufferTexture2DMultisampleEXT");
            if(attach)attach(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,imageTexture,0,samples);
          }else{Proc<PFNGLGENRENDERBUFFERSPROC>("glGenRenderbuffers")(1,&renderbuffer);bindRB(GL_RENDERBUFFER,renderbuffer);imageStorage(GL_RENDERBUFFER,(GLeglImageOES)image);Proc<PFNGLFRAMEBUFFERRENDERBUFFERPROC>("glFramebufferRenderbuffer")(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,renderbuffer);}
          GLenum status=Proc<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER);napi_set_named_property(env,result,"framebufferStatus",Number(env,status));
          if(status!=GL_FRAMEBUFFER_COMPLETE)failCase("Imported renderbuffer is not framebuffer-complete");
          else if(!metalLibrary||!queue)failCase(error?[[error localizedDescription]UTF8String]:"Metal compute setup failed");
          else{
            GLint actualSamples=0;getInt(GL_SAMPLES,&actualSamples);napi_set_named_property(env,result,"actualSamples",Number(env,actualSamples));
            Proc<PFNGLDISABLEPROC>("glDisable")(GL_SCISSOR_TEST);setMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);setClear(.25f,.5f,.75f,1.f);Proc<PFNGLCLEARPROC>("glClear")(GL_COLOR_BUFFER_BIT);
            function=[metalLibrary newFunctionWithName:samples>1&&!renderToTexture?@"multi":@"single"];pipeline=[device newComputePipelineStateWithFunction:function error:&error];buffer=[device newBufferWithLength:sizeof(float)*4 options:MTLResourceStorageModeShared];
            Fence fence=WorkerFence();
            if(!pipeline||!buffer||!fence.display)failCase(error?[[error localizedDescription]UTF8String]:"Metal conversion fence/setup failed");
            else{
              id<MTLCommandBuffer>command=[queue commandBuffer];[command encodeWaitForEvent:(id<MTLSharedEvent>)fence.display value:(uint64_t)fence.sync];
              id<MTLComputeCommandEncoder>encoder=[command computeCommandEncoder];[encoder setComputePipelineState:pipeline];[encoder setTexture:texture atIndex:0];[encoder setBuffer:buffer offset:0 atIndex:0];[encoder dispatchThreads:MTLSizeMake(1,1,1) threadsPerThreadgroup:MTLSizeMake(1,1,1)];[encoder endEncoding];
              EGLSyncKHR completion=EGL_NO_SYNC_KHR;void*completedEvent=nullptr;
              auto waitSync=Proc<PFNEGLWAITSYNCKHRPROC>("eglWaitSyncKHR");
              if(renderToTexture&&waitSync){
                const EGLint attrs[]={EGL_SYNC_CONDITION_KHR,EGL_SYNC_METAL_SHARED_EVENT_SIGNALED_ANGLE,EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_LO_ANGLE,1,EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_HI_ANGLE,0,EGL_NONE};
                completion=Proc<PFNEGLCREATESYNCKHRPROC>("eglCreateSyncKHR")(display,EGL_SYNC_METAL_SHARED_EVENT_ANGLE,attrs);
                if(completion!=EGL_NO_SYNC_KHR){completedEvent=Proc<PFNEGLCOPYMETALSHAREDEVENTANGLEPROC>("eglCopyMetalSharedEventANGLE")(display,completion);if(completedEvent)[command encodeSignalEvent:(id<MTLSharedEvent>)completedEvent value:1];}
              }
              [command commit];
              if(completedEvent){
                const auto started=std::chrono::steady_clock::now();const auto status=waitSync(display,completion,0);
                napi_set_named_property(env,result,"serverWaitStatus",Number(env,status));napi_value elapsed;napi_create_double(env,std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count(),&elapsed);napi_set_named_property(env,result,"serverWaitMs",elapsed);
                // An ordered subsequent GL write must not race the preceding
                // Metal read of the same texture.
                setClear(0,1,0,1);Proc<PFNGLCLEARPROC>("glClear")(GL_COLOR_BUFFER_BIT);Proc<PFNGLFLUSHPROC>("glFlush")();
              }
              [command waitUntilCompleted];
              if(completedEvent)ReleaseMetal(completedEvent,nullptr);if(completion!=EGL_NO_SYNC_KHR)Proc<PFNEGLDESTROYSYNCKHRPROC>("eglDestroySyncKHR")(display,completion);
              if(command.status!=MTLCommandBufferStatusCompleted)failCase(command.error?[[command.error localizedDescription]UTF8String]:"Metal command failed");
              else{napi_value values;napi_create_array(env,&values);const auto pixel=(const float*)[buffer contents];bool correct=true;const int expected[]={64,128,191,255};for(int channel=0;channel<4;channel++){int value=(int)std::lround(pixel[channel]*255.f);napi_set_element(env,values,channel,Number(env,value));if(std::abs(value-expected[channel])>1)correct=false;}napi_set_named_property(env,result,"rgba",values);napi_value ok;napi_get_boolean(env,correct&&actualSamples==(samples==1?0:samples),&ok);napi_set_named_property(env,result,"passed",ok);}
            }
            if(fence.display)ReleaseMetal(fence.display,nullptr);
          }
        }
      }
      bindFB(GL_READ_FRAMEBUFFER,read);bindFB(GL_DRAW_FRAMEBUFFER,draw);bindRB(GL_RENDERBUFFER,rbo);Proc<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,previousTexture);setClear(clearColor[0],clearColor[1],clearColor[2],clearColor[3]);setMask(colorMask[0],colorMask[1],colorMask[2],colorMask[3]);if(scissor)Proc<PFNGLENABLEPROC>("glEnable")(GL_SCISSOR_TEST);
      if(framebuffer)Proc<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&framebuffer);if(renderbuffer)Proc<PFNGLDELETERENDERBUFFERSPROC>("glDeleteRenderbuffers")(1,&renderbuffer);if(imageTexture)Proc<PFNGLDELETETEXTURESPROC>("glDeleteTextures")(1,&imageTexture);if(image!=EGL_NO_IMAGE_KHR)destroyImage(display,image);
      [buffer release];[pipeline release];[function release];[texture release];
      napi_value errors;napi_create_array(env,&errors);uint32_t index=0;for(GLenum code=getError();code&&index<32;code=getError())napi_set_element(env,errors,index++,Number(env,code));napi_set_named_property(env,result,"glErrors",errors);
    }
    [metalLibrary release];[queue release];return out;
  }
}
