// Two equally sized RGBA planes allow one MRT pass to write four luma bytes
// and two interleaved chroma samples per fragment. x264 reads standard NV12
// rows from these bytes; the unused lower half of the chroma allocation is
// padding. This is a process-local staging layout, not a CoreVideo format.
static IOSurfaceRef PackedNV12Surface(int width,int height){
  @autoreleasepool{
    const size_t stride=IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,(size_t)width);
    const size_t bytes=stride*height,second=IOSurfaceAlignProperty(kIOSurfacePlaneOffset,bytes);
    NSMutableArray*planes=[NSMutableArray array];
    for(int i=0;i<2;i++)[planes addObject:@{
      (id)kIOSurfacePlaneWidth:@(width/4),(id)kIOSurfacePlaneHeight:@(height),
      (id)kIOSurfacePlaneBytesPerElement:@4,(id)kIOSurfacePlaneBytesPerRow:@(stride),
      (id)kIOSurfacePlaneOffset:@(i?second:0),(id)kIOSurfacePlaneSize:@(bytes)}];
    return IOSurfaceCreate((CFDictionaryRef)@{
      (id)kIOSurfaceWidth:@(width/4),(id)kIOSurfaceHeight:@(height),
      (id)kIOSurfaceBytesPerElement:@4,(id)kIOSurfaceBytesPerRow:@(stride),
      (id)kIOSurfacePixelFormat:@((uint32_t)'RGBA'),(id)kIOSurfaceAllocSize:@(second+bytes),
      (id)kIOSurfacePlaneInfo:planes});
  }
}
