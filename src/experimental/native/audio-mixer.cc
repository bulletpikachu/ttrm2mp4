#include <node_api.h>
#include <algorithm>
#include <cstdint>
#include <thread>
#include <vector>
#include <cmath>
struct Effect {float*left;float*right;size_t length;int64_t start,end,eventStart;double rate,offset,gain,a,b;int kind;};
static napi_value Get(napi_env e,napi_value object,const char*key){napi_value v;napi_get_named_property(e,object,key,&v);return v;}
static double Number(napi_env e,napi_value o,const char*key){double value=0;napi_get_value_double(e,Get(e,o,key),&value);return value;}
static float* Samples(napi_env env,napi_value v,size_t*length){napi_typedarray_type type;void*data=nullptr;napi_value buffer;size_t offset;if(napi_get_typedarray_info(env,v,&type,length,&data,&buffer,&offset)!=napi_ok||type!=napi_float32_array)return nullptr;return(float*)data;}
static napi_value Mix(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(argc!=1){napi_throw_error(env,nullptr,"Expected mixer settings");return nullptr;}
  auto settings=args[0];size_t nl=0,nr=0;float*left=Samples(env,Get(env,settings,"left"),&nl),*right=Samples(env,Get(env,settings,"right"),&nr);
  int64_t first=(int64_t)Number(env,settings,"first"),last=(int64_t)Number(env,settings,"last");
  if(!left||!right||first<0||last<first||last>(int64_t)std::min(nl,nr)){napi_throw_error(env,nullptr,"Invalid mixer output range");return nullptr;}
  auto list=Get(env,settings,"effects");uint32_t count=0;napi_get_array_length(env,list,&count);std::vector<Effect>effects;effects.reserve(count);
  for(uint32_t i=0;i<count;i++){
    napi_value item;napi_get_element(env,list,i,&item);Effect v;size_t other;
    v.left=Samples(env,Get(env,item,"left"),&v.length);v.right=Samples(env,Get(env,item,"right"),&other);
    v.start=(int64_t)Number(env,item,"start");v.end=(int64_t)Number(env,item,"end");v.eventStart=(int64_t)Number(env,item,"eventStart");v.rate=Number(env,item,"rate");v.offset=Number(env,item,"offset");v.gain=Number(env,item,"gain");v.a=Number(env,item,"a");v.b=Number(env,item,"b");v.kind=(int)Number(env,item,"kind");
    if(!v.left||!v.right||other!=v.length||!std::isfinite(v.rate)||!std::isfinite(v.offset)){napi_throw_error(env,nullptr,"Invalid mixer source");return nullptr;}effects.push_back(v);
  }
  int threads=std::min<int64_t>(8,std::max<int64_t>(1,(last-first+47999)/48000));std::vector<std::thread>workers;
  for(int worker=0;worker<threads;worker++)workers.emplace_back([&,worker]{
    const int64_t segmentFirst=first+(last-first)*worker/threads,segmentLast=first+(last-first)*(worker+1)/threads;
    for(const auto&effect:effects){
      const int64_t start=std::max(segmentFirst,effect.start),end=std::min(segmentLast,effect.end);
      for(int64_t frame=start;frame<end;frame++){
        const double pos=effect.offset+(frame-effect.eventStart)*effect.rate;const int64_t index=(int64_t)std::floor(pos);const double frac=pos-index;
        if(index<0||index+1>=(int64_t)effect.length)break;
        const double l=(double)effect.left[index]+((double)effect.left[index+1]-(double)effect.left[index])*frac;
        const double r=(double)effect.right[index]+((double)effect.right[index+1]-(double)effect.right[index])*frac;
        if(effect.kind==0){left[frame]=(float)((double)left[frame]+l*effect.gain*effect.a);right[frame]=(float)((double)right[frame]+l*effect.gain*effect.b);}
        else if(effect.kind==1){left[frame]=(float)((double)left[frame]+effect.gain*(l+r*effect.a));right[frame]=(float)((double)right[frame]+effect.gain*r*effect.b);}
        else {left[frame]=(float)((double)left[frame]+effect.gain*l*effect.a);right[frame]=(float)((double)right[frame]+effect.gain*(r+l*effect.b));}
      }
    }
  });
  for(auto&worker:workers)worker.join();napi_value out;napi_get_undefined(env,&out);return out;
}
static napi_value Interleave(napi_env env,napi_callback_info info){
  size_t argc=4;napi_value args[4];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  size_t nl=0,nr=0;int64_t first=0,last=0;
  float*left=argc==4?Samples(env,args[0],&nl):nullptr,*right=argc==4?Samples(env,args[1],&nr):nullptr;
  if(!left||!right||napi_get_value_int64(env,args[2],&first)!=napi_ok||napi_get_value_int64(env,args[3],&last)!=napi_ok||first<0||last<first||last>(int64_t)std::min(nl,nr)||last-first>268435456){napi_throw_error(env,nullptr,"Invalid PCM interleave range");return nullptr;}
  float*out=nullptr;napi_value result;
  if(napi_create_buffer(env,(size_t)(last-first)*8,(void**)&out,&result)!=napi_ok)return nullptr;
  for(int64_t i=first;i<last;i++){out[(i-first)*2]=left[i];out[(i-first)*2+1]=right[i];}
  return result;
}
static napi_value Init(napi_env e,napi_value exports){for(auto item:{std::pair<const char*,napi_callback>{"mix",Mix},{"interleave",Interleave}}){napi_value fn;napi_create_function(e,item.first,NAPI_AUTO_LENGTH,item.second,nullptr,&fn);napi_set_named_property(e,exports,item.first,fn);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
