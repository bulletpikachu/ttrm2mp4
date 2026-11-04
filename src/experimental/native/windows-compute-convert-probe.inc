static napi_value ProbeConvertNV12(napi_env env,napi_callback_info info){
  napi_value result;napi_create_object(env,&result);
  try{
    size_t n=6;napi_value args[6];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);void*p=nullptr;uint32_t width=0,height=0;void*gameBytes=nullptr,*headerBytes=nullptr;size_t gameLength=0,headerLength=0;bool sharedContext=false;
    Check((n==5||n==6)&&napi_get_value_external(env,args[0],&p)==napi_ok&&p,"Expected ANGLE procedure pointer");proc=(PFNEGLGETPROCADDRESSPROC)p;if(n==6)Check(napi_get_value_bool(env,args[5],&sharedContext)==napi_ok,"Expected shared-context mode flag");
    Check(napi_get_value_uint32(env,args[1],&width)==napi_ok&&napi_get_value_uint32(env,args[2],&height)==napi_ok&&width>=256&&height>=256&&width<=3840&&height<=2160&&!(width%2)&&!(height%2),"Invalid compute probe dimensions");
    Check(napi_get_buffer_info(env,args[3],&gameBytes,&gameLength)==napi_ok&&gameLength==(size_t)width*height*4,"Invalid game RGBA bytes");
    Check(napi_get_buffer_info(env,args[4],&headerBytes,&headerLength)==napi_ok&&headerLength&&headerLength%(width*4)==0&&headerLength<=(size_t)width*height*4,"Invalid header RGBA bytes");const UINT headerHeight=(UINT)(headerLength/(width*4));
    const auto display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();EGLAttrib e=0,d=0;Check(P<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&e),"Query EGL device");Check(P<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)e,EGL_D3D11_DEVICE_ANGLE,&d),"Query ANGLE device");
    auto angle=reinterpret_cast<ID3D11Device*>(d);ComPtr<IDXGIDevice>dxgi;ComPtr<IDXGIAdapter>adapter;HR(angle->QueryInterface(IID_PPV_ARGS(&dxgi)),"Query DXGI device");HR(dxgi->GetAdapter(&adapter),"Get ANGLE adapter");
    ComPtr<ID3D12Device>device12;HR(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&device12)),"Create NVENC D3D12 device");
    ComPtr<ID3D11Device>compute;ComPtr<ID3D11DeviceContext>context;
    if(sharedContext){compute=angle;angle->GetImmediateContext(&context);}else{HR(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&compute,nullptr,&context),"Create conversion device");Check(compute.Get()!=angle,"Conversion must use a separate device");}
    ComPtr<ID3D11Texture2D>inputs[2];ComPtr<ID3D11ShaderResourceView>views[2];
    for(int i=0;i<2;i++){
      D3D11_TEXTURE2D_DESC desc{};desc.Width=width;desc.Height=i?headerHeight:height;desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_IMMUTABLE;desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;
      D3D11_SUBRESOURCE_DATA data{};data.pSysMem=i?headerBytes:gameBytes;data.SysMemPitch=width*4;HR(compute->CreateTexture2D(&desc,&data,&inputs[i]),"Create conversion input");HR(compute->CreateShaderResourceView(inputs[i].Get(),nullptr,&views[i]),"Create conversion input view");
    }
    D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;D3D12_RESOURCE_DESC desc{};desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;desc.Width=width;desc.Height=height;desc.DepthOrArraySize=desc.MipLevels=1;desc.Format=DXGI_FORMAT_NV12;desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_UNKNOWN;desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS|D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
    ComPtr<ID3D12Resource>texture12;HR(device12->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&texture12)),"Create compute NV12 output");Handle shared;HR(device12->CreateSharedHandle(texture12.Get(),nullptr,GENERIC_ALL,nullptr,&shared.h),"Share conversion output");
    ComPtr<ID3D11Device1>compute1;ComPtr<ID3D11Device3>compute3;HR(compute.As(&compute1),"Query conversion D3D11.1");HR(compute.As(&compute3),"Query conversion D3D11.3");ComPtr<ID3D11Texture2D>output;HR(compute1->OpenSharedResource1(shared.h,IID_PPV_ARGS(&output)),"Open conversion NV12 output");
    ComPtr<ID3D11UnorderedAccessView1>planes[2];for(UINT i=0;i<2;i++){D3D11_UNORDERED_ACCESS_VIEW_DESC1 view{};view.Format=i?DXGI_FORMAT_R8G8_UNORM:DXGI_FORMAT_R8_UNORM;view.ViewDimension=D3D11_UAV_DIMENSION_TEXTURE2D;view.Texture2D.PlaneSlice=i;HR(compute3->CreateUnorderedAccessView1(output.Get(),&view,&planes[i]),"Create conversion output plane");}
    NV12Compute converter(compute.Get(),context.Get());
    if(sharedContext){P<PFNGLFLUSHPROC>("glFlush")();auto state=CreateComputeState(compute.Get());ComputeStateScope scope(context.Get(),state.Get());converter.Convert(views[0].Get(),views[1].Get(),planes[0].Get(),planes[1].Get(),width,height,headerHeight);}
    else converter.Convert(views[0].Get(),views[1].Get(),planes[0].Get(),planes[1].Get(),width,height,headerHeight);
    ComPtr<ID3D11Device5>compute5;ComPtr<ID3D11DeviceContext4>context4;HR(compute.As(&compute5),"Query conversion fence device");HR(context.As(&context4),"Query conversion fence context");ComPtr<ID3D11Fence>fence11;HR(compute5->CreateFence(0,D3D11_FENCE_FLAG_SHARED,IID_PPV_ARGS(&fence11)),"Create conversion fence");Handle fenceHandle;HR(fence11->CreateSharedHandle(nullptr,GENERIC_ALL,nullptr,&fenceHandle.h),"Share conversion fence");ComPtr<ID3D12Fence>fence12;HR(device12->OpenSharedHandle(fenceHandle.h,IID_PPV_ARGS(&fence12)),"Open conversion fence");
    HR(context4->Signal(fence11.Get(),1),"Signal conversion completion");context->Flush();
    // Encode before diagnostic readback: NVENC depends only on the GPU fence.
    const auto encoded=EncodeD3D12Probe(device12.Get(),texture12.Get(),fence12.Get(),1,true,width,height);
    D3D11_TEXTURE2D_DESC stagingDesc{};output->GetDesc(&stagingDesc);stagingDesc.Usage=D3D11_USAGE_STAGING;stagingDesc.BindFlags=stagingDesc.MiscFlags=0;stagingDesc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;ComPtr<ID3D11Texture2D>staging;HR(compute->CreateTexture2D(&stagingDesc,nullptr,&staging),"Create conversion diagnostic staging");context->CopyResource(staging.Get(),output.Get());D3D11_MAPPED_SUBRESOURCE mapped{};HR(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped),"Read converted NV12");
    std::vector<uint8_t>bytes((size_t)width*height*3/2);for(UINT row=0;row<height*3/2;row++)memcpy(bytes.data()+(size_t)row*width,(const uint8_t*)mapped.pData+(size_t)row*mapped.RowPitch,width);context->Unmap(staging.Get(),0);
    napi_value video,nv12;napi_create_buffer_copy(env,encoded.size(),encoded.data(),nullptr,&video);Set(env,result,"h264",video);napi_create_buffer_copy(env,bytes.size(),bytes.data(),nullptr,&nv12);Set(env,result,"nv12",nv12);
    Bool(env,result,"singleComputeDispatch",true);Bool(env,result,"gpuInputFence",true);Bool(env,result,"separateComputeDevice",!sharedContext);Bool(env,result,"sharedContextState",sharedContext);Bool(env,result,"passed",true);
  }catch(const std::exception&error){Bool(env,result,"passed",false);Set(env,result,"error",Text(env,error.what()));}
  return result;
}
