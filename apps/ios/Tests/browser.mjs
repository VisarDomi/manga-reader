import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import { chromium } from '../../../../gallery-downloader/node_modules/playwright-core/index.mjs';
const providers=JSON.parse(fs.readFileSync(new URL('../build/providers.json',import.meta.url)));
const image='<svg xmlns="http://www.w3.org/2000/svg" width="428" height="1200"><rect width="428" height="1200" fill="gray"/></svg>';
let selected='lua';
const server=http.createServer((req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname;
 if(path==='/image'){res.setHeader('Content-Type','image/svg+xml');res.end(image);return;}
 const file=path==='/app.js'?'app.js':'index.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');
 res.end(fs.readFileSync(new URL(`../build/${selected}/Web/${file}`,import.meta.url)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try {
for(const name of Object.keys(providers)) {
 selected=name;execFileSync('node',['scripts/build-ios.mjs',name,'--prepare-only'],{stdio:'pipe'});
 const config=providers[name], isLua=name==='lua';
 const id=name==='asura'?'2':name==='scythe'?'fixture-chapter-2':'chapter-2';
 const route=name==='asura'?'/comics/fixture/chapter/2':name==='scythe'?'/fixture-chapter-2/':name==='yaksha'?'/manga/fixture/chapter-2/':'/series/fixture/chapter-2';
 const urls=Array.from({length:11},(_,i)=>`https://media.luacomic.org/file/demo/uploads/series/${i}.webp`);
 const chapter={chapterId:id,seriesSlug:'fixture',seriesTitle:'Fixture',images:urls.map(url=>({url}))};
 const database={version:1,indexedDB:{progress:[],tokens:[],metadata:[{key:"progress-schema-version",value:3}]}};
 const storage={database},chapters=new Map(), commands=[];
 if(!isLua)chapters.set(JSON.stringify(['fixture',id]),chapter);
 const context=await browser.newContext({viewport:{width:428,height:926}});
 await context.exposeBinding('nativeRPC',async(_,{command,args})=>{
  commands.push({command,args});let value={};
  if(command==='init')value={cold:false,routes:{}};
  else if(command==='read')value=storage[args.key]??null;
  else if(command==='write')storage[args.key]=args.value;
  else if(command==='chapter-read')value=chapters.get(args.key)??null;
  else if(command==='chapter-write')chapters.set(args.key,args.value);
  else if(command==='fetch'){
   const url=new URL(args.url);let body;
   if(isLua&&url.pathname==='/query')body={meta:{total:1},data:[{title:'Fixture',series_slug:'fixture',thumbnail:urls[0],paid_chapters:[],free_chapters:[{chapter_slug:id,chapter_name:'Chapter 2',created_at:'2026-09-01'}]}]};
   else if(isLua&&url.hostname==='luacomic.org')body='<title>Fixture - Chapter 2 - Lua Comic</title>'+urls.map((url,i)=>i<4?`<img src="${url}">`:`<img src="" data-src="${url}">`).join('');
   else if(isLua&&url.pathname==='/series/fixture')body={id:1};
   else if(isLua&&url.pathname==='/chapter/query')body={meta:{last_page:1},data:[{chapter_slug:id}]};
   else if(name==='asura')body={data:[{number:2}],meta:{has_more:false}};
   else if(name==='ezmanga'||name==='qiscans')body={data:[{slug:id}],totalPages:1};
   else if(name==='yaksha')body=`<li class="wp-manga-chapter"><a href="https://yakshacomics.com${route}">Chapter 2</a></li>`;
   else body=`<div id="chapterlist"><a href="https://scythescans.com${route}">Chapter 2</a></div>`;
   value={status:200,headers:{},body:Buffer.from(typeof body==='string'?body:JSON.stringify(body)).toString('base64')};
  }
  return JSON.stringify(value);
 });
 await context.addInitScript(()=>{window.webkit={messageHandlers:{asura:{postMessage:body=>window.nativeRPC(body)}}};});
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>{errors.push(error.message);console.error(name,error.message);});page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());console.error(name,message.text());}});
 await page.goto(base+route);
 await page.waitForSelector('.hs-reader-img');
 assert.equal(await page.locator('.hs-chapter').first().locator('img').count(),11,`${name}: all shared image entries rendered`);
 await page.waitForFunction(()=>document.querySelector('.hs-reader-img')?.naturalWidth>0);
 assert.equal(await page.locator('.hs-reader-img').first().getAttribute('loading'),'lazy');
 assert.ok(commands.some(c=>c.command==='prepare'&&c.args.urls.length===11),`${name}: whole chapter is prepared before scrolling`);
 assert.ok((await page.locator('.hs-reader-img').evaluateAll(images=>images.map(i=>i.src))).every(url=>url.startsWith(base+'/image?url=')),`${name}: images only use downloader`);
 await page.evaluate(()=>{scrollTo(0,1500);dispatchEvent(new Event('scrollend'));});
 await page.waitForTimeout(350);
 assert.ok(storage.database.indexedDB.progress.some(p=>p.provider===config.key&&p.seriesSlug==='fixture'),`${name}: shared tracking saves progress`);
 assert.equal(await page.locator('.hs-error').count(),0,`${name}: chapter list matches shared provider`);
 assert.deepEqual(errors,[],`${name}: browser errors`);
 if(isLua){await page.goto(base);await page.waitForSelector('.hs-home-card');assert.equal(await page.getByText('First chapter',{exact:true}).count(),1);assert.ok((await page.locator('.hs-home-cover').getAttribute('href')).includes('#'));}
 console.log(`PASS ${name}: shared reader, native-only image URLs, whole-chapter preparation, progress${isLua?', Lua src/data-src extraction':''}`);
 await context.close();
}
} finally {await browser.close();server.close();}
