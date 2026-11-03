// Codec-only benchmark over a real NV12 frame sequence. It deliberately does
// not measure game rendering and must not be reported as replay throughput.
#include <cstdint>
extern "C" {
#include <x264.h>
}
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
int main(int argc,char**argv){
  if(argc<4){fprintf(stderr,"Usage: bench frames.nv12 threads crf|lossless|fast [output.h264]\n");return 1;}
  const int w=1920,h=1080,threads=atoi(argv[2]);const size_t frameBytes=(size_t)w*h*3/2;int fd=open(argv[1],O_RDONLY);struct stat st;
  if(fd<0||fstat(fd,&st)||st.st_size%frameBytes){fprintf(stderr,"Invalid NV12 input\n");return 1;}
  auto data=(uint8_t*)mmap(nullptr,st.st_size,PROT_READ,MAP_PRIVATE,fd,0);if(data==MAP_FAILED)return 1;
  // Keep disk page faults outside the codec timing, like reused GPU surfaces.
  volatile unsigned checksum=0;for(size_t i=0;i<(size_t)st.st_size;i+=4096)checksum+=data[i];
  x264_param_t p;x264_param_default_preset(&p,"ultrafast",nullptr);p.i_width=w;p.i_height=h;p.i_csp=X264_CSP_NV12;p.i_fps_num=60;p.i_fps_den=1;p.i_timebase_num=1;p.i_timebase_den=60;p.b_vfr_input=0;p.i_threads=threads;p.i_bframe=0;p.i_keyint_max=120;p.i_log_level=X264_LOG_ERROR;
  const bool lossless=argv[3][0]=='l',fast=argv[3][0]=='f',motion=argv[3][0]=='m',nodeblock=argv[3][0]=='n';p.rc.i_rc_method=lossless?X264_RC_CQP:X264_RC_CRF;p.rc.i_qp_constant=0;p.rc.f_rf_constant=18;
  if(argv[3][0]=='c'&&argv[3][3])p.rc.f_rf_constant=atof(argv[3]+3);
  if(fast||nodeblock)p.b_deblocking_filter=0;if(fast||motion)p.analyse.i_me_range=4;
  if(argv[3][0]=='s')p.b_sliced_threads=1;
  x264_param_apply_profile(&p,lossless?"high444":"high");auto encoder=x264_encoder_open(&p);if(!encoder)return 1;
  FILE*file=argc>4?fopen(argv[4],"wb"):nullptr;if(argc>4&&!file)return 1;
  size_t bytes=0,frames=st.st_size/frameBytes,written=0;
  const auto start=std::chrono::steady_clock::now();
  auto save=[&](x264_nal_t*nals,int count,int size){if(size<0)abort();bytes+=size;if(size){written++;if(file)for(int j=0;j<count;j++)if(fwrite(nals[j].p_payload,1,nals[j].i_payload,file)!=(size_t)nals[j].i_payload)abort();}};
  for(size_t i=0;i<frames;i++){x264_picture_t in,out;x264_picture_init(&in);x264_picture_init(&out);in.img.i_csp=X264_CSP_NV12;in.img.i_plane=2;in.img.i_stride[0]=in.img.i_stride[1]=w;in.img.plane[0]=data+i*frameBytes;in.img.plane[1]=in.img.plane[0]+w*h;in.i_pts=i;x264_nal_t*nals;int count;const int n=x264_encoder_encode(encoder,&nals,&count,&in,&out);save(nals,count,n);}
  while(x264_encoder_delayed_frames(encoder)){x264_picture_t out;x264_picture_init(&out);x264_nal_t*nals;int count;const int n=x264_encoder_encode(encoder,&nals,&count,nullptr,&out);save(nals,count,n);}
  const double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  printf("{\"mode\":\"%s\",\"threads\":%d,\"frames\":%zu,\"written\":%zu,\"seconds\":%.6f,\"fps\":%.3f,\"bytes\":%zu}\n",argv[3],threads,frames,written,seconds,frames/seconds,bytes);
  if(file)fclose(file);x264_encoder_close(encoder);munmap(data,st.st_size);close(fd);return written==frames?0:1;
}
