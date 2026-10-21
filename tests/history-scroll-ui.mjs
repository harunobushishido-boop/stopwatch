import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const ORIGIN='http://127.0.0.1:4173';
const JMA_FORECAST=[
  {
    publishingOffice:'仙台管区気象台',
    reportDatetime:'2026-10-21T17:00:00+09:00',
    timeSeries:[
      {timeDefines:['2026-10-21T17:00:00+09:00','2026-10-22T00:00:00+09:00','2026-10-23T00:00:00+09:00'],areas:[
        {area:{name:'東部',code:'040010'},weatherCodes:['300','100','100'],weathers:['雨','晴れ','晴れ'],winds:['西の風','西の風','南東の風']},
        {area:{name:'西部',code:'040020'},weatherCodes:['300','211','100'],weathers:['雨','くもり後晴れ','晴れ'],winds:['西の風','西の風','東の風']}
      ]},
      {timeDefines:['2026-10-21T18:00:00+09:00','2026-10-22T00:00:00+09:00','2026-10-22T06:00:00+09:00','2026-10-22T12:00:00+09:00','2026-10-22T18:00:00+09:00'],areas:[
        {area:{name:'東部',code:'040010'},pops:['60','10','0','0','0']},
        {area:{name:'西部',code:'040020'},pops:['70','20','10','0','0']}
      ]},
      {timeDefines:['2026-10-22T00:00:00+09:00','2026-10-22T09:00:00+09:00'],areas:[
        {area:{name:'仙台',code:'34392'},temps:['14','19']}
      ]}
    ]
  },
  {
    publishingOffice:'仙台管区気象台',
    reportDatetime:'2026-10-21T17:00:00+09:00',
    timeSeries:[
      {timeDefines:['2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-28'],areas:[
        {area:{name:'東部',code:'040010'},weatherCodes:['100','100','202','202','202','202','201'],pops:['','10','50','60','50','50','30']},
        {area:{name:'西部',code:'040020'},weatherCodes:['211','100','202','202','202','202','201'],pops:['','10','50','60','50','50','30']}
      ]},
      {timeDefines:['2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-28'],areas:[
        {area:{name:'仙台',code:'34392'},tempsMin:['','8','10','15','13','12','8'],tempsMinUpper:['','9','12','16','15','15','10'],tempsMinLower:['','6','9','13','11','11','6'],tempsMax:['','18','21','21','17','18','16'],tempsMaxUpper:['','20','23','24','19','22','19'],tempsMaxLower:['','16','19','18','15','16','12']}
      ]}
    ]
  }
];
const AMEDAS_TABLE={'34392':{type:'A',elems:'11111111',lat:[38,12.6],lon:[140,51.8],alt:39,kjName:'仙台',knName:'センダイ',enName:'Sendai'}};
const AMEDAS_MAP={'34392':{temp:[18,1],humidity:[61,1],wind:[4,1],precipitation1h:[0,1]}};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
await context.addInitScript(()=>{
  const now=Date.now();
  const rows=Array.from({length:50},(_,i)=>{
    const elapsed=120000+i*1000;
    return {id:'scroll-test-'+i,at:now-i*60000,elapsed,laps:Array.from({length:8},(_,j)=>elapsed-j*9000)};
  });
  localStorage.setItem('pcswHistory',JSON.stringify(rows));
});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('https://www.jma.go.jp/bosai/forecast/data/forecast/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(JMA_FORECAST)}));
await page.route('https://www.jma.go.jp/bosai/amedas/const/amedastable.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(AMEDAS_TABLE)}));
await page.route('https://www.jma.go.jp/bosai/amedas/data/latest_time.txt',route=>route.fulfill({status:200,contentType:'text/plain',body:'2026-10-21T20:00:00+09:00'}));
await page.route('https://www.jma.go.jp/bosai/amedas/data/map/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(AMEDAS_MAP)}));

let report;
try{
  await page.goto(ORIGIN+'/index.html?history-scroll-test=1',{waitUntil:'domcontentloaded'});
  await page.locator('.clk-sw-history-toggle').waitFor({state:'attached',timeout:10000});
  await page.waitForFunction(()=>document.querySelectorAll('#clkSwHistoryList .clk-lap--history').length>=50,{timeout:10000});
  await page.evaluate(()=>document.querySelector('.clk-panel__close')?.click());
  await page.locator('.clk-sw-history-toggle').evaluate(el=>el.click());
  await page.waitForFunction(()=>{const panel=document.querySelector('#clkSwHistoryPanel');return panel&&!panel.hidden},{timeout:3000});
  const before=await page.evaluate(()=>{
    const list=document.querySelector('#clkSwHistoryList'),style=getComputedStyle(list),panel=document.querySelector('#clkSwHistoryPanel');
    return {rows:list.querySelectorAll('.clk-lap--history').length,overflowY:style.overflowY,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,scrollTop:list.scrollTop,panelOverflowY:getComputedStyle(panel).overflowY,panelHeight:panel.clientHeight};
  });
  assert.equal(before.rows,50,'seeded history rows should all render');
  assert.ok(['auto','scroll'].includes(before.overflowY),'history list must allow scrolling, got '+before.overflowY);
  assert.ok(before.clientHeight>0,'history list must have a visible height');
  assert.ok(before.scrollHeight>before.clientHeight,'history list content should exceed its viewport ('+before.scrollHeight+' <= '+before.clientHeight+')');
  const after=await page.evaluate(()=>{
    const list=document.querySelector('#clkSwHistoryList');
    list.scrollTop=list.scrollHeight;
    return {scrollTop:list.scrollTop,maxScroll:list.scrollHeight-list.clientHeight};
  });
  assert.ok(after.maxScroll>0,'history list should have a scroll range');
  assert.ok(after.scrollTop>0,'scrollTop should increase after scrolling');
  assert.ok(after.scrollTop>=after.maxScroll-2,'history list should reach its bottom');
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(60);
  const mobileBefore=await page.evaluate(()=>{const list=document.querySelector('#clkSwHistoryList');list.scrollTop=0;return{overflowY:getComputedStyle(list).overflowY,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight}});
  assert.ok(['auto','scroll'].includes(mobileBefore.overflowY),'mobile history list must allow scrolling, got '+mobileBefore.overflowY);
  assert.ok(mobileBefore.clientHeight>0,'mobile history list must have a visible height');
  assert.ok(mobileBefore.scrollHeight>mobileBefore.clientHeight,'mobile history contents should exceed the viewport');
  const mobileAfter=await page.evaluate(()=>{const list=document.querySelector('#clkSwHistoryList');list.scrollTop=list.scrollHeight;return{scrollTop:list.scrollTop,maxScroll:list.scrollHeight-list.clientHeight}});
  assert.ok(mobileAfter.maxScroll>0&&mobileAfter.scrollTop>=mobileAfter.maxScroll-2,'mobile history list should reach its bottom');
  assert.equal(errors.length,0,'page errors: '+errors.join(' | '));
  report={ok:true,historyRows:before.rows,desktop:{overflowY:before.overflowY,clientHeight:before.clientHeight,scrollHeight:before.scrollHeight,scrollTopAfter:after.scrollTop,maxScroll:after.maxScroll},mobile:{overflowY:mobileBefore.overflowY,clientHeight:mobileBefore.clientHeight,scrollHeight:mobileBefore.scrollHeight,scrollTopAfter:mobileAfter.scrollTop,maxScroll:mobileAfter.maxScroll},browserErrors:errors};
  console.log(JSON.stringify(report));
}catch(e){
  report={ok:false,error:String(e?.stack||e),browserErrors:errors};
  console.log(JSON.stringify(report));
  process.exitCode=1;
}finally{
  await browser.close();
}
