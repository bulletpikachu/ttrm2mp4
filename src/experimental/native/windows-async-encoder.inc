// One main-thread ANGLE context, bounded texture ownership, one native encoder
// thread. D3D11 queries/fences or optional D3D12 GPU fence dependencies order
// GL writes before NVENC reads. Output completion protects texture reuse.
struct AsyncEncoder:VideoEncoder{
  struct ComputeEvent{HANDLE value=nullptr;~ComputeEvent(){if(value)CloseHandle(value);}};
  struct ComputeRGBA{
    EGLDisplay display;EGLImageKHR image=EGL_NO_IMAGE_KHR;GLuint color=0,fbo=0;
    ComPtr<ID3D12Resource>resource;ComPtr<ID3D11Texture2D>angle,compute;ComPtr<ID3D11ShaderResourceView>view;
    ComputeRGBA(EGLDisplay value):display(value){}
    ~ComputeRGBA(){if(fbo)P<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&fbo);if(color)P<PFNGLDELETETEXTURESPROC>("glDeleteTextures")(1,&color);if(image!=EGL_NO_IMAGE_KHR)P<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR")(display,image);}
  };
  struct Slot{
    ComPtr<ID3D11Texture2D>texture,staging;ComPtr<ID3D11Query>ready;
    ComPtr<ID3D12Resource>texture12,output12;ComPtr<ID3D12Fence>done12;
    NV_ENC_REGISTERED_PTR outputRegistration=nullptr;
    NV_ENC_INPUT_RESOURCE_D3D12 inputResource{};NV_ENC_OUTPUT_RESOURCE_D3D12 outputResource{};
    uint64_t outputValue=0;bool submitted12=false;
    std::unique_ptr<ComputeRGBA>gameCopy,headerCopy;ComPtr<ID3D11Texture2D>computeOutput;ComPtr<ID3D11UnorderedAccessView1>planeY,planeUV;
    uint64_t computeValue=0;bool converted=false;
    EGLImageKHR image=EGL_NO_IMAGE_KHR,imageUV=EGL_NO_IMAGE_KHR;GLuint color=0,fbo=0,colorUV=0,fboUV=0;
    NV_ENC_REGISTERED_PTR registered=nullptr;NV_ENC_INPUT_PTR input=nullptr;NV_ENC_OUTPUT_PTR output=nullptr;HANDLE event=nullptr;
    bool readySubmitted=false;
    uint64_t fenceValue=0;HANDLE readyEvent=nullptr;
  };
  struct Job{int slot;bool key;int64_t index;};
  int width,height,fps,current=-1,frames=0;EGLDisplay display;bool nv12=Enabled("REPLAY_WINDOWS_NV12");GLint modeUniform=-1;
  ComPtr<ID3D11Device>device;ComPtr<ID3D11DeviceContext>immediate;ComPtr<ID3D11Multithread>protection;
  ComPtr<ID3D11Device5>device5;ComPtr<ID3D11DeviceContext4>context4;ComPtr<ID3D11Fence>fence;uint64_t fenceCounter=0;
  const bool d3d12=Enabled("REPLAY_WINDOWS_D3D12");bool eosSubmitted=false;
  const bool computeConversion=Enabled("REPLAY_WINDOWS_COMPUTE");double computeMs=0;uint64_t computeCounter=0,computeFrames=0;
  const bool computeInPlace=Enabled("REPLAY_WINDOWS_COMPUTE_INPLACE");ComPtr<ID3DDeviceContextState>computeState;
  std::unique_ptr<ComputeRGBA>directGame,directHeader;GLuint directGameID=0,directHeaderID=0;
  ComPtr<ID3D11Device>computeDevice;ComPtr<ID3D11DeviceContext>computeContext;ComPtr<ID3D11Device1>computeDevice1;ComPtr<ID3D11Device3>computeDevice3;ComPtr<ID3D11Device5>computeDevice5;ComPtr<ID3D11DeviceContext4>computeContext4;
  ComPtr<ID3D11Fence>producerOnCompute,convertedFence,convertedOnAngle;ComPtr<ID3D12Fence>convertedFence12;std::unique_ptr<NV12Compute>converter;
  GLuint copyReadFbo=0;UINT computeHeaderHeight=0;std::mutex computeMutex;ComputeEvent computeEvent;
  int pendingLimit=4,pendingHighWater=0,earlyDrains=0;
  ComPtr<ID3D12Device>device12;ComPtr<ID3D12Fence>inputFence12;
  std::vector<std::unique_ptr<Slot>>slots;std::vector<int>free,readySlots;std::deque<Job>jobs;
  HMODULE library=nullptr;NV_ENCODE_API_FUNCTION_LIST api{};void*session=nullptr;HANDLE eosEvent=nullptr;std::ofstream file;
  std::mutex mutex;std::condition_variable changed;std::thread worker;bool finishing=false,aborting=false;std::string failure;
  AsyncEncoder(int w,int h,int rate):width(w),height(h),fps(rate){
    display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();EGLAttrib e=0,d=0;
    Check(P<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&e),"Query EGL device failed");Check(P<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)e,EGL_D3D11_DEVICE_ANGLE,&d),"Query D3D device failed");device=reinterpret_cast<ID3D11Device*>(d);
    // ANGLE can fall back to its default adapter if the requested vendor is absent.
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC description{};
    Check(SUCCEEDED(device.As(&dxgi)) && SUCCEEDED(dxgi->GetAdapter(&adapter)) &&
          SUCCEEDED(adapter->GetDesc(&description)), "Cannot identify ANGLE's graphics adapter");
    Check(description.VendorId == 0x10de, "ANGLE opened a non-NVIDIA graphics adapter. Check that Windows can see the NVIDIA GPU.");
    device->GetImmediateContext(&immediate);Check(SUCCEEDED(immediate.As(&protection)),"D3D multithread protection unavailable");protection->SetMultithreadProtected(TRUE);
    Check(!d3d12||Enabled("REPLAY_WINDOWS_FENCE"),"D3D12 encoding requires REPLAY_WINDOWS_FENCE=1");
    Check(!computeConversion||(d3d12&&nv12),"Compute conversion requires D3D12 and NV12");
    Check(!computeInPlace||computeConversion,"In-place conversion requires compute conversion");
    if(Enabled("REPLAY_WINDOWS_FENCE")){Check(SUCCEEDED(device.As(&device5))&&SUCCEEDED(immediate.As(&context4)),"D3D11 fence interfaces unavailable");Check(SUCCEEDED(device5->CreateFence(0,d3d12?D3D11_FENCE_FLAG_SHARED:D3D11_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence))),"D3D11 fence creation failed");}
    if(d3d12)InitializeD3D12();
    GLState state;auto request=reinterpret_cast<void(GL_APIENTRYP)(const char*)>(proc("glRequestExtensionANGLE"));if(request){request("GL_OES_EGL_image");request("GL_EXT_texture_format_BGRA8888");}
    int count=16;if(const char*value=getenv("REPLAY_WINDOWS_SURFACES"))count=atoi(value);Check(count>=4&&count<=64,"Windows surfaces must be 4..64");
    if(const char*value=getenv("REPLAY_WINDOWS_PENDING")){char*end=nullptr;long requested=strtol(value,&end,10);Check(end!=value&&*end=='\0'&&requested>=1&&requested<=count,"Windows pending frame count must be 1..surface count");pendingLimit=(int)requested;}
    // Work retains pendingLimit-1 outputs while waiting for the next input.
    // Leave room for a full producer batch, including partial round restarts.
    if(const char*value=getenv("REPLAY_WINDOWS_GPU_BATCH"))gpuBatch=atoi(value);Check(gpuBatch>=1&&gpuBatch<=count-(pendingLimit-1),"Windows GPU batch must leave enough surfaces for pending encoder outputs");
    if(computeConversion)InitializeCompute();
    for(int i=0;i<count;i++){
      auto slot=std::make_unique<Slot>();D3D11_TEXTURE2D_DESC desc{};desc.Width=w;desc.Height=h;desc.MipLevels=desc.ArraySize=1;desc.Format=nv12?DXGI_FORMAT_NV12:DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_DEFAULT;desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
      if(d3d12)AllocateD3D12(*slot);else Check(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&slot->texture)),"Allocate native encoder texture failed");D3D11_QUERY_DESC query{D3D11_QUERY_EVENT,0};Check(SUCCEEDED(device->CreateQuery(&query,&slot->ready)),"Allocate GPU completion query failed");
      if(computeConversion){AllocateComputeSlot(*slot);free.push_back(i);slots.push_back(std::move(slot));continue;}
      const EGLint attrs[]={EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,nv12?GL_RED_EXT:GL_BGRA_EXT,EGL_D3D11_TEXTURE_PLANE_ANGLE,0,EGL_NONE};slot->image=P<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR")(display,EGL_NO_CONTEXT,EGL_D3D11_TEXTURE_ANGLE,(EGLClientBuffer)slot->texture.Get(),attrs);Check(slot->image!=EGL_NO_IMAGE_KHR,"Import pooled encoder texture failed");
      P<PFNGLGENTEXTURESPROC>("glGenTextures")(1,&slot->color);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,slot->color);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);P<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,slot->image);Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"Pooled EGLImage binding failed");
      P<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&slot->fbo);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,slot->fbo);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,slot->color,0);Check(P<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"Pooled D3D framebuffer incomplete");
      if(nv12){
        const EGLint uvAttrs[]={EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,GL_RG_EXT,EGL_D3D11_TEXTURE_PLANE_ANGLE,1,EGL_NONE};slot->imageUV=P<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR")(display,EGL_NO_CONTEXT,EGL_D3D11_TEXTURE_ANGLE,(EGLClientBuffer)slot->texture.Get(),uvAttrs);Check(slot->imageUV!=EGL_NO_IMAGE_KHR,"Import NV12 chroma plane failed");P<PFNGLGENTEXTURESPROC>("glGenTextures")(1,&slot->colorUV);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,slot->colorUV);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);P<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,slot->imageUV);P<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&slot->fboUV);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,slot->fboUV);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,slot->colorUV,0);Check(P<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"NV12 chroma framebuffer incomplete");Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"NV12 plane creation GL error");
      }
      if(fence){slot->readyEvent=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(slot->readyEvent,"GPU readiness event creation failed");}free.push_back(i);slots.push_back(std::move(slot));
    }
    library=LoadLibraryExW(L"nvEncodeAPI64.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);Check(library,"NVENC driver unavailable");auto create=(decltype(&NvEncodeAPICreateInstance))GetProcAddress(library,"NvEncodeAPICreateInstance");Check(create,"NVENC API unavailable");api.version=NV_ENCODE_API_FUNCTION_LIST_VER;NVCheck(create(&api),"Create NVENC interface");
  }
  ~AsyncEncoder(){Close(false);DestroyCompute();for(auto&slot:slots){if(slot->fbo)P<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&slot->fbo);if(slot->color)P<PFNGLDELETETEXTURESPROC>("glDeleteTextures")(1,&slot->color);if(slot->image!=EGL_NO_IMAGE_KHR)P<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR")(display,slot->image);if(slot->fboUV)P<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&slot->fboUV);if(slot->colorUV)P<PFNGLDELETETEXTURESPROC>("glDeleteTextures")(1,&slot->colorUV);if(slot->imageUV!=EGL_NO_IMAGE_KHR)P<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR")(display,slot->imageUV);if(slot->readyEvent)CloseHandle(slot->readyEvent);}if(library)FreeLibrary(library);}
  void Open(const std::string&path){
    Check(!computeConversion||computeHeaderHeight>0,"Compute header dimensions were not configured");
    Check(!session,"Encoder segment already open");frames=0;finishing=aborting=eosSubmitted=false;failure.clear();file.open(std::filesystem::u8path(path),std::ios::binary|std::ios::trunc);Check(file.good(),"Cannot open native video segment");
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};open.version=NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;open.device=d3d12?(void*)device12.Get():(void*)device.Get();open.deviceType=NV_ENC_DEVICE_TYPE_DIRECTX;open.apiVersion=NVENCAPI_VERSION;NVCheck(api.nvEncOpenEncodeSessionEx(&open,&session),"Open async NVENC session");
    NV_ENC_PRESET_CONFIG preset{};preset.version=NV_ENC_PRESET_CONFIG_VER;preset.presetCfg.version=NV_ENC_CONFIG_VER;NVCheck(api.nvEncGetEncodePresetConfigEx(session,NV_ENC_CODEC_H264_GUID,NV_ENC_PRESET_P1_GUID,NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,&preset),"Get native preset");
    NV_ENC_CONFIG config=preset.presetCfg;config.profileGUID=NV_ENC_H264_PROFILE_HIGH_GUID;config.gopLength=fps*2;config.frameIntervalP=1;config.rcParams.rateControlMode=NV_ENC_PARAMS_RC_CONSTQP;config.rcParams.constQP={18,18,18};
    if(Enabled("REPLAY_WINDOWS_CAVLC"))config.encodeCodecConfig.h264Config.entropyCodingMode=NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;entropyMode=(int)config.encodeCodecConfig.h264Config.entropyCodingMode;
    auto&vui=config.encodeCodecConfig.h264Config.h264VUIParameters;vui.videoSignalTypePresentFlag=1;vui.videoFormat=NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;vui.colourDescriptionPresentFlag=1;vui.colourPrimaries=NV_ENC_VUI_COLOR_PRIMARIES_BT709;vui.transferCharacteristics=NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SRGB;vui.colourMatrix=nv12?NV_ENC_VUI_MATRIX_COEFFS_BT709:NV_ENC_VUI_MATRIX_COEFFS_SMPTE170M;
    NV_ENC_INITIALIZE_PARAMS init{};init.version=NV_ENC_INITIALIZE_PARAMS_VER;init.encodeGUID=NV_ENC_CODEC_H264_GUID;init.presetGUID=NV_ENC_PRESET_P1_GUID;init.tuningInfo=NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;init.encodeWidth=init.darWidth=init.maxEncodeWidth=width;init.encodeHeight=init.darHeight=init.maxEncodeHeight=height;init.frameRateNum=fps;init.frameRateDen=1;init.enablePTD=1;init.enableEncodeAsync=d3d12?0:1;if(d3d12)init.bufferFormat=nv12?NV_ENC_BUFFER_FORMAT_NV12:NV_ENC_BUFFER_FORMAT_ARGB;init.encodeConfig=&config;NVCheck(api.nvEncInitializeEncoder(session,&init),"Initialize async NVENC");
    for(auto&slot:slots){
      if(d3d12){OpenD3D12Slot(*slot);continue;}
      NV_ENC_CREATE_BITSTREAM_BUFFER output{};output.version=NV_ENC_CREATE_BITSTREAM_BUFFER_VER;NVCheck(api.nvEncCreateBitstreamBuffer(session,&output),"Create async bitstream");slot->output=output.bitstreamBuffer;
      NV_ENC_REGISTER_RESOURCE reg{};reg.version=NV_ENC_REGISTER_RESOURCE_VER;reg.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;reg.width=width;reg.height=height;reg.resourceToRegister=slot->texture.Get();reg.bufferFormat=nv12?NV_ENC_BUFFER_FORMAT_NV12:NV_ENC_BUFFER_FORMAT_ARGB;reg.bufferUsage=NV_ENC_INPUT_IMAGE;NVCheck(api.nvEncRegisterResource(session,&reg),"Register pooled D3D texture");slot->registered=reg.registeredResource;
      slot->event=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(slot->event,"Allocate NVENC event failed");NV_ENC_EVENT_PARAMS event{};event.version=NV_ENC_EVENT_PARAMS_VER;event.completionEvent=slot->event;NVCheck(api.nvEncRegisterAsyncEvent(session,&event),"Register NVENC completion event");
    }
    if(!d3d12){eosEvent=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(eosEvent,"Create EOS event failed");NV_ENC_EVENT_PARAMS eosRegistration{};eosRegistration.version=NV_ENC_EVENT_PARAMS_VER;eosRegistration.completionEvent=eosEvent;NVCheck(api.nvEncRegisterAsyncEvent(session,&eosRegistration),"Register EOS event");}
    worker=std::thread([this]{Work();});
  }
  void Compose(GLuint program,GLuint vao,GLuint game,GLuint header){
    const auto start=Clock::now();{
      std::unique_lock<std::mutex>lock(mutex);Check(current<0,"Previous frame not submitted");if(!changed.wait_for(lock,std::chrono::seconds(30),[&]{return !free.empty()||!failure.empty();}))throw std::runtime_error("Native frame pool stalled");if(!failure.empty())throw std::runtime_error(failure);current=free.back();free.pop_back();slots[current]->readySubmitted=false;
    }
    slots[current]->converted=false;poolWaitMs+=Ms(start);const int slot=current;driver.Operation([this,slot,program,vao,game,header]{try{RenderSlot(slot,program,vao,game,header);}catch(const std::exception&error){std::lock_guard<std::mutex>lock(mutex);failure=error.what();changed.notify_all();throw;}});
  }
  void RenderSlot(int index,GLuint program,GLuint vao,GLuint game,GLuint header){
    if(computeInPlace){RenderComputeDirect(index,game,header);return;}
    if(computeConversion){CaptureComputeSlot(index,game,header);return;}
    const auto start=Clock::now();auto&slot=*slots[index];GLState state;P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,slot.fbo);P<PFNGLVIEWPORTPROC>("glViewport")(0,0,width,height);for(auto cap:state.caps)P<PFNGLDISABLEPROC>("glDisable")(cap);P<PFNGLCOLORMASKPROC>("glColorMask")(true,true,true,true);
    P<PFNGLUSEPROGRAMPROC>("glUseProgram")(program);P<PFNGLBINDVERTEXARRAYPROC>("glBindVertexArray")(vao);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,game);P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE1);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,header);
    if(nv12){if(modeUniform<0)modeUniform=P<PFNGLGETUNIFORMLOCATIONPROC>("glGetUniformLocation")(program,"mode");P<PFNGLUNIFORM1IPROC>("glUniform1i")(modeUniform,0);}P<PFNGLDRAWARRAYSPROC>("glDrawArrays")(GL_TRIANGLES,0,3);
    if(nv12){P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,slot.fboUV);P<PFNGLVIEWPORTPROC>("glViewport")(0,0,width/2,height/2);P<PFNGLUNIFORM1IPROC>("glUniform1i")(modeUniform,1);P<PFNGLDRAWARRAYSPROC>("glDrawArrays")(GL_TRIANGLES,0,3);}
    Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"Native async composition GL error");readySlots.push_back(index);if(readySlots.size()>=(size_t)gpuBatch)FlushReady();composeMs+=Ms(start);
  }
  // Called only by the GL owner, or after Pause has drained and released it.
  // Every slot in a group waits for the completion point after all its writes.
  void FlushReady(){
    if(readySlots.empty())return;P<PFNGLFLUSHPROC>("glFlush")();
    if(fence){const auto value=++fenceCounter;Check(SUCCEEDED(context4->Signal(fence.Get(),value)),"Signal GPU completion fence failed");for(int index:readySlots)slots[index]->fenceValue=value;}
    else for(int index:readySlots)immediate->End(slots[index]->ready.Get());
    immediate->Flush();gpuSubmissions++;
    {std::lock_guard<std::mutex>lock(mutex);for(int index:readySlots)slots[index]->readySubmitted=true;changed.notify_all();}readySlots.clear();
  }
  void Encode(bool key,int64_t index){std::lock_guard<std::mutex>lock(mutex);if(!failure.empty())throw std::runtime_error(failure);Check(current>=0,"No composed native frame");jobs.push_back({current,key,index});current=-1;changed.notify_all();}
  void Ready(Slot&slot){
    const auto submitted=Clock::now();{std::unique_lock<std::mutex>lock(mutex);Check(changed.wait_for(lock,std::chrono::seconds(30),[&]{return slot.readySubmitted||!failure.empty()||aborting;}),"GL frame submission timed out");if(!failure.empty())throw std::runtime_error(failure);Check(!aborting,"Native encoder cancelled");}submitWaitMs+=Ms(submitted);
    // D3D12 submits the actual GL completion point to NVENC as a GPU wait.
    // The submission flag still protects the CPU publication of fenceValue.
    if(d3d12)return;
    const auto start=Clock::now();if(fence){Check(fence->GetCompletedValue()!=UINT64_MAX,"D3D11 device removed");if(fence->GetCompletedValue()<slot.fenceValue){Check(SUCCEEDED(fence->SetEventOnCompletion(slot.fenceValue,slot.readyEvent)),"Set GPU completion event failed");Check(WaitForSingleObject(slot.readyEvent,30000)==WAIT_OBJECT_0,"GPU completion fence timed out");}}
    else for(;;){const HRESULT result=immediate->GetData(slot.ready.Get(),nullptr,0,D3D11_ASYNC_GETDATA_DONOTFLUSH);if(result==S_OK)break;Check(result==S_FALSE,"D3D completion query failed");if(Ms(start)>30000)throw std::runtime_error("D3D completion query timed out");std::this_thread::yield();}finishMs+=Ms(start);
  }
  void Submit(const Job&job){
    if(d3d12){SubmitD3D12(job);return;}
    auto&slot=*slots[job.slot];Ready(slot);const auto start=Clock::now();NV_ENC_MAP_INPUT_RESOURCE map{};map.version=NV_ENC_MAP_INPUT_RESOURCE_VER;map.registeredResource=slot.registered;NVCheck(api.nvEncMapInputResource(session,&map),"Map pooled D3D frame");slot.input=map.mappedResource;
    NV_ENC_PIC_PARAMS pic{};pic.version=NV_ENC_PIC_PARAMS_VER;pic.inputBuffer=slot.input;pic.bufferFmt=map.mappedBufferFmt;pic.inputWidth=width;pic.inputHeight=height;pic.outputBitstream=slot.output;pic.completionEvent=slot.event;pic.pictureStruct=NV_ENC_PIC_STRUCT_FRAME;pic.inputTimeStamp=job.index;pic.inputDuration=1;if(job.key)pic.encodePicFlags=NV_ENC_PIC_FLAG_FORCEIDR|NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;NVCheck(api.nvEncEncodePicture(session,&pic),"Submit async NVENC frame");encodeSubmitMs+=Ms(start);
  }
  void Drain(const Job&job){
    if(d3d12){DrainD3D12(job);return;}
    auto&slot=*slots[job.slot];const auto wait=Clock::now();Check(WaitForSingleObject(slot.event,30000)==WAIT_OBJECT_0,"NVENC completion event timed out");encodeEventMs+=Ms(wait);const auto start=Clock::now();NV_ENC_LOCK_BITSTREAM lock{};lock.version=NV_ENC_LOCK_BITSTREAM_VER;lock.outputBitstream=slot.output;NVCheck(api.nvEncLockBitstream(session,&lock),"Lock async bitstream");const bool correctTimestamp=lock.outputTimeStamp==(uint64_t)job.index;file.write((const char*)lock.bitstreamBufferPtr,lock.bitstreamSizeInBytes);bytes+=lock.bitstreamSizeInBytes;api.nvEncUnlockBitstream(session,slot.output);Check(correctTimestamp,"Native encoded frame timestamp mismatch");Check(file.good(),"Native H264 write failed");NVCheck(api.nvEncUnmapInputResource(session,slot.input),"Unmap completed frame");slot.input=nullptr;frames++;totalFrames++;bitstreamMs+=Ms(start);
    {std::lock_guard<std::mutex>lockGuard(mutex);free.push_back(job.slot);changed.notify_all();}
  }
  void Work(){
    std::deque<Job>pending;try{for(;;){
      Job job{};bool have=false,end=false;{
        std::unique_lock<std::mutex>lock(mutex);if(jobs.empty()&&pending.empty()&&!finishing&&!aborting)changed.wait(lock,[&]{return !jobs.empty()||finishing||aborting;});if(aborting)break;if(!jobs.empty()){job=jobs.front();jobs.pop_front();have=true;}else end=finishing;
      }
      const auto start=Clock::now();if(have){Submit(job);pending.push_back(job);pendingHighWater=std::max(pendingHighWater,(int)pending.size());}
      if(end){NV_ENC_PIC_PARAMS eos{};eos.version=NV_ENC_PIC_PARAMS_VER;eos.encodePicFlags=NV_ENC_PIC_FLAG_EOS;eos.completionEvent=eosEvent;NVCheck(api.nvEncEncodePicture(session,&eos),"Flush async encoder");eosSubmitted=true;while(!pending.empty()){Drain(pending.front());pending.pop_front();}if(!d3d12)Check(WaitForSingleObject(eosEvent,30000)==WAIT_OBJECT_0,"Native EOS completion timed out");encodeMs+=Ms(start);break;}
      if(!pending.empty()&&(pending.size()>=(size_t)pendingLimit||!have)){if(!have)earlyDrains++;Drain(pending.front());pending.pop_front();}encodeMs+=Ms(start);
    }}catch(const std::exception&error){std::lock_guard<std::mutex>lock(mutex);failure=error.what();changed.notify_all();}
  }
  int Close(bool flush=true){
    driver.Pause();
    FlushReady();
    if(worker.joinable()){{std::lock_guard<std::mutex>lock(mutex);finishing=flush;aborting=!flush;changed.notify_all();}worker.join();}
    if(d3d12&&session)CloseD3D12Slots();
    if(computeConversion)FinishCompute();
    if(session){for(auto&slot:slots){if(slot->input){api.nvEncUnmapInputResource(session,slot->input);slot->input=nullptr;}if(slot->output){api.nvEncDestroyBitstreamBuffer(session,slot->output);slot->output=nullptr;}if(slot->registered){api.nvEncUnregisterResource(session,slot->registered);slot->registered=nullptr;}if(slot->event){NV_ENC_EVENT_PARAMS event{};event.version=NV_ENC_EVENT_PARAMS_VER;event.completionEvent=slot->event;api.nvEncUnregisterAsyncEvent(session,&event);CloseHandle(slot->event);slot->event=nullptr;}}if(eosEvent){NV_ENC_EVENT_PARAMS event{};event.version=NV_ENC_EVENT_PARAMS_VER;event.completionEvent=eosEvent;api.nvEncUnregisterAsyncEvent(session,&event);CloseHandle(eosEvent);eosEvent=nullptr;}api.nvEncDestroyEncoder(session);session=nullptr;}
    if(file.is_open())file.close();if(flush&&!failure.empty())throw std::runtime_error(failure);return frames;
  }
  std::vector<uint8_t>Snapshot(){
    driver.Pause();
    FlushReady();
    if(computeConversion&&!computeInPlace){Check(current>=0,"No composed compute frame to audit");ComputeSlot(*slots[current]);Check(SUCCEEDED(context4->Wait(convertedOnAngle.Get(),slots[current]->computeValue)),"Wait for compute snapshot failed");}
    Check(current>=0,"No composed frame to audit");auto&slot=*slots[current];if(!slot.staging){D3D11_TEXTURE2D_DESC desc;slot.texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=desc.MiscFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;Check(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&slot.staging)),"Create native image audit texture failed");}
    immediate->CopyResource(slot.staging.Get(),slot.texture.Get());D3D11_MAPPED_SUBRESOURCE map{};Check(SUCCEEDED(immediate->Map(slot.staging.Get(),0,D3D11_MAP_READ,0,&map)),"Read native audit texture failed");const size_t row=nv12?width:width*4,rows=nv12?height*3/2:height;std::vector<uint8_t>data(row*rows);for(size_t y=0;y<rows;y++)memcpy(data.data()+y*row,(uint8_t*)map.pData+y*map.RowPitch,row);immediate->Unmap(slot.staging.Get(),0);return data;
  }
  #include "windows-d3d12-encoder.inc"
  #include "windows-compute-encoder.inc"
};
