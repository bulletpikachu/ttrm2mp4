// Independently convert the original canvas/header PNG to the documented
// BT.709 box-sampled NV12 representation and compare the actual GPU input.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodePNG } from '../node_modules/@onirenaud/node-webgl/dist/canvas/png.js';
const [reportFile,directory,output]=process.argv.slice(2);
if(!output)throw Error('Usage: node scripts/verify-native-composition.mjs report.json sample-directory audit.json');
const report=JSON.parse(await readFile(reportFile,'utf8')),samples=[];
const names=(await readdir(directory)).filter(name=>/^frame-\d+\.nv12$/.test(name)).sort();
if(!names.length)throw Error('No NV12 samples');
for(const name of names){
  const frame=Number(name.match(/\d+/)[0]),image=decodePNG(await readFile(path.join(directory,name.replace(/\.nv12$/,'.png'))));
  if(frame>=report.count||image.width!==report.width||image.height!==report.height)throw Error('Source sample dimensions/frame mismatch');
  const gpu=await readFile(path.join(directory,name)),rgba=image.data,w=image.width,h=image.height;
  if(gpu.length!==w*h*1.5)throw Error('GPU sample size mismatch');
  let squared=0,maxDifference=0;
  const compare=(position,expected)=>{const d=gpu[position]-Math.round(expected);squared+=d*d;maxDifference=Math.max(maxDifference,Math.abs(d))};
  for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){
    let r=0,g=0,b=0;
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
      const pixel=(y+dy)*w+x+dx,at=pixel*4,R=rgba[at],G=rgba[at+1],B=rgba[at+2];
      compare(pixel,16+219/255*(.2126*R+.7152*G+.0722*B));r+=R;g+=G;b+=B;
    }
    const uv=w*h+(y/2)*w+x;
    compare(uv,128+224/(255*4)*(-.114572*r-.385428*g+.5*b));
    compare(uv+1,128+224/(255*4)*(.5*r-.454153*g-.045847*b));
  }
  const psnr=squared?10*Math.log10(255**2/(squared/gpu.length)):Infinity;
  samples.push({frame,psnr:Number.isFinite(psnr)?psnr:'inf',maxDifference});
  if(samples.length%20===0)console.log(`Compared ${samples.length}/${names.length} native compositions`);
}
const minimumPSNR=Math.min(...samples.map(sample=>sample.psnr==='inf'?Infinity:sample.psnr));
const audit={video:report.output,sampleCount:samples.length,minimumPSNR:Number.isFinite(minimumPSNR)?minimumPSNR:'inf',minimumRequiredPSNR:40,passed:minimumPSNR>=40,samples};
await writeFile(output,JSON.stringify(audit,null,2)+'\n');
console.log(`${audit.passed?'PASS':'FAIL'}: ${samples.length} original canvas/header compositions match GPU NV12 inputs; minimum ${minimumPSNR.toFixed(2)} dB`);
if(!audit.passed)throw Error('Native composition differs from original canvas beyond the unchanged quality threshold');
