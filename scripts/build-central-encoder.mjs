import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const include=process.env.REPLAY_NODE_HEADERS||path.resolve(path.dirname(process.execPath),'../include/node');
const x264=process.env.REPLAY_X264_SOURCE||path.join(root,'.native-deps/x264');
const child=spawn('xcrun',['clang++','-O3','-std=c++17','-dynamiclib','-undefined','dynamic_lookup','-I',include,'-I',x264,'-framework','IOSurface','-framework','CoreFoundation',path.join(root,'src/experimental/native/central-encoder.mm'),path.join(x264,'libx264.a'),'-o',path.join(root,'src/experimental/native/central-encoder.node')],{stdio:'inherit'});
const[code]=await once(child,'exit');if(code!==0)throw Error('Central encoder build failed');
