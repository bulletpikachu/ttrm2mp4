// Runs with the bundled Electron executable in Node mode; no system Node needed.
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
process.env.REPLAY_RESOURCE_ROOT=root;
process.env.REPLAY_EVENTS='1';
process.env.REPLAY_DESKTOP='1';
const entry=path.join(root,'src','render-auto.mjs');
process.argv=[process.execPath,entry,...process.argv.slice(2)];
import(pathToFileURL(entry).href).catch(error=>{console.error(error.stack);process.exitCode=1});
