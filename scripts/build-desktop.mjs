import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(new URL('../desktop/dist/',import.meta.url),{recursive:true});
await build({absWorkingDir:root,entryPoints:['desktop/ui/App.tsx'],bundle:true,outdir:'desktop/dist',entryNames:'app',format:'iife',platform:'browser',target:'chrome140',jsx:'automatic',minify:true,external:['../assets/*.png'],define:{'process.env.NODE_ENV':'"production"'}});
await writeFile(new URL('../desktop/dist/index.html',import.meta.url),'<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:"><title>ttrm2mp4</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>');
console.log('Desktop interface built.');
