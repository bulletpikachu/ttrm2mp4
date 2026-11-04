#!/usr/bin/env node
// Compare matching pre-encode source PNGs. This does not compare compression,
// audio, unsampled frames, or the duration of performance benchmark runs.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import ffmpeg from 'ffmpeg-static';
const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:{'min-psnr':{type:'string'},overwrite:{type:'boolean'}}});
if(p.length!==3)throw Error('Usage: node scripts/compare-sources.mjs reference-dir candidate-dir report.json [--min-psnr N] [--overwrite]');
const reference=path.resolve(p[0]),candidate=path.resolve(p[1]),output=path.resolve(p[2]);
const minimum=o['min-psnr']===undefined?null:Number(o['min-psnr']);
if(minimum!==null&&(!Number.isFinite(minimum)||minimum<0))throw Error('Invalid minimum PSNR');
if(!o.overwrite){try{await access(output);throw Error('Report exists: '+output)}catch(error){if(error.code!=='ENOENT')throw error}}
const frames=async dir=>(await readdir(dir)).filter(file=>/^frame-\d+\.png$/.test(file)).sort();
const [a,b]=await Promise.all([frames(reference),frames(candidate)]);
if(!a.length||JSON.stringify(a)!==JSON.stringify(b))throw Error('Source folders must contain the same nonempty set of frame PNGs');
const temp=await mkdtemp(path.join(os.tmpdir(),'replay-source-comparison-'));
try{
  for(const [dir,name]of [[reference,'a'],[candidate,'b']])await writeFile(path.join(temp,name+'.txt'),a.map(file=>`file '${path.join(dir,file).replaceAll('\\','/').replace(/'/g,"'\\''")}'`).join('\n')+'\n');
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-f','concat','-safe','0','-i',path.join(temp,'a.txt'),'-f','concat','-safe','0','-i',path.join(temp,'b.txt'),'-filter_complex','[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]psnr=stats_file=-:stats_version=2','-vsync','0','-f','null','-'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stats='';child.stdout.on('data',bytes=>{stats+=bytes});
  let errors='';child.stderr.on('data',bytes=>{errors=(errors+bytes).slice(-6000)});
  const [code]=await once(child,'exit');if(code!==0)throw Error('Source comparison failed: '+errors);
  const lines=stats.split('\n').filter(line=>line.startsWith('n:'));
  if(lines.length!==a.length)throw Error(`Compared ${lines.length} samples, expected ${a.length}`);
  const samples=lines.map((line,i)=>{const values=Object.fromEntries(line.trim().split(/\s+/).map(item=>item.split(':')));const exact=values.psnr_avg==='inf',value=Number(values.psnr_avg);if(!exact&&!Number.isFinite(value))throw Error('Invalid PSNR result for '+a[i]);return{file:a[i],frame:Number(a[i].match(/\d+/)[0]),mse:Number(values.mse_avg),psnr:exact?null:value}});
  const finite=samples.filter(sample=>sample.psnr!==null),minimumPSNR=finite.length?Math.min(...finite.map(sample=>sample.psnr)):null;
  const report={reference,candidate,sampleCount:samples.length,exactSampleCount:samples.filter(sample=>sample.psnr===null).length,minimumPSNR,minimumRequiredPSNR:minimum,passed:minimum===null||minimumPSNR===null||minimumPSNR>=minimum,samples};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(`${report.sampleCount} source samples compared; ${report.exactSampleCount} exact; minimum RGB PSNR ${minimumPSNR===null?'infinite':minimumPSNR.toFixed(2)+' dB'}.`);
  if(!report.passed)throw Error('Source quality is below the requested PSNR threshold');
}finally{await rm(temp,{recursive:true,force:true})}
