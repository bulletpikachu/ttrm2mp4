// Ordered GL batches and composition jobs on one driver thread. Synchronous
// WebGL queries pause that thread and explicitly return EGL ownership to JS.
struct GLDriver{
  struct Job{std::vector<uint8_t>bytes;std::function<void()>operation;};
  EGLDisplay display=EGL_NO_DISPLAY;EGLContext context=EGL_NO_CONTEXT;EGLSurface draw=EGL_NO_SURFACE,read=EGL_NO_SURFACE;
  std::mutex mutex;std::condition_variable changed;std::deque<Job>queue;std::thread worker;
  bool running=false,paused=false,ack=false,stopping=false;size_t queuedBytes=0;std::string failure;
  int64_t jobs=0,pauses=0;double workMs=0,cpuMs=0;
  bool Current(bool attach){return P<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,attach?draw:EGL_NO_SURFACE,attach?read:EGL_NO_SURFACE,attach?context:EGL_NO_CONTEXT)==EGL_TRUE;}
  static uint64_t CPU(){FILETIME create,exit,kernel,user;Check(GetThreadTimes(GetCurrentThread(),&create,&exit,&kernel,&user),"Cannot read GL thread CPU time");ULARGE_INTEGER a,b;a.LowPart=kernel.dwLowDateTime;a.HighPart=kernel.dwHighDateTime;b.LowPart=user.dwLowDateTime;b.HighPart=user.dwHighDateTime;return a.QuadPart+b.QuadPart;}
  void Start(){
    if(running)return;display=P<PFNEGLGETCURRENTDISPLAYPROC>("eglGetCurrentDisplay")();context=P<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")();draw=P<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_DRAW);read=P<PFNEGLGETCURRENTSURFACEPROC>("eglGetCurrentSurface")(EGL_READ);Check(display!=EGL_NO_DISPLAY&&context!=EGL_NO_CONTEXT,"Cannot start GL driver without native context");Check(Current(false),"Cannot release main GL context");paused=ack=stopping=false;failure.clear();running=true;
    try{worker=std::thread([this]{Work();});}catch(...){running=false;Current(true);throw;}
  }
  void ResumeLocked(){
    if(paused){Check(ack,"Cannot resume an unacknowledged GL pause");Check(P<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")()==context,"Native GL context switched during export");Check(Current(false),"Cannot return GL context to driver");paused=ack=false;}
  }
  void Push(Job job){
    std::unique_lock<std::mutex>lock(mutex);if(!failure.empty())throw std::runtime_error(failure);ResumeLocked();
    changed.wait(lock,[&]{return queuedBytes+job.bytes.size()<=67108864||!failure.empty();});if(!failure.empty())throw std::runtime_error(failure);queuedBytes+=job.bytes.size();queue.push_back(std::move(job));changed.notify_all();
  }
  void Execute(const uint8_t*data,size_t size){if(!running){RunCommands(data,size);return;}Job job;job.bytes.assign(data,data+size);Push(std::move(job));}
  void Operation(std::function<void()>operation){if(!running){operation();return;}Job job;job.operation=std::move(operation);Push(std::move(job));}
  void Pause(){
    if(!running)return;std::string error;
    {std::unique_lock<std::mutex>lock(mutex);if(paused&&ack){if(!failure.empty())throw std::runtime_error(failure);return;}paused=true;changed.notify_all();Check(changed.wait_for(lock,std::chrono::seconds(30),[&]{return ack;}),"GL driver pause timed out");error=failure;pauses++;}
    Check(Current(true),"Cannot restore main GL context");if(!error.empty())throw std::runtime_error(error);
  }
  void Stop(){
    if(!running)return;try{Pause();}catch(...){}
    {std::lock_guard<std::mutex>lock(mutex);stopping=true;changed.notify_all();}
    if(worker.joinable())worker.join();Current(true);running=false;
  }
  void Work(){
    bool attached=false;const auto cpuStart=CPU();try{for(;;){Job job;
      {std::unique_lock<std::mutex>lock(mutex);changed.wait(lock,[&]{return stopping||paused||!queue.empty();});
        if(queue.empty()&&paused){if(attached){Check(Current(false),"Cannot release driver GL context");attached=false;}ack=true;changed.notify_all();changed.wait(lock,[&]{return stopping||!paused||!queue.empty();});}
        if(queue.empty()&&stopping)break;if(queue.empty())continue;
        job=std::move(queue.front());queue.pop_front();queuedBytes-=job.bytes.size();changed.notify_all();}
      if(!attached){Check(Current(true),"Cannot bind driver GL context");attached=true;}
      const auto start=Clock::now();if(job.operation)job.operation();else RunCommands(job.bytes.data(),job.bytes.size());workMs+=Ms(start);jobs++;
    }}catch(const std::exception&error){std::lock_guard<std::mutex>lock(mutex);failure=error.what();queue.clear();queuedBytes=0;}
    if(attached)Current(false);cpuMs=(CPU()-cpuStart)/10000.0;
    {std::lock_guard<std::mutex>lock(mutex);ack=true;changed.notify_all();}
  }
  ~GLDriver(){Stop();}
};
static GLDriver driver;
