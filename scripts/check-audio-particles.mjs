import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {patchAudioOnlyParticles} from '../src/offline/audio-particles.mjs';
import {patchClient} from '../src/offline/client.mjs';
const manifest=JSON.parse(await readFile('client/manifest.json','utf8'));
const entry=Object.entries(manifest.entries).find(([key])=>new URL(key.slice(key.indexOf(' ')+1)).pathname==='/js/tetrio.js')?.[1];
assert(entry,'Prepared pinned client required');
const source=await readFile('client/objects/'+entry.hash,'utf8'),patched=patchAudioOnlyParticles(source);
assert(!patchClient(source).includes('__installAudioOnlyParticles'),'Default client retains original particle methods');
assert(patchClient(source,{audioOnlyParticles:true}).includes('__installAudioOnlyParticles'));
assert.throws(()=>patchAudioOnlyParticles(''),/patch mismatch/);
assert.throws(()=>patchAudioOnlyParticles(patched),/implementation changed/);
assert.throws(()=>patchAudioOnlyParticles(source.replace('progressSpeed(e){','progressSpeed(e){Math.random();')),/implementation changed/);
function engine(text){
  let seed=72913,calls=0;const math=Object.create(Math);math.random=()=>{calls++;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  class Sprite{
    constructor(texture){this.texture=texture;this.children=[];this.scale={x:1,y:1,set(v){this.x=this.y=v}};}
    destroy(){this._destroyed=true;}
  }
  const d={TextureCache:{GetTexture:()=>({width:32,height:32})},Utils:{PackRGB:(r,g,b)=>(r<<16)+(g<<8)+b}},window={};
  const start=text.indexOf('d.Particle=class'),end=text.indexOf(',d.ParseSimpleParticleOptions=',start);assert(start>0&&end>start);
  new Function('o','d','window','Math',text.slice(start,end)+';')({Sprite,DEG_TO_RAD:Math.PI/180},d,window,math);
  return{Particle:d.Particle,window,randomState:()=>[seed,calls]};
}
const reference=engine(source),candidate=engine(patched);
assert.equal(candidate.Particle.prototype.progress.toString(),reference.Particle.prototype.progress.toString(),'Loading the hook alone changes no updates');
candidate.window.__installAudioOnlyParticles();
assert.throws(()=>candidate.window.__installAudioOnlyParticles(),/already installed/);
const keys=['alpha','alphamultiplier','scale','scalemultiplier','angle','xspeed','yspeed','anglespeed','direction','speed','flurryfrequency','flurryamplitude','xflurry','yflurry','flickerfrequency','flickeramplitude'];
function options(test,generation){
  const result={texture:'test',x:10,y:20,lifetime:[0,1/60,.1,1,3][(test+generation)%5],tint:{r:{start:255,inc:0},g:{start:127,inc:0},b:{start:64,inc:0}},blendmode:0,wrap:true};
  for(const key of keys)result[key]={start:['alpha','alphamultiplier','scale','scalemultiplier'].includes(key)?1:key==='speed'?90:0,inc:0};
  if(test%3){result.xspeed={start:2,inc:.1};result.yspeed={start:-3,inc:-.2};result.xflurry={start:2,inc:.01};result.yflurry={start:1,inc:.02};}
  return result;
}
let steps=0;
for(let test=0;test<240;test++){
  const make=system=>{
    const manager={events:[],graveyard(p,length){this.events.push([p.lifetime,length])}};
    const Type=test%11===0?class extends system.Particle{}:system.Particle;
    const particle=new Type(options(test,0),manager);if(test%8===0)particle.children=[{}];
    return{particle,manager,attach(){particle.parent={children:[particle],contextWidth:640,contextHeight:480,removeChild(p){this.children.splice(this.children.indexOf(p),1)}};}};
  };
  const a=make(reference),b=make(candidate);a.attach();b.attach();let generation=0;
  for(let frame=0;frame<240;frame++){
    const delta=[1,1,.5,2,0,1.001][frame%6];a.particle.progress(delta);b.particle.progress(delta);steps++;
    assert.deepEqual(reference.randomState(),candidate.randomState(),'Exact random sequence and consumption');
    for(const key of ['lifetime','totalLifetime','graveyarded','hasXYSpeed'])assert(Object.is(a.particle[key],b.particle[key]),`Exact ${key}`);
    assert.deepEqual(a.manager.events,b.manager.events,'Exact death/reuse order');
    if(test%8===0||test%11===0)for(const key of ['x','y','angle','speed','direction','alpha','truescale'])assert(Object.is(a.particle[key],b.particle[key]),'Fallback retains complete original state');
    if(a.particle.graveyarded){generation++;a.particle.init(options(test,generation));b.particle.init(options(test,generation));a.attach();b.attach();}
  }
}
assert(candidate.window.__audioOnlyParticleStats.updates===steps);
assert(candidate.window.__audioOnlyParticleStats.fallbacks>0&&candidate.window.__audioOnlyParticleStats.fallbacks<steps);
console.log(`PASS: ${steps} actual pinned updates preserve lifetime, exact random sequence, death/reuse order and non-leaf/subclass fallbacks; default client remains unmodified.`);
