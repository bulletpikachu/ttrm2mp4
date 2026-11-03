import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Local ANGLE binding requires Apple Silicon macOS');
const root=fileURLToPath(new URL('../',import.meta.url)),dependency=path.join(root,'node_modules/@onirenaud/node-webgl');
const pkg=JSON.parse(await readFile(path.join(dependency,'package.json'),'utf8'));if(pkg.version!=='0.2.0')throw Error('Local binding patch requires node-webgl 0.2.0');
const target=path.join(root,'.native-deps/node-webgl-local');await mkdir(target,{recursive:true});
let source=await readFile(path.join(dependency,'src/native/addon.cc'),'utf8');
function replace(needle,value){if(source.split(needle).length!==2)throw Error('Local binding patch mismatch: '+needle);source=source.replace(needle,value)}
replace('  size_t robustnessAt = a.size();',`  const bool noError=OptBool(env,argv[0],"noError",false);
  if(noError){
    if(webgl||robustness||!D.has("EGL_KHR_create_context_no_error"))return Throw(env,"No-error context is unavailable or incompatible with WebGL/robust access");
    a.push_back(EGL_CONTEXT_OPENGL_NO_ERROR_KHR);a.push_back(EGL_TRUE);
  }
  size_t robustnessAt = a.size();`);
await writeFile(path.join(target,'addon.cc'),source);
const include=process.env.REPLAY_NODE_HEADERS||path.resolve(path.dirname(process.execPath),'../include/node');
const libraries=path.join(dependency,'angle/lib/darwin-arm64');for(const name of ['libEGL.a','libGLESv2.a','libANGLE.a'])await access(path.join(libraries,name));
const binary=path.join(target,'node-webgl-local.node');
const child=spawn('xcrun',['clang++','-O3','-std=c++17','-dynamiclib','-undefined','dynamic_lookup','-DNAPI_VERSION=8','-I',include,'-I',path.join(dependency,'angle/include'),'-I',path.join(dependency,'src/native'),path.join(target,'addon.cc'),path.join(dependency,'src/native/image_apple.mm'),...['libEGL.a','libGLESv2.a','libANGLE.a'].map(name=>path.join(libraries,name)),...['Metal','QuartzCore','IOSurface','IOKit','CoreGraphics','CoreFoundation','Foundation','ImageIO','OpenGL','Cocoa'].flatMap(name=>['-framework',name]),'-Wno-deprecated-declarations','-o',binary],{stdio:'inherit'});
const[code]=await once(child,'exit');if(code!==0)throw Error('Local ANGLE binding build failed');
await cp(path.join(dependency,'dist'),path.join(target,'dist'),{recursive:true});
const nativeFile=path.join(target,'dist/native.js');let loader=await readFile(nativeFile,'utf8');
if(loader.split('native = gypBuild(packageRoot);').length!==2)throw Error('Local binding loader patch mismatch');
loader=loader.replace('native = gypBuild(packageRoot);',`native = require(${JSON.stringify(binary)});`);await writeFile(nativeFile,loader);
await writeFile(path.join(target,'package.json'),JSON.stringify({type:'module',private:true})+'\n');
console.log('Local binding and mirrored JS adapter built; installed dependency remains unchanged.');
