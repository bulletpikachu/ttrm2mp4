// Included inside AsyncEncoder. Conversion is queued by the encoding thread;
// diagnostic snapshots serialize access to the same separate device context.
void InitializeCompute(){
  ComPtr<IDXGIDevice>dxgi;ComPtr<IDXGIAdapter>adapter;Check(SUCCEEDED(device.As(&dxgi))&&SUCCEEDED(dxgi->GetAdapter(&adapter)),"Query compute adapter failed");
  if(computeInPlace){computeDevice=device;computeContext=immediate;computeState=CreateComputeState(device.Get());}
  else Check(SUCCEEDED(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&computeDevice,nullptr,&computeContext)),"Create separate conversion device failed");
  Check(SUCCEEDED(computeDevice.As(&computeDevice1))&&SUCCEEDED(computeDevice.As(&computeDevice3))&&SUCCEEDED(computeDevice.As(&computeDevice5))&&SUCCEEDED(computeContext.As(&computeContext4)),"Compute device interfaces unavailable");
  if(!computeInPlace){
  SharedHandle12 producer;Check(SUCCEEDED(fence->CreateSharedHandle(nullptr,GENERIC_ALL,nullptr,&producer.value)),"Share producer fence failed");Check(SUCCEEDED(computeDevice5->OpenSharedFence(producer.value,IID_PPV_ARGS(&producerOnCompute))),"Open producer fence on compute device failed");
  Check(SUCCEEDED(computeDevice5->CreateFence(0,D3D11_FENCE_FLAG_SHARED,IID_PPV_ARGS(&convertedFence))),"Create converted-frame fence failed");SharedHandle12 converted;Check(SUCCEEDED(convertedFence->CreateSharedHandle(nullptr,GENERIC_ALL,nullptr,&converted.value)),"Share converted-frame fence failed");
  Check(SUCCEEDED(device12->OpenSharedHandle(converted.value,IID_PPV_ARGS(&convertedFence12))),"Open conversion fence for NVENC failed");Check(SUCCEEDED(device5->OpenSharedFence(converted.value,IID_PPV_ARGS(&convertedOnAngle))),"Open conversion fence for snapshots failed");
  }
  converter=std::make_unique<NV12Compute>(computeDevice.Get(),computeContext.Get());computeEvent.value=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(computeEvent.value,"Create compute completion event failed");
  P<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&copyReadFbo);
}
std::unique_ptr<ComputeRGBA> AllocateComputeRGBA(UINT w,UINT h){
  P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);
  auto surface=std::make_unique<ComputeRGBA>(display);
  D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;desc.Width=w;desc.Height=h;desc.DepthOrArraySize=desc.MipLevels=1;desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_UNKNOWN;desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
  Check(SUCCEEDED(device12->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&surface->resource))),"Create shared conversion input failed");
  SharedHandle12 shared;Check(SUCCEEDED(device12->CreateSharedHandle(surface->resource.Get(),nullptr,GENERIC_ALL,nullptr,&shared.value)),"Share conversion input failed");ComPtr<ID3D11Device1>angle1;Check(SUCCEEDED(device.As(&angle1)),"Query ANGLE D3D11.1 failed");
  Check(SUCCEEDED(angle1->OpenSharedResource1(shared.value,IID_PPV_ARGS(&surface->angle))),"Open conversion input in ANGLE failed");if(computeInPlace)surface->compute=surface->angle;else Check(SUCCEEDED(computeDevice1->OpenSharedResource1(shared.value,IID_PPV_ARGS(&surface->compute))),"Open conversion input in compute device failed");
  Check(SUCCEEDED(computeDevice->CreateShaderResourceView(surface->compute.Get(),nullptr,&surface->view)),"Create conversion input view failed");
  const EGLint attrs[]={EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,GL_RGBA,EGL_NONE};surface->image=P<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR")(display,EGL_NO_CONTEXT,EGL_D3D11_TEXTURE_ANGLE,(EGLClientBuffer)surface->angle.Get(),attrs);Check(surface->image!=EGL_NO_IMAGE_KHR,"Import shared conversion input failed");
  P<PFNGLGENTEXTURESPROC>("glGenTextures")(1,&surface->color);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,surface->color);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);P<PFNGLTEXPARAMETERIPROC>("glTexParameteri")(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);P<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,surface->image);
  P<PFNGLGENFRAMEBUFFERSPROC>("glGenFramebuffers")(1,&surface->fbo);P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_FRAMEBUFFER,surface->fbo);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,surface->color,0);Check(P<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"Shared conversion input framebuffer incomplete");
  return surface;
}
void AllocateComputeSlot(Slot&slot){
  if(computeInPlace)slot.computeOutput=slot.texture;
  else{SharedHandle12 handle;Check(SUCCEEDED(device12->CreateSharedHandle(slot.texture12.Get(),nullptr,GENERIC_ALL,nullptr,&handle.value)),"Share NV12 conversion target failed");Check(SUCCEEDED(computeDevice1->OpenSharedResource1(handle.value,IID_PPV_ARGS(&slot.computeOutput))),"Open NV12 conversion target failed");}
  for(UINT plane=0;plane<2;plane++){D3D11_UNORDERED_ACCESS_VIEW_DESC1 view{};view.Format=plane?DXGI_FORMAT_R8G8_UNORM:DXGI_FORMAT_R8_UNORM;view.ViewDimension=D3D11_UAV_DIMENSION_TEXTURE2D;view.Texture2D.PlaneSlice=plane;Check(SUCCEEDED(computeDevice3->CreateUnorderedAccessView1(slot.computeOutput.Get(),&view,plane?&slot.planeUV:&slot.planeY)),"Create pooled NV12 compute plane failed");}
  if(!computeInPlace)slot.gameCopy=AllocateComputeRGBA(width,height);
}
void ConfigureComputeSource(GLuint game,GLuint header){
  Check(computeInPlace&&game&&header&&game!=header&&!directGame,"Invalid in-place conversion sources");GLState state;
  directGame=AllocateComputeRGBA(width,height);directHeader=AllocateComputeRGBA(width,computeHeaderHeight);
  P<PFNGLDISABLEPROC>("glDisable")(GL_SCISSOR_TEST);
  for(int i=0;i<2;i++){
    auto&destination=i?*directHeader:*directGame;const GLint h=i?computeHeaderHeight:height;
    ComPtr<ID3D11RenderTargetView>rtv;Check(SUCCEEDED(device->CreateRenderTargetView(destination.angle.Get(),nullptr,&rtv)),"Create source initialization view failed");const float zero[4]={};immediate->ClearRenderTargetView(rtv.Get(),zero);
    P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_READ_FRAMEBUFFER,copyReadFbo);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_READ_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,i?header:game,0);
    const auto complete=P<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_READ_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE;
    Check(i||complete,"Original game texture is not initialized");
    if(complete){P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_DRAW_FRAMEBUFFER,destination.fbo);P<PFNGLBLITFRAMEBUFFERPROC>("glBlitFramebuffer")(0,0,width,h,0,0,width,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);}
    P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);P<PFNGLBINDTEXTUREPROC>("glBindTexture")(GL_TEXTURE_2D,i?header:game);P<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,destination.image);
  }
  Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"Configure in-place GL sources failed");directGameID=game;directHeaderID=header;
}
void RenderComputeDirect(int index,GLuint game,GLuint header){
  Check(directGame&&directHeader&&game==directGameID&&header==directHeaderID,"In-place source texture changed");const auto start=Clock::now();auto&slot=*slots[index];
  {ComputeStateScope scope(immediate.Get(),computeState.Get());converter->Convert(directGame->view.Get(),directHeader->view.Get(),slot.planeY.Get(),slot.planeUV.Get(),width,height,computeHeaderHeight);}
  Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"In-place conversion GL error");
  slot.converted=true;computeCounter++;computeFrames++;computeMs+=Ms(start);readySlots.push_back(index);if(readySlots.size()>=(size_t)gpuBatch)FlushReady();composeMs+=Ms(start);
}
void CaptureComputeSlot(int index,GLuint game,GLuint header){
  const auto start=Clock::now();auto&slot=*slots[index];GLState state;
  P<PFNGLACTIVETEXTUREPROC>("glActiveTexture")(GL_TEXTURE0);
  Check(computeHeaderHeight>0,"Compute header dimensions were not configured");
  if(!slot.headerCopy)slot.headerCopy=AllocateComputeRGBA(width,computeHeaderHeight);
  P<PFNGLDISABLEPROC>("glDisable")(GL_SCISSOR_TEST);
  for(int i=0;i<2;i++){
    auto&destination=i?*slot.headerCopy:*slot.gameCopy;const GLint h=i?computeHeaderHeight:height;
    P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_READ_FRAMEBUFFER,copyReadFbo);P<PFNGLFRAMEBUFFERTEXTURE2DPROC>("glFramebufferTexture2D")(GL_READ_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,i?header:game,0);
    P<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer")(GL_DRAW_FRAMEBUFFER,destination.fbo);P<PFNGLBLITFRAMEBUFFERPROC>("glBlitFramebuffer")(0,0,width,h,0,0,width,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);
  }
  Check(P<PFNGLGETERRORPROC>("glGetError")()==GL_NO_ERROR,"Capture compute input GL error");readySlots.push_back(index);if(readySlots.size()>=(size_t)gpuBatch)FlushReady();composeMs+=Ms(start);
}
void ComputeSlot(Slot&slot){
  std::lock_guard<std::mutex>lock(computeMutex);if(slot.converted)return;
  const auto start=Clock::now();Check(slot.gameCopy&&slot.headerCopy,"Compute input was not captured");Check(SUCCEEDED(computeContext4->Wait(producerOnCompute.Get(),slot.fenceValue)),"Queue compute producer dependency failed");
  converter->Convert(slot.gameCopy->view.Get(),slot.headerCopy->view.Get(),slot.planeY.Get(),slot.planeUV.Get(),width,height,computeHeaderHeight);
  slot.computeValue=++computeCounter;Check(SUCCEEDED(computeContext4->Signal(convertedFence.Get(),slot.computeValue)),"Signal compute conversion failed");computeContext->Flush();slot.converted=true;computeFrames++;computeMs+=Ms(start);
}
void FinishCompute(){
  if(!computeEvent.value)return;auto target=convertedFence;uint64_t value=computeCounter;
  if(computeInPlace){target=fence;value=++fenceCounter;if(FAILED(context4->Signal(target.Get(),value))){if(failure.empty())failure="Signal in-place closure failed";return;}immediate->Flush();}
  else if(!value||!target)return;
  const auto completed=target->GetCompletedValue();if(completed>=value&&completed!=UINT64_MAX)return;
  if(completed==UINT64_MAX||FAILED(target->SetEventOnCompletion(value,computeEvent.value))||WaitForSingleObject(computeEvent.value,30000)!=WAIT_OBJECT_0){if(failure.empty())failure="Compute completion failed during closure";}
}
void DestroyCompute(){if(copyReadFbo){P<PFNGLDELETEFRAMEBUFFERSPROC>("glDeleteFramebuffers")(1,&copyReadFbo);copyReadFbo=0;}}
