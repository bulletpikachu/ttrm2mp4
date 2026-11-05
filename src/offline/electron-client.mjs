import {createLocalClientStore} from './client.mjs';
import {readAppearance} from './appearance.mjs';

// Only the selected export session is intercepted. No request is forwarded to
// net.fetch: missing entries fail, and Chromium's offline switch stays enabled.
export async function installElectronClient(session,{directory,appearanceFile,options={}}){
  const store=await createLocalClientStore(directory,{...options,appearance:await readAppearance(appearanceFile)});
  const handler=async request=>{
    const response=await store.response(request.method,request.url);
    return response?new Response(response.body,{status:response.status,headers:response.headers}):Response.error();
  };
  session.protocol.handle('https',handler);session.protocol.handle('http',handler);
  return store;
}
