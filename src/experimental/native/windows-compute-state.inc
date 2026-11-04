// Preserve all D3D11 pipeline state when temporarily sharing ANGLE's immediate
// context. Restoring it also preserves ANGLE's cached native-state assumptions.
static ComPtr<ID3DDeviceContextState> CreateComputeState(ID3D11Device*device){
  ComPtr<ID3D11Device1>device1;Check(SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&device1))),"D3D11 context-state interface unavailable");
  const D3D_FEATURE_LEVEL levels[]={D3D_FEATURE_LEVEL_11_1,D3D_FEATURE_LEVEL_11_0};
  const UINT flags=device->GetCreationFlags()&D3D11_CREATE_DEVICE_SINGLETHREADED?D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED:0;
  ComPtr<ID3DDeviceContextState>state;Check(SUCCEEDED(device1->CreateDeviceContextState(flags,levels,2,D3D11_SDK_VERSION,__uuidof(ID3D11Device),nullptr,&state)),"Create private compute context state failed");return state;
}
struct ComputeStateScope{
  ComPtr<ID3D11DeviceContext1>context;ComPtr<ID3DDeviceContextState>previous;
  ComputeStateScope(ID3D11DeviceContext*ctx,ID3DDeviceContextState*state){
    Check(SUCCEEDED(ctx->QueryInterface(IID_PPV_ARGS(&context))),"D3D11 context-state swap unavailable");context->SwapDeviceContextState(state,&previous);Check((bool)previous,"Original D3D11 context state unavailable");
  }
  ~ComputeStateScope(){if(previous)context->SwapDeviceContextState(previous.Get(),nullptr);}
};
