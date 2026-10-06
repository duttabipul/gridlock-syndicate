const {chromium}=require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
(async()=>{
 const {default:worker,Room}=await import('./worker.mjs');
 const objects=new Map();function ctx(){const m=new Map();let q=Promise.resolve();return{storage:{get:async k=>structuredClone(m.get(k)),put:async(k,v)=>m.set(k,structuredClone(v)),deleteAll:async()=>m.clear(),setAlarm:async()=>{}},blockConcurrencyWhile(f){const j=q.then(f);q=j.catch(()=>{});return j;}}}
 const env={ROOMS:{idFromName:x=>x,get(x){if(!objects.has(x))objects.set(x,new Room(ctx()));return objects.get(x);}},ASSETS:{fetch:r=>{const p=new URL(r.url).pathname;return new Response(fs.readFileSync(path.join(__dirname,'public',p==='/'?'index.html':p.slice(1))),{headers:{'Content-Type':p.endsWith('.js')?'text/javascript':'text/html'}});}}};
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const result=await worker.fetch(new Request('http://127.0.0.1:8766'+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}),env);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch(e){res.writeHead(500);res.end(String(e));}});
 await new Promise(r=>server.listen(8766,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try{
 const nav=await browser.newPage({viewport:{width:1280,height:1000}}),op=await browser.newPage({viewport:{width:390,height:844}});const errors=[];
 for(const p of [nav,op])p.on('pageerror',e=>errors.push(e.message));
 await nav.goto('http://127.0.0.1:8766');await nav.fill('#operator-name','Bipul');await nav.click('#create-room');await nav.locator('#lobby').waitFor({state:'visible'});const code=await nav.locator('.room-code').textContent();
 await op.goto('http://127.0.0.1:8766');await op.fill('#operator-name','Partner');await op.fill('#room-code',code);await op.click('#join-room');await op.locator('#lobby').waitFor({state:'visible'});
 await nav.waitForFunction(()=>!document.querySelector('#start-mission').disabled);await nav.click('#start-mission');await nav.locator('#gameplay').waitFor({state:'visible'});await op.locator('#gameplay').waitFor({state:'visible'});
 if(await nav.locator('.cell').count()!==25)throw Error('Map cells');if(await op.locator('.cell').count()!==0)throw Error('Operator leaked DOM map');if(await nav.locator('#controls button:not([disabled])').count())throw Error('Navigator controls enabled');
 await op.click('[data-dir="South"]');await nav.waitForFunction(()=>document.querySelector('#coordinate-label').textContent.includes('A2'));
 await op.reload();await op.locator('#gameplay').waitFor({state:'visible'});
 if(await op.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
 await nav.screenshot({path:path.join(__dirname,'navigator-check.png'),fullPage:true});await op.screenshot({path:path.join(__dirname,'operator-check.png'),fullPage:true});
 if(errors.length)throw Error(errors.join(';'));
 console.log('PASS: two independent browser sessions, create/join/start, 25-cell map, blind Operator, movement synchronization, refresh recovery, 390px layout, no browser exceptions. Backend storage mocked.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
