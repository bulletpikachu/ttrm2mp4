// Shared by the isolated validation probe and the future bounded replay path.
// Input coordinates match the existing GLES texelFetch conversion exactly.
struct NV12Compute{
  ComPtr<ID3D11DeviceContext>context;ComPtr<ID3D11ComputeShader>shader;ComPtr<ID3D11Buffer>constants;
  UINT lastWidth=0,lastHeight=0,lastHeaderHeight=0;
  NV12Compute(ID3D11Device*device,ID3D11DeviceContext*ctx):context(ctx){
    const char*source=R"HLSL(
Texture2D<float4> game : register(t0);
Texture2D<float4> header : register(t1);
RWTexture2D<unorm float> yPlane : register(u0);
RWTexture2D<unorm float2> uvPlane : register(u1);
cbuffer Dimensions : register(b0) { uint width; uint height; uint headerHeight; uint reserved; };
float3 rgb(uint2 p) {
  precise float3 c=game.Load(int3(p.x,height-1-p.y,0)).rgb;
  if(p.y<headerHeight){float4 h=header.Load(int3(p,0));c=c*(1.-h.a)+h.rgb*h.a;}
  return c;
}
float luma(float3 c){return (16.+219.*dot(c,float3(.2126,.7152,.0722)))/255.;}
[numthreads(8,8,1)] void main(uint3 id : SV_DispatchThreadID) {
  uint2 p=id.xy*2;if(p.x>=width||p.y>=height)return;
  precise float3 a=rgb(p),b=rgb(p+uint2(1,0)),c=rgb(p+uint2(0,1)),d=rgb(p+uint2(1,1));
  yPlane[p]=luma(a);yPlane[p+uint2(1,0)]=luma(b);yPlane[p+uint2(0,1)]=luma(c);yPlane[p+uint2(1,1)]=luma(d);
  precise float3 average=(a+b+c+d)*.25;
  uvPlane[id.xy]=float2((128.+224.*dot(average,float3(-.114572,-.385428,.5)))/255.,(128.+224.*dot(average,float3(.5,-.454153,-.045847)))/255.);
}
)HLSL";
    ComPtr<ID3DBlob>code,errors;const auto compiled=D3DCompile(source,strlen(source),"replay-nv12",nullptr,nullptr,"main","cs_5_0",D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&code,&errors);
    if(FAILED(compiled))throw std::runtime_error(std::string("Compile NV12 compute shader: ")+(errors?(const char*)errors->GetBufferPointer():"unknown error"));
    Check(SUCCEEDED(device->CreateComputeShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,&shader)),"Create NV12 compute shader failed");
    D3D11_BUFFER_DESC desc{};desc.ByteWidth=16;desc.Usage=D3D11_USAGE_DEFAULT;desc.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
    Check(SUCCEEDED(device->CreateBuffer(&desc,nullptr,&constants)),"Create NV12 compute constants failed");
  }
  void Convert(ID3D11ShaderResourceView*game,ID3D11ShaderResourceView*header,ID3D11UnorderedAccessView*y,ID3D11UnorderedAccessView*uv,UINT width,UINT height,UINT headerHeight){
    Check(width&&height&&!(width%2)&&!(height%2)&&headerHeight<=height,"Invalid NV12 compute dimensions");
    if(width!=lastWidth||height!=lastHeight||headerHeight!=lastHeaderHeight){const UINT dimensions[4]={width,height,headerHeight,0};context->UpdateSubresource(constants.Get(),0,nullptr,dimensions,0,0);lastWidth=width;lastHeight=height;lastHeaderHeight=headerHeight;}
    ID3D11ShaderResourceView*inputs[]={game,header};ID3D11UnorderedAccessView*outputs[]={y,uv};ID3D11Buffer*buffer=constants.Get();
    context->CSSetShader(shader.Get(),nullptr,0);context->CSSetConstantBuffers(0,1,&buffer);context->CSSetShaderResources(0,2,inputs);context->CSSetUnorderedAccessViews(0,2,outputs,nullptr);
    context->Dispatch((width/2+7)/8,(height/2+7)/8,1);
    ID3D11ShaderResourceView*emptyInputs[2]={};ID3D11UnorderedAccessView*emptyOutputs[2]={};context->CSSetShaderResources(0,2,emptyInputs);context->CSSetUnorderedAccessViews(0,2,emptyOutputs,nullptr);
  }
};
