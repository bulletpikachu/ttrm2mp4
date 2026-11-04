// Capability probe only: a separate D3D11 device writes both NV12 planes through
// UAVs, then D3D12 NVENC waits on its shared GPU fence. No input CPU readback/wait.
static napi_value ProbeComputeNV12(napi_env env,napi_callback_info info){
  napi_value result;napi_create_object(env,&result);
  try{
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);void*p=nullptr;Check(n==1&&napi_get_value_external(env,args[0],&p)==napi_ok&&p,"Expected ANGLE procedure pointer");proc=(PFNEGLGETPROCADDRESSPROC)p;
    const auto display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();EGLAttrib e=0,d=0;
    Check(P<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&e),"Query EGL device");Check(P<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)e,EGL_D3D11_DEVICE_ANGLE,&d),"Query ANGLE D3D11 device");
    auto angle=reinterpret_cast<ID3D11Device*>(d);ComPtr<IDXGIDevice>dxgi;ComPtr<IDXGIAdapter>adapter;HR(angle->QueryInterface(IID_PPV_ARGS(&dxgi)),"Query ANGLE adapter");HR(dxgi->GetAdapter(&adapter),"Get ANGLE adapter");
    ComPtr<ID3D12Device>device12;HR(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&device12)),"Create D3D12 device");
    ComPtr<ID3D11Device>compute;ComPtr<ID3D11DeviceContext>context;
    HR(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&compute,nullptr,&context),"Create separate compute device");Check(compute.Get()!=angle,"Compute device must be separate from ANGLE");
    D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;
    D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;desc.Width=desc.Height=256;desc.DepthOrArraySize=desc.MipLevels=1;desc.Format=DXGI_FORMAT_NV12;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_UNKNOWN;desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS|D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
    ComPtr<ID3D12Resource>texture12;HR(device12->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&texture12)),"Create shared NV12 UAV texture");
    Handle shared;HR(device12->CreateSharedHandle(texture12.Get(),nullptr,GENERIC_ALL,nullptr,&shared.h),"Share NV12 compute texture");
    ComPtr<ID3D11Device1>compute1,angle1;HR(compute.As(&compute1),"Query compute D3D11.1");HR(angle->QueryInterface(IID_PPV_ARGS(&angle1)),"Query ANGLE D3D11.1");
    ComPtr<ID3D11Texture2D>texture,angleTexture;HR(compute1->OpenSharedResource1(shared.h,IID_PPV_ARGS(&texture)),"Open compute NV12 alias");HR(angle1->OpenSharedResource1(shared.h,IID_PPV_ARGS(&angleTexture)),"Open ANGLE NV12 alias");
    ComPtr<ID3D11Device3>compute3;HR(compute.As(&compute3),"Query compute D3D11.3");
    ComPtr<ID3D11UnorderedAccessView1>planes[2];
    for(UINT plane=0;plane<2;plane++){
      D3D11_UNORDERED_ACCESS_VIEW_DESC1 view{};view.Format=plane?DXGI_FORMAT_R8G8_UNORM:DXGI_FORMAT_R8_UNORM;view.ViewDimension=D3D11_UAV_DIMENSION_TEXTURE2D;view.Texture2D.PlaneSlice=plane;
      HR(compute3->CreateUnorderedAccessView1(texture.Get(),&view,&planes[plane]),plane?"Create NV12 UV-plane UAV":"Create NV12 Y-plane UAV");
      const float color[4]={plane?.5f:.25f,plane?.75f:0.f,0.f,1.f};context->ClearUnorderedAccessViewFloat(planes[plane].Get(),color);
    }
    ComPtr<ID3D11Device5>compute5;ComPtr<ID3D11DeviceContext4>context4;HR(compute.As(&compute5),"Query compute fence device");HR(context.As(&context4),"Query compute fence context");
    ComPtr<ID3D11Fence>fence11;HR(compute5->CreateFence(0,D3D11_FENCE_FLAG_SHARED,IID_PPV_ARGS(&fence11)),"Create compute completion fence");Handle fenceHandle;HR(fence11->CreateSharedHandle(nullptr,GENERIC_ALL,nullptr,&fenceHandle.h),"Share compute fence");
    ComPtr<ID3D12Fence>fence12;HR(device12->OpenSharedHandle(fenceHandle.h,IID_PPV_ARGS(&fence12)),"Open compute fence in NVENC device");HR(context4->Signal(fence11.Get(),1),"Signal compute writes");context->Flush();
    const auto encoded=EncodeD3D12Probe(device12.Get(),texture12.Get(),fence12.Get(),1,true);
    napi_value video;napi_create_buffer_copy(env,encoded.size(),encoded.data(),nullptr,&video);Set(env,result,"h264",video);
    Bool(env,result,"separateComputeDevice",true);Bool(env,result,"nv12PlaneUAVs",true);Bool(env,result,"gpuInputFence",true);Bool(env,result,"passed",true);
  }catch(const std::exception&error){Bool(env,result,"passed",false);Set(env,result,"error",Text(env,error.what()));}
  return result;
}
