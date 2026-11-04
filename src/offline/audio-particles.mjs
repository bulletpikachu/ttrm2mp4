import {createHash} from 'node:crypto';

// Only the separate audio-only process installs this hook. Leaf particles keep
// their lifetime, removal/reuse order and the original XY update (including its
// random draws). Their unused visual properties need no animation. Non-leaf
// particles and subclasses retain the complete original update.
export function patchAudioOnlyParticles(source){
  const marker='},d.ParseSimpleParticleOptions=function(e){';
  if(source.split(marker).length!==2)throw Error('Pinned audio-only particle patch mismatch');
  const start=source.indexOf('d.Particle=class'),end=source.indexOf(marker,start);
  if(start<0||createHash('sha256').update(source.slice(start,end+1)).digest('hex')!=='d12ae82d230847be9f5731db6d4b09d9a141133803781d01a4b503e3098c519d')throw Error('Pinned particle implementation changed; audio-only optimization requires revalidation');
  const hook=`},window.__installAudioOnlyParticles=()=>{if(window.__audioOnlyParticleStats)throw Error("Audio-only particles already installed");const prototype=d.Particle.prototype,original=prototype.progress,stats=window.__audioOnlyParticleStats={enabled:true,updates:0,fallbacks:0};prototype.progress=function(e){stats.updates++;if(this.children.length||Object.getPrototypeOf(this)!==prototype){stats.fallbacks++;return original.call(this,e)}this.progressLifetime(e)||this.progressXYSpeed(e)}},d.ParseSimpleParticleOptions=function(e){`;
  return source.replace(marker,hook);
}
