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
 const context=await browser.newContext({viewport:{width:428,height:926},deviceScaleFactor:3});
 const chapters = [1,2,3].map(number=>({number:String(number),locked:false}));
 const p={slug:'fixture-1234abcd',chapter:'2',page:4,fraction:.4,total:20,updatedAt:100};
 const state={catalog:[{slug:p.slug,identity:'fixture',title:'Fixture',cover:'',chapters}],progress:{fixture:p},history:{fixture:{'1':19}},home:{path:'/',anchor:null,fraction:0,y:0},view:{path:'/'}};
 let lastPosition, pcAvailable=false; const pcActions=[];
 await context.exposeBinding('nativeRPC',async(_,{command,args})=>{
   if(command==='init'||command==='snapshot')return JSON.stringify(state);
   if(command==='chapters')return JSON.stringify(chapters);
   if(command==='measure')return JSON.stringify({width:900,height:16000});
   if(command==='position'){lastPosition=args;state.progress.fixture=args;return '{}';}
   if(command==='view'){state.view=args;if(args.path==='/')state.home=args;return '{}';}
   if(command==='pc-available')return JSON.stringify(pcAvailable);
   if(command==='pc-load'||command==='pc-save'){pcActions.push(command);return command==='pc-load'?JSON.stringify(state):'{}';}
   if(command==='open')return JSON.stringify({slug:p.slug,chapter:args.chapter,title:'Fixture',pages:Array.from({length:20},()=>({url:'unused',width:0,height:0})),chapters,position:args.resume&&state.progress.fixture.chapter===args.chapter?state.progress.fixture:undefined});
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
 await page.locator('.cover').click();await page.waitForSelector('#page-2-4');
 await page.waitForFunction(()=>scrollY>1000);
 const fraction=await page.locator('#page-2-4').evaluate(n=>-n.getBoundingClientRect().top/n.getBoundingClientRect().height);
 assert.ok(Math.abs(fraction-.4)<.002,'cover restores fractional image position');
 await page.waitForFunction(()=>document.querySelectorAll('.page img').length>0);
 assert.ok(await page.locator('.page img').count()<5,'distant pages have no image source');
 await page.evaluate(()=>scrollBy(0,400));await page.waitForTimeout(300);
 assert.ok(lastPosition.fraction>.4,'user scroll replaces restore position');
 await page.goBack();await page.waitForSelector('.cover');
 await page.getByRole('button',{name:'First chapter',exact:true}).click();await page.waitForSelector('#page-1-0');
 const readerGeometry=await page.locator('.hs-reader-body').evaluate(n=>({top:getComputedStyle(n).paddingTop,bottom:getComputedStyle(n).paddingBottom,viewport:innerHeight}));
 assert.equal(parseFloat(readerGeometry.top),readerGeometry.viewport/2);
 assert.equal(parseFloat(readerGeometry.bottom),readerGeometry.viewport);
 assert.equal(await page.locator('.reader-head,.chapter-end').count(),0,'uninterrupted extension reader UI');
 await page.waitForFunction(()=>document.querySelector('#page-1-0')?.dataset.measured==='1');
 assert.equal(await page.locator('#page-1-0').evaluate(n=>n.style.height),'','actual image dimensions replace the provisional size');
 await page.waitForTimeout(250);assert.equal(lastPosition.chapter,'1','going backward changes resume chapter');assert.equal(lastPosition.page,0);
 await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.waitForSelector('#page-2-0');
 assert.equal(await page.locator('#page-2-0').count(),1,'continuous reading appends next chapter once');
 assert.deepEqual(errors,[]);
 console.log('PASS UI: cover fraction, manual scroll, First chapter, continuous next, bounded image sources, optional PC');
 await context.close();
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
