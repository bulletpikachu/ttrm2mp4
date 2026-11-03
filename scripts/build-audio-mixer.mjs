import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const include=process.env.REPLAY_NODE_HEADERS||path.resolve(path.dirname(process.execPath),'../include/node');
const child=spawn('xcrun',['clang++','-O3','-ffp-contract=off','-std=c++17','-dynamiclib','-undefined','dynamic_lookup','-I',include,path.join(root,'src/experimental/native/audio-mixer.cc'),'-o',path.join(root,'src/experimental/native/audio-mixer.node')],{stdio:'inherit'});
const[code]=await once(child,'exit');if(code!==0)throw Error('Native audio mixer build failed');
