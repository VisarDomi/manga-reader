import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from '../../../../gallery-downloader/node_modules/playwright-core/index.mjs';
const web = new URL('../Resources/Web/', import.meta.url);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="16000"><rect width="900" height="16000" fill="#29243d"/></svg>';
const server = http.createServer((req,res) => {
 const path = new URL(req.url, 'http://fixture').pathname;
 if (path.startsWith('/page/') || path.startsWith('/cover/')) {res.setHeader('Content-Type','image/svg+xml');res.end(svg);return;}
 const file = path.endsWith('/reader-core.js') ? 'reader-core.js' : path.endsWith('.js') ? 'app.js' : path.endsWith('.css') ? 'style.css' : 'index.html';
 res.setHeader('Content-Type', {'reader-core.js':'text/javascript','app.js':'text/javascript','style.css':'text/css','index.html':'text/html'}[file]);res.end(fs.readFileSync(new URL(file,web)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 for (const provider of ['asurascans', 'scythescans']) {
 const cid = n => provider === 'scythescans' ? `fixture-1234abcd-chapter-${n}${n === 2 ? '-2' : ''}` : String(n);
 const seriesIdentity = provider === 'scythescans' ? 'fixture-1234abcd' : 'fixture';
 const context=await browser.newContext({viewport:{width:428,height:926},deviceScaleFactor:3});
 const chapters = [1,2,3].map(number=>({number:String(number),id:provider === 'scythescans' ? cid(number) : undefined,locked:false}));
 const p={slug:'fixture-1234abcd',chapter:cid(2),page:4,fraction:.4,total:20,updatedAt:100};
 const state={provider,catalog:[{slug:p.slug,identity:seriesIdentity,title:'Fixture',cover:'',chapters}],progress:{[seriesIdentity]:p},history:{[seriesIdentity]:{[cid(1)]:19}},home:{path:'/',anchor:null,fraction:0,y:0},view:{path:'/'}};
 let lastPosition, pcAvailable=false, coldLaunch=false; const pcActions=[], viewWrites=[];
 await context.exposeBinding('nativeRPC',async(_,{command,args})=>{
   if(command==='init'&&coldLaunch){coldLaunch=false;return JSON.stringify({...state,resumeReader:state.view.path==='/'?undefined:state.view.path});}
   if(command==='init'||command==='snapshot')return JSON.stringify(state);
   if(command==='chapters')return JSON.stringify(chapters);
   if(command==='measure')return JSON.stringify({width:900,height:16000});
   if(command==='view-save'){
     if(args.progress){lastPosition=args.progress;state.progress[seriesIdentity]=args.progress;state.history[seriesIdentity]??={};state.history[seriesIdentity][args.progress.chapter]=Math.max(state.history[seriesIdentity][args.progress.chapter]??-1,args.progress.page);}
     viewWrites.push(args.view);state.view=args.view;if(args.view.path==='/')state.home=args.view;return '{}';
   }
   if(command==='position'){lastPosition=args;state.progress[seriesIdentity]=args;return '{}';}
   if(command==='view'){viewWrites.push(args);state.view=args;if(args.path==='/')state.home=args;return '{}';}
   if(command==='pc-available')return JSON.stringify(pcAvailable);
   if(command==='pc-load'||command==='pc-save'){pcActions.push(command);return command==='pc-load'?JSON.stringify(state):'{}';}
   if(command==='open')return JSON.stringify({slug:p.slug,chapter:args.chapter,title:'Fixture',pages:Array.from({length:20},()=>({url:'unused',width:0,height:0})),chapters,position:args.resume&&state.progress[seriesIdentity]?.chapter===args.chapter?state.progress[seriesIdentity]:undefined});
   return '{}';
 });
 await context.addInitScript(()=>{window.webkit={messageHandlers:{asura:{postMessage:body=>window.nativeRPC(body)}}};});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForSelector('.cover');
 await page.waitForTimeout(150);
 assert.equal(await page.locator('.hs-home-pc').isVisible(),false,'offline PC controls hidden');
 assert.deepEqual(pcActions,[],'startup does not transfer reading history');
 pcAvailable=true;await page.evaluate(()=>window.readerState.probePC());
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('button',{name:'Load',exact:true}).click();
 assert.deepEqual(pcActions,['pc-save','pc-load'],'only explicit clicks transfer history');
 assert.equal(await page.locator('.hs-home-pc').evaluate(n=>n.previousElementSibling.className),'hs-home-catalog-status');
 pcAvailable=false;await page.evaluate(()=>window.readerState.probePC());
 assert.equal(await page.locator('.hs-home-pc').isVisible(),false,'controls hide after PC disconnects');
 assert.equal(await page.getByRole('button',{name:'All chapters',exact:true}).count(),0,'no added chapter controls');
 const geometry=await page.locator('.hs-home-card').evaluate(n=>({height:n.getBoundingClientRect().height,cover:n.querySelector('.hs-home-cover').getBoundingClientRect().width,gap:getComputedStyle(n).columnGap}));
 assert.deepEqual(geometry,{height:200,cover:150,gap:'20px'},'extension home geometry is preserved');
 assert.equal(await page.locator('h1,input[type=search]').count(),0,'no added header/search redesign');
 await page.locator('.cover').click();await page.waitForSelector(`#page-${cid(2)}-4`);
 await page.waitForFunction(()=>scrollY>1000);
 const fraction=await page.locator(`#page-${cid(2)}-4`).evaluate(n=>-n.getBoundingClientRect().top/n.getBoundingClientRect().height);
 assert.ok(Math.abs(fraction-.4)<.002,'cover restores fractional image position');
 await page.waitForFunction(()=>document.querySelectorAll('.page img').length>0);
 assert.ok(await page.locator('.page img').count()<5,'distant pages have no image source');
 await page.evaluate(()=>{dispatchEvent(new Event('wheel'));scrollBy(0,400);});await page.waitForTimeout(300);
 assert.ok(lastPosition.fraction>.4,'user scroll replaces restore position');
 await page.goBack();await page.waitForSelector('.cover');
 await page.getByRole('button',{name:'First chapter',exact:true}).click();await page.waitForSelector(`#page-${cid(1)}-0`);
 const readerGeometry=await page.locator('.hs-reader-body').evaluate(n=>({top:getComputedStyle(n).paddingTop,bottom:getComputedStyle(n).paddingBottom,viewport:innerHeight}));
 assert.equal(parseFloat(readerGeometry.top),readerGeometry.viewport/2);
 assert.equal(parseFloat(readerGeometry.bottom),readerGeometry.viewport);
 assert.equal(await page.locator('.reader-head,.chapter-end').count(),0,'uninterrupted extension reader UI');
 await page.waitForFunction(id=>document.getElementById(id)?.dataset.measured==='1', `page-${cid(1)}-0`);
 assert.equal(await page.locator(`#page-${cid(1)}-0`).evaluate(n=>n.style.height),'','actual image dimensions replace the provisional size');
 await page.waitForTimeout(250);assert.equal(lastPosition.chapter,cid(1),'going backward changes resume chapter');assert.equal(lastPosition.page,0);
 await page.evaluate(()=>{dispatchEvent(new Event('wheel'));scrollTo(0,document.body.scrollHeight);});await page.waitForSelector(`#page-${cid(2)}-0`);
 assert.equal(await page.locator(`#page-${cid(2)}-0`).count(),1,'continuous reading appends next chapter once');
 // A killed reader launches through Home before opening the saved chapter.
 await page.close();
 const savedView={path:`/reader/fixture-1234abcd/${cid(2)}`,anchor:`page-${cid(2)}-4`,fraction:.37,y:33333};
 state.view={...savedView};state.progress[seriesIdentity]={...p,chapter:cid(2),page:4,fraction:.37,total:20};
 viewWrites.length=0;coldLaunch=true;
 const cold=await context.newPage();cold.on('pageerror',e=>errors.push(e.message));
 await cold.addInitScript(()=>{
   // Model iOS requesting a checkpoint as soon as a bootstrap Home is rendered.
   new MutationObserver(()=>{
     if(location.pathname==='/'&&document.querySelector('.hs-home-list'))void window.readerState?.save();
   }).observe(document,{subtree:true,childList:true});
 });
 await cold.goto(base);await cold.waitForSelector(`#page-${cid(2)}-4`);
 await cold.waitForFunction(id=>document.getElementById(id)?.dataset.measured==='1', `page-${cid(2)}-4`);
 await cold.waitForTimeout(250);
 assert.ok(!viewWrites.some(v=>v.path==='/'),'bootstrap Home must not replace saved reader state');
 const restoredFraction=await cold.locator(`#page-${cid(2)}-4`).evaluate(n=>-n.getBoundingClientRect().top/n.getBoundingClientRect().height);
 assert.ok(Math.abs(restoredFraction-savedView.fraction)<.002,'cold reader restart restores exact saved image fraction');
 assert.deepEqual(errors,[]);
 console.log(provider, 'PASS UI: cover fraction, manual scroll, First chapter, continuous next, bounded image sources, optional PC, cold reader restart');
 // Repeat through the same UI with no seeded reading history.
 await cold.close();state.progress={};state.history={};state.view={path:'/'};state.home={path:'/'};lastPosition=undefined;
 const fresh=await context.newPage();fresh.on('pageerror',e=>errors.push(e.message));
 await fresh.goto(base);await fresh.waitForSelector('.cover');
 assert.equal(await fresh.locator('.hs-home-chapter-partial,.hs-home-chapter-read').count(),0);
 await fresh.locator(`a.chapter[href="/reader/${p.slug}/${cid(2)}"]`).click();
 await fresh.waitForFunction(id=>document.getElementById(id)?.querySelector('img')?.naturalWidth>0,`page-${cid(2)}-0`);
 await fresh.evaluate(()=>{dispatchEvent(new Event('wheel'));scrollTo(0,1200);dispatchEvent(new Event('scrollend'));});
 await fresh.evaluate(()=>window.readerState.save());
 assert.equal(lastPosition.chapter,cid(2),'reading from empty history saves the selected provider chapter');
 assert.equal(state.history[seriesIdentity][cid(2)],0,'chapter history written through checkpoint');
 await fresh.goBack();await fresh.waitForSelector('.cover');
 assert.ok((await fresh.locator('.cover').getAttribute('href')).includes(`${cid(2)}?resume=1`),'Home cover resumes newly read chapter');
 assert.equal(await fresh.locator('.hs-home-chapter-partial').count(),1,'Home marks newly read chapter partial');
 await fresh.locator('.cover').click();await fresh.waitForSelector(`#page-${cid(2)}-0`);
 await fresh.waitForFunction(()=>scrollY>1000);
 assert.deepEqual(errors,[]);
 console.log(provider,'PASS empty history → read → Home partial/cover → resume');
 await context.close();
 }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
