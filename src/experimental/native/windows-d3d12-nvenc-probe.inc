#include <nvEncodeAPI.h>
#include <vector>
static void NVCheck12(NVENCSTATUS status,const char*where){if(status!=NV_ENC_SUCCESS)throw std::runtime_error(std::string(where)+": NVENC status "+std::to_string((int)status));}
static std::vector<uint8_t> EncodeD3D12Probe(ID3D12Device*device,ID3D12Resource*texture,ID3D12Fence*inputFence,uint64_t value,bool nv12,int width=256,int height=256){
  struct State{
    HMODULE library=nullptr;NV_ENCODE_API_FUNCTION_LIST api{};void*session=nullptr;
    NV_ENC_REGISTERED_PTR inputRegistration=nullptr,outputRegistration=nullptr;NV_ENC_INPUT_PTR input=nullptr,output=nullptr;
    NV_ENC_OUTPUT_RESOURCE_D3D12 outputResource{};ComPtr<ID3D12Resource>buffer;ComPtr<ID3D12Fence>done;Handle event;bool locked=false,submitted=false,flushed=false;
    ~State(){
      if(session){
        if(submitted&&!flushed){NV_ENC_PIC_PARAMS eos{};eos.version=NV_ENC_PIC_PARAMS_VER;eos.encodePicFlags=NV_ENC_PIC_FLAG_EOS;api.nvEncEncodePicture(session,&eos);}
        if(submitted&&done&&done->GetCompletedValue()<1&&event.h&&SUCCEEDED(done->SetEventOnCompletion(1,event.h)))WaitForSingleObject(event.h,10000);
        if(locked)api.nvEncUnlockBitstream(session,&outputResource);
        if(output)api.nvEncUnmapInputResource(session,output);if(input)api.nvEncUnmapInputResource(session,input);
        if(outputRegistration)api.nvEncUnregisterResource(session,outputRegistration);if(inputRegistration)api.nvEncUnregisterResource(session,inputRegistration);
        api.nvEncDestroyEncoder(session);
      }
      if(library)FreeLibrary(library);
    }
  }s;
  s.library=LoadLibraryExW(L"nvEncodeAPI64.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);Check(s.library,"Load NVENC driver");
  auto create=(decltype(&NvEncodeAPICreateInstance))GetProcAddress(s.library,"NvEncodeAPICreateInstance");Check(create,"Find NVENC interface");s.api.version=NV_ENCODE_API_FUNCTION_LIST_VER;NVCheck12(create(&s.api),"Create NVENC interface");
  NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};open.version=NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;open.device=device;open.deviceType=NV_ENC_DEVICE_TYPE_DIRECTX;open.apiVersion=NVENCAPI_VERSION;NVCheck12(s.api.nvEncOpenEncodeSessionEx(&open,&s.session),"Open D3D12 NVENC session");
  NV_ENC_PRESET_CONFIG preset{};preset.version=NV_ENC_PRESET_CONFIG_VER;preset.presetCfg.version=NV_ENC_CONFIG_VER;NVCheck12(s.api.nvEncGetEncodePresetConfigEx(s.session,NV_ENC_CODEC_H264_GUID,NV_ENC_PRESET_P1_GUID,NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,&preset),"Get D3D12 NVENC preset");
  NV_ENC_CONFIG config=preset.presetCfg;config.profileGUID=NV_ENC_H264_PROFILE_HIGH_GUID;config.gopLength=120;config.frameIntervalP=1;config.rcParams.rateControlMode=NV_ENC_PARAMS_RC_CONSTQP;config.rcParams.constQP={18,18,18};config.encodeCodecConfig.h264Config.entropyCodingMode=NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;
  auto&vui=config.encodeCodecConfig.h264Config.h264VUIParameters;vui.videoSignalTypePresentFlag=1;vui.videoFormat=NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;vui.colourDescriptionPresentFlag=1;vui.colourPrimaries=NV_ENC_VUI_COLOR_PRIMARIES_BT709;vui.transferCharacteristics=NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SRGB;vui.colourMatrix=nv12?NV_ENC_VUI_MATRIX_COEFFS_BT709:NV_ENC_VUI_MATRIX_COEFFS_SMPTE170M;
  NV_ENC_INITIALIZE_PARAMS init{};init.version=NV_ENC_INITIALIZE_PARAMS_VER;init.encodeGUID=NV_ENC_CODEC_H264_GUID;init.presetGUID=NV_ENC_PRESET_P1_GUID;init.tuningInfo=NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;init.encodeWidth=init.darWidth=init.maxEncodeWidth=width;init.encodeHeight=init.darHeight=init.maxEncodeHeight=height;init.frameRateNum=60;init.frameRateDen=1;init.enablePTD=1;init.bufferFormat=nv12?NV_ENC_BUFFER_FORMAT_NV12:NV_ENC_BUFFER_FORMAT_ARGB;init.encodeConfig=&config;NVCheck12(s.api.nvEncInitializeEncoder(s.session,&init),"Initialize D3D12 H264 encoder");
  D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_READBACK;D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;desc.Width=(UINT64)width*height*4;desc.Height=desc.DepthOrArraySize=desc.MipLevels=1;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;HR(device->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&s.buffer)),"Create D3D12 NVENC output buffer");
  NV_ENC_FENCE_POINT_D3D12 registrationFence{};registrationFence.version=NV_ENC_FENCE_POINT_D3D12_VER;registrationFence.pFence=inputFence;registrationFence.waitValue=value;registrationFence.bWait=1;
  NV_ENC_REGISTER_RESOURCE reg{};reg.version=NV_ENC_REGISTER_RESOURCE_VER;reg.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;reg.width=width;reg.height=height;reg.resourceToRegister=texture;reg.bufferFormat=nv12?NV_ENC_BUFFER_FORMAT_NV12:NV_ENC_BUFFER_FORMAT_ARGB;reg.bufferUsage=NV_ENC_INPUT_IMAGE;reg.pInputFencePoint=&registrationFence;NVCheck12(s.api.nvEncRegisterResource(s.session,&reg),"Register shared D3D12 ANGLE texture");s.inputRegistration=reg.registeredResource;
  reg={};reg.version=NV_ENC_REGISTER_RESOURCE_VER;reg.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;reg.width=width*height*4;reg.height=1;reg.resourceToRegister=s.buffer.Get();reg.bufferFormat=NV_ENC_BUFFER_FORMAT_U8;reg.bufferUsage=NV_ENC_OUTPUT_BITSTREAM;NVCheck12(s.api.nvEncRegisterResource(s.session,&reg),"Register D3D12 output resource");s.outputRegistration=reg.registeredResource;
  NV_ENC_MAP_INPUT_RESOURCE map{};map.version=NV_ENC_MAP_INPUT_RESOURCE_VER;map.registeredResource=s.inputRegistration;NVCheck12(s.api.nvEncMapInputResource(s.session,&map),"Map D3D12 input resource");s.input=map.mappedResource;
  map={};map.version=NV_ENC_MAP_INPUT_RESOURCE_VER;map.registeredResource=s.outputRegistration;NVCheck12(s.api.nvEncMapInputResource(s.session,&map),"Map D3D12 output resource");s.output=map.mappedResource;
  HR(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&s.done)),"Create NVENC output fence");s.event.h=CreateEventW(nullptr,FALSE,FALSE,nullptr);Check(s.event.h,"Create NVENC output event");
  NV_ENC_INPUT_RESOURCE_D3D12 input{};input.version=NV_ENC_INPUT_RESOURCE_D3D12_VER;input.pInputBuffer=s.input;input.inputFencePoint=registrationFence;
  s.outputResource.version=NV_ENC_OUTPUT_RESOURCE_D3D12_VER;s.outputResource.pOutputBuffer=s.output;s.outputResource.outputFencePoint.version=NV_ENC_FENCE_POINT_D3D12_VER;s.outputResource.outputFencePoint.pFence=s.done.Get();s.outputResource.outputFencePoint.signalValue=1;s.outputResource.outputFencePoint.bSignal=1;
  NV_ENC_PIC_PARAMS picture{};picture.version=NV_ENC_PIC_PARAMS_VER;picture.inputBuffer=&input;picture.outputBitstream=&s.outputResource;picture.bufferFmt=nv12?NV_ENC_BUFFER_FORMAT_NV12:NV_ENC_BUFFER_FORMAT_ARGB;picture.inputWidth=width;picture.inputHeight=height;picture.pictureStruct=NV_ENC_PIC_STRUCT_FRAME;picture.encodePicFlags=NV_ENC_PIC_FLAG_FORCEIDR|NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;picture.inputTimeStamp=7;picture.inputDuration=1;NVCheck12(s.api.nvEncEncodePicture(s.session,&picture),"Encode D3D12 ANGLE texture");s.submitted=true;
  NV_ENC_PIC_PARAMS eos{};eos.version=NV_ENC_PIC_PARAMS_VER;eos.encodePicFlags=NV_ENC_PIC_FLAG_EOS;NVCheck12(s.api.nvEncEncodePicture(s.session,&eos),"Flush D3D12 encoder");s.flushed=true;
  HR(s.done->SetEventOnCompletion(1,s.event.h),"Wait for NVENC output fence");Check(WaitForSingleObject(s.event.h,10000)==WAIT_OBJECT_0,"NVENC D3D12 output timed out");
  NV_ENC_LOCK_BITSTREAM lock{};lock.version=NV_ENC_LOCK_BITSTREAM_VER;lock.outputBitstream=&s.outputResource;NVCheck12(s.api.nvEncLockBitstream(s.session,&lock),"Lock D3D12 H264 output");s.locked=true;Check(lock.bitstreamSizeInBytes>0&&lock.outputTimeStamp==7,"D3D12 encoded frame identity/size mismatch");
  auto bytes=(const uint8_t*)lock.bitstreamBufferPtr;return std::vector<uint8_t>(bytes,bytes+lock.bitstreamSizeInBytes);
}
