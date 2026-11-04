// Included inside AsyncEncoder. The GL renderer still uses ANGLE's D3D11
// device; NVENC owns the D3D12 aliases only between submit and output completion.
struct SharedHandle12{HANDLE value=nullptr;~SharedHandle12(){if(value)CloseHandle(value);}};
void InitializeD3D12(){
  ComPtr<IDXGIDevice>dxgi;ComPtr<IDXGIAdapter>adapter;
  Check(SUCCEEDED(device.As(&dxgi))&&SUCCEEDED(dxgi->GetAdapter(&adapter)),"Query ANGLE adapter for D3D12 failed");
  Check(SUCCEEDED(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&device12))),"Create encoder D3D12 device failed");
  SharedHandle12 handle;Check(SUCCEEDED(fence->CreateSharedHandle(nullptr,GENERIC_ALL,nullptr,&handle.value)),"Share ANGLE completion fence failed");
  Check(SUCCEEDED(device12->OpenSharedHandle(handle.value,IID_PPV_ARGS(&inputFence12))),"Open ANGLE completion fence in D3D12 failed");
}
void AllocateD3D12(Slot&slot){
  D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;
  D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;desc.Width=width;desc.Height=height;desc.DepthOrArraySize=desc.MipLevels=1;desc.Format=nv12?DXGI_FORMAT_NV12:DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_UNKNOWN;desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
  if(computeConversion)desc.Flags|=D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
  Check(SUCCEEDED(device12->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&slot.texture12))),"Allocate shared D3D12 encoder texture failed");
  SharedHandle12 handle;Check(SUCCEEDED(device12->CreateSharedHandle(slot.texture12.Get(),nullptr,GENERIC_ALL,nullptr,&handle.value)),"Share encoder D3D12 texture failed");
  ComPtr<ID3D11Device1>device1;Check(SUCCEEDED(device.As(&device1)),"Query ANGLE D3D11.1 device failed");
  Check(SUCCEEDED(device1->OpenSharedResource1(handle.value,IID_PPV_ARGS(&slot.texture))),"Open encoder texture in ANGLE failed");
}
void OpenD3D12Slot(Slot&slot){
  // Fresh completion fences per segment prevent a previous segment's completed
  // value from making a reused slot look ready before its new frame is encoded.
  slot.outputValue=0;slot.submitted12=false;
  Check(SUCCEEDED(device12->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&slot.done12))),"Create encoder output fence failed");
  slot.event=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(slot.event,"Create D3D12 output event failed");
  D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_READBACK;
  D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;desc.Width=(UINT64)width*height*4;desc.Height=desc.DepthOrArraySize=desc.MipLevels=1;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  Check(SUCCEEDED(device12->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&slot.output12))),"Create D3D12 bitstream buffer failed");
  NV_ENC_FENCE_POINT_D3D12 initial{};initial.version=NV_ENC_FENCE_POINT_D3D12_VER;initial.pFence=computeConversion&&!computeInPlace?convertedFence12.Get():inputFence12.Get();initial.bWait=1;
  NV_ENC_REGISTER_RESOURCE reg{};reg.version=NV_ENC_REGISTER_RESOURCE_VER;reg.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;reg.width=width;reg.height=height;reg.resourceToRegister=slot.texture12.Get();reg.bufferFormat=nv12?NV_ENC_BUFFER_FORMAT_NV12:NV_ENC_BUFFER_FORMAT_ARGB;reg.bufferUsage=NV_ENC_INPUT_IMAGE;reg.pInputFencePoint=&initial;
  NVCheck(api.nvEncRegisterResource(session,&reg),"Register pooled D3D12 input");slot.registered=reg.registeredResource;
  reg={};reg.version=NV_ENC_REGISTER_RESOURCE_VER;reg.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;reg.width=(uint32_t)desc.Width;reg.height=1;reg.resourceToRegister=slot.output12.Get();reg.bufferFormat=NV_ENC_BUFFER_FORMAT_U8;reg.bufferUsage=NV_ENC_OUTPUT_BITSTREAM;
  NVCheck(api.nvEncRegisterResource(session,&reg),"Register pooled D3D12 output");slot.outputRegistration=reg.registeredResource;
}
void WaitD3D12(Slot&slot){
  const auto value=slot.done12->GetCompletedValue();Check(value!=UINT64_MAX,"Encoder D3D12 device removed");
  if(value<slot.outputValue){Check(SUCCEEDED(slot.done12->SetEventOnCompletion(slot.outputValue,slot.event)),"Set D3D12 output completion failed");Check(WaitForSingleObject(slot.event,30000)==WAIT_OBJECT_0,"D3D12 encoder completion timed out");}
}
void SubmitD3D12(const Job&job){
  auto&slot=*slots[job.slot];Ready(slot);const auto start=Clock::now();
  if(computeConversion&&!computeInPlace)ComputeSlot(slot);
  Check(!computeInPlace||slot.converted,"In-place frame was not converted before publication");
  NV_ENC_MAP_INPUT_RESOURCE map{};map.version=NV_ENC_MAP_INPUT_RESOURCE_VER;map.registeredResource=slot.registered;NVCheck(api.nvEncMapInputResource(session,&map),"Map pooled D3D12 input");slot.input=map.mappedResource;
  const auto format=map.mappedBufferFmt;
  map={};map.version=NV_ENC_MAP_INPUT_RESOURCE_VER;map.registeredResource=slot.outputRegistration;NVCheck(api.nvEncMapInputResource(session,&map),"Map pooled D3D12 output");slot.output=map.mappedResource;
  slot.inputResource={};slot.inputResource.version=NV_ENC_INPUT_RESOURCE_D3D12_VER;slot.inputResource.pInputBuffer=slot.input;
  auto&ready=slot.inputResource.inputFencePoint;ready.version=NV_ENC_FENCE_POINT_D3D12_VER;ready.pFence=computeConversion&&!computeInPlace?convertedFence12.Get():inputFence12.Get();ready.waitValue=computeConversion&&!computeInPlace?slot.computeValue:slot.fenceValue;ready.bWait=1;
  slot.outputResource={};slot.outputResource.version=NV_ENC_OUTPUT_RESOURCE_D3D12_VER;slot.outputResource.pOutputBuffer=slot.output;
  auto&done=slot.outputResource.outputFencePoint;done.version=NV_ENC_FENCE_POINT_D3D12_VER;done.pFence=slot.done12.Get();done.signalValue=++slot.outputValue;done.bSignal=1;
  NV_ENC_PIC_PARAMS pic{};pic.version=NV_ENC_PIC_PARAMS_VER;pic.inputBuffer=&slot.inputResource;pic.outputBitstream=&slot.outputResource;pic.bufferFmt=format;pic.inputWidth=width;pic.inputHeight=height;pic.pictureStruct=NV_ENC_PIC_STRUCT_FRAME;pic.inputTimeStamp=job.index;pic.inputDuration=1;
  if(job.key)pic.encodePicFlags=NV_ENC_PIC_FLAG_FORCEIDR|NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
  NVCheck(api.nvEncEncodePicture(session,&pic),"Submit pooled D3D12 frame");slot.submitted12=true;encodeSubmitMs+=Ms(start);
}
void DrainD3D12(const Job&job){
  auto&slot=*slots[job.slot];const auto wait=Clock::now();WaitD3D12(slot);encodeEventMs+=Ms(wait);const auto start=Clock::now();
  NV_ENC_LOCK_BITSTREAM lock{};lock.version=NV_ENC_LOCK_BITSTREAM_VER;lock.outputBitstream=&slot.outputResource;
  NVCheck(api.nvEncLockBitstream(session,&lock),"Lock pooled D3D12 bitstream");
  const bool correctTimestamp=lock.outputTimeStamp==(uint64_t)job.index;
  file.write((const char*)lock.bitstreamBufferPtr,lock.bitstreamSizeInBytes);bytes+=lock.bitstreamSizeInBytes;
  NVCheck(api.nvEncUnlockBitstream(session,&slot.outputResource),"Unlock pooled D3D12 bitstream");
  NVCheck(api.nvEncUnmapInputResource(session,slot.output),"Unmap completed D3D12 output");slot.output=nullptr;
  NVCheck(api.nvEncUnmapInputResource(session,slot.input),"Unmap completed D3D12 input");slot.input=nullptr;slot.submitted12=false;
  Check(correctTimestamp,"Native D3D12 encoded frame timestamp mismatch");Check(file.good(),"Native D3D12 H264 write failed");
  frames++;totalFrames++;bitstreamMs+=Ms(start);
  {std::lock_guard<std::mutex>lockGuard(mutex);free.push_back(job.slot);changed.notify_all();}
}
void CloseD3D12Slots(){
  // Also drain submitted GPU ownership on cancellation/error before releasing
  // mapped resources. Unsubmitted CPU jobs have never reached NVENC.
  if(!eosSubmitted){NV_ENC_PIC_PARAMS eos{};eos.version=NV_ENC_PIC_PARAMS_VER;eos.encodePicFlags=NV_ENC_PIC_FLAG_EOS;api.nvEncEncodePicture(session,&eos);}
  for(auto&slot:slots){
    if(slot->submitted12){try{WaitD3D12(*slot);}catch(const std::exception&error){if(failure.empty())failure=error.what();continue;}}
    if(slot->output){api.nvEncUnmapInputResource(session,slot->output);slot->output=nullptr;}
    if(slot->input){api.nvEncUnmapInputResource(session,slot->input);slot->input=nullptr;}
    if(slot->outputRegistration){api.nvEncUnregisterResource(session,slot->outputRegistration);slot->outputRegistration=nullptr;}
    if(slot->registered){api.nvEncUnregisterResource(session,slot->registered);slot->registered=nullptr;}
  }
  // Keep all COM resources and fence events alive through session destruction,
  // especially when a device failure prevented proving GPU completion above.
  api.nvEncDestroyEncoder(session);session=nullptr;
  for(auto&slot:slots){
    slot->input=slot->output=slot->registered=slot->outputRegistration=nullptr;
    if(slot->event){CloseHandle(slot->event);slot->event=nullptr;}
    slot->done12.Reset();slot->output12.Reset();slot->submitted12=false;
  }
}
