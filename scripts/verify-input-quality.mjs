// Compare sampled decoded MP4 frames with matching native NV12 encoder inputs.
// This also catches frame shifts that a round/master identity check cannot.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
const [reportFile,directory,output,threshold]=process.argv.slice(2);
if(!reportFile||!directory||!output)throw Error('Usage: node scripts/verify-input-quality.mjs report.json samples-directory output.json [minimum-PSNR]');
const report=JSON.parse(await readFile(reportFile,'utf8'));
const minimumRequired=threshold===undefined?null:Number(threshold);
if(minimumRequired!==null&&(!Number.isFinite(minimumRequired)||minimumRequired<0))throw Error('Invalid minimum PSNR');
const files=(await readdir(directory)).filter(name=>/^frame-\d+\.nv12$/.test(name)).map(name=>({file:path.resolve(directory,name),frame:Number(name.match(/\d+/)[0])})).sort((a,b)=>a.frame-b.frame);
if(!files.length||files.some(({frame},i)=>frame>=report.count||frame<0||i&&frame===files[i-1].frame))throw Error('Invalid or empty native input samples');
const bytes=report.width*report.height*3/2;
for(const {file}of files)if((await stat(file)).size!==bytes)throw Error('Native input has an unexpected size: '+file);
const selection=files.map(({frame})=>`eq(n\\,${frame})`).join('+');
const filter=`[0:v]select=${selection},setpts=N/(${report.fps}*TB),format=yuv420p[video];[1:v]format=yuv420p[reference];[video][reference]psnr=stats_file=-:shortest=1`;
const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-i',report.output,
  '-f','rawvideo','-pixel_format','nv12','-video_size',`${report.width}x${report.height}`,'-framerate',String(report.fps),'-i','pipe:0',
  '-filter_complex',filter,'-an','-f','null','-'],{stdio:['pipe','pipe','pipe']});
let logs='',errors='';child.stdout.on('data',chunk=>{logs+=chunk});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-5000)});
const completion=once(child,'exit');
const writing=pipeline(Readable.from((async function*(){for(const {file}of files)for await(const chunk of createReadStream(file))yield chunk;})()),child.stdin).catch(error=>{child.kill('SIGTERM');throw error});
writing.catch(()=>{});
const [code]=await completion;await writing;
if(code!==0)throw Error('Native input comparison failed: '+errors);
const values=logs.split('\n').filter(line=>line.startsWith('n:')).map(line=>Object.fromEntries(line.trim().split(/\s+/).map(field=>field.split(':'))));
if(values.length!==files.length)throw Error(`Compared ${values.length} frames; expected ${files.length}`);
const score=value=>value==='inf'?Infinity:Number(value);
const minimumPSNR=Math.min(...values.map(value=>score(value.psnr_avg)));
if(Number.isNaN(minimumPSNR))throw Error('Invalid PSNR result');
const result={video:report.output,directory:path.resolve(directory),count:report.count,sampleCount:files.length,minimumPSNR:Number.isFinite(minimumPSNR)?minimumPSNR:'inf',minimumRequiredPSNR:minimumRequired,passed:minimumRequired===null||minimumPSNR>=minimumRequired,
  samples:values.map((value,i)=>({frame:files[i].frame,psnr:value.psnr_avg,lumaPSNR:value.psnr_y,chromaUPSNR:value.psnr_u,chromaVPSNR:value.psnr_v}))};
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(`${files.length} decoded frames compared to native NV12 inputs; minimum YUV PSNR ${result.minimumPSNR} dB.`);
if(!result.passed)throw Error('Decoded input quality is below the requested threshold');
