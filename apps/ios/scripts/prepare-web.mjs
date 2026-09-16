// Bundle the userscript implementation; replace only platform boundaries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const name=process.argv[2];
const sites=JSON.parse(fs.readFileSync(path.join(root,'src/core/sites.json'),'utf8'));
const site=Object.values(sites).find(site=>site.provider===name&&site.ios);
if(!site)throw new Error('A registered provider is required');
const web=path.join(root,'apps/ios/web');
const output=path.join(root,'apps/ios/build',name,'Web');
const backup=JSON.parse(fs.readFileSync(path.join(root,'apps/ios/Resources/Native/BackupConfig.json'),'utf8'));
const swaps=new Map(Object.entries({
 'src/core/takeover.ts':'takeover.ts', 'src/core/platform.ts':'platform.ts',
 'src/core/compute/transport.ts':'transport.ts','src/core/compute/store.ts':'store.ts',
}).map(([from,to])=>[path.join(root,from),path.join(web,to)]));
let workerCode='';
const plugin={name:'native-boundaries',setup(b){
 b.onResolve({filter:/^@selected-provider$/},()=>({path:'selected',namespace:'native'}));
 b.onLoad({filter:/^selected$/,namespace:'native'},()=>({contents:
  ['ezmanga','qiscans'].includes(name)
   ? `import { create${name[0].toUpperCase()+name.slice(1)}Provider } from ${JSON.stringify(path.join(root,'src/provider',name+'.ts'))}; export const selected=create${name[0].toUpperCase()+name.slice(1)}Provider();`
   : `export { ${name} as selected } from ${JSON.stringify(path.join(root,'src/provider',name+'.ts'))};`,loader:'ts',resolveDir:root}));
 b.onResolve({filter:/^@worker-code$/},()=>({path:'worker',namespace:'native'}));
 b.onLoad({filter:/^worker$/,namespace:'native'},()=>({contents:'export default '+JSON.stringify(workerCode),loader:'js'}));
 b.onResolve({filter:/\?inline$/},args=>({path:path.resolve(path.dirname(args.importer),args.path.replace(/\?inline$/,'')),namespace:'text'}));
 b.onLoad({filter:/.*/,namespace:'text'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'text'}));
 b.onResolve({filter:/^\./},args=>{const target=path.resolve(path.dirname(args.importer),args.path);const replacement=swaps.get(target)||swaps.get(target+'.ts');return replacement?{path:replacement}:undefined;});
}};
const common={bundle:true,write:false,format:'iife',platform:'browser',target:'safari17',plugins:[plugin],define:{
 __IOS_ORIGIN__:JSON.stringify(`https://${site.domain}/`),__IOS_PROVIDER__:JSON.stringify(name),
 __READER_BACKUP_URL__:JSON.stringify(backup.url||''),__READER_BACKUP_KEY__:JSON.stringify(backup.key||''),
}};
workerCode=(await build({...common,entryPoints:[path.join(web,'worker.ts')]})).outputFiles[0].text;
const app=(await build({...common,entryPoints:[path.join(web,'app.ts')]})).outputFiles[0].text;
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'app.js'),app);
fs.copyFileSync(path.join(web,'index.html'),path.join(output,'index.html'));
console.log(`Shared reader bundled for ${name}`);
