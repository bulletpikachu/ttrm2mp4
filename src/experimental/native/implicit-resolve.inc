static napi_value ConfigureImplicitResolve(napi_env env,napi_callback_info info){
  if(!getProc||!PauseGPU())return Fail(env,"Implicit resolve requires an idle ANGLE context");
  size_t argc=8;napi_value a[8];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);int v[8];if(argc!=8)return Fail(env,"Expected framebuffer,texture,samples,width,height,depthStencil,format,attachment");
  for(int i=0;i<8;i++)if(napi_get_value_int32(env,a[i],&v[i])!=napi_ok)return Fail(env,"Invalid implicit resolve argument");
  if(v[0]<=0||v[1]<=0||v[2]<1||v[3]<1||v[4]<1)return Fail(env,"Invalid implicit resolve storage");
  auto request=Proc<PFNGLREQUESTEXTENSIONANGLEPROC>("glRequestExtensionANGLE");
  auto attach=Proc<PFNGLFRAMEBUFFERTEXTURE2DMULTISAMPLEEXTPROC>("glFramebufferTexture2DMultisampleEXT");
  auto storage=Proc<PFNGLRENDERBUFFERSTORAGEMULTISAMPLEEXTPROC>("glRenderbufferStorageMultisampleEXT");
  if(!request||!attach||!storage)return Fail(env,"Multisampled render-to-texture entry points are unavailable");
  request("GL_EXT_multisampled_render_to_texture");
  GLint read=0,draw=0,rbo=0;auto get=Proc<PFNGLGETINTEGERVPROC>("glGetIntegerv");get(GL_READ_FRAMEBUFFER_BINDING,&read);get(GL_DRAW_FRAMEBUFFER_BINDING,&draw);get(GL_RENDERBUFFER_BINDING,&rbo);
  auto bind=Proc<PFNGLBINDFRAMEBUFFERPROC>("glBindFramebuffer");auto bindRB=Proc<PFNGLBINDRENDERBUFFERPROC>("glBindRenderbuffer");
  bind(GL_FRAMEBUFFER,v[0]);attach(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,v[1],0,v[2]);
  if(v[5]){bindRB(GL_RENDERBUFFER,v[5]);storage(GL_RENDERBUFFER,v[2],v[6],v[3],v[4]);Proc<PFNGLFRAMEBUFFERRENDERBUFFERPROC>("glFramebufferRenderbuffer")(GL_FRAMEBUFFER,v[7],GL_RENDERBUFFER,v[5]);}
  GLenum status=Proc<PFNGLCHECKFRAMEBUFFERSTATUSPROC>("glCheckFramebufferStatus")(GL_FRAMEBUFFER);GLint samples=0;get(GL_SAMPLES,&samples);GLenum error=Proc<PFNGLGETERRORPROC>("glGetError")();
  bind(GL_READ_FRAMEBUFFER,read);bind(GL_DRAW_FRAMEBUFFER,draw);bindRB(GL_RENDERBUFFER,rbo);
  if(status!=GL_FRAMEBUFFER_COMPLETE||samples!=v[2]||error!=GL_NO_ERROR)return Fail(env,"Implicit resolve did not preserve a complete framebuffer and sample count");
  napi_value out;napi_create_object(env,&out);napi_set_named_property(env,out,"samples",Number(env,samples));napi_set_named_property(env,out,"framebufferStatus",Number(env,status));return out;
}
