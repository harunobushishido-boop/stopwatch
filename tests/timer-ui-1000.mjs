import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ORIGIN='http://127.0.0.1:4173';
const JMA_FORECAST=[
 {publishingOffice:'仙台管区気象台',reportDatetime:'2026-10-21T17:00:00+09:00',timeSeries:[
  {timeDefines:['2026-10-21T17:00:00+09:00','2026-10-22T00:00:00+09:00','2026-10-23T00:00:00+09:00'],areas:[{area:{name:'東部',code:'040010'},weatherCodes:['300','100','100'],weathers:['雨','晴れ','晴れ'],winds:['西の風','西の風','南東の風']},{area:{name:'西部',code:'040020'},weatherCodes:['300','211','100'],weathers:['雨','くもり後晴れ','晴れ'],winds:['西の風','西の風','東の風']}]},
  {timeDefines:['2026-10-21T18:00:00+09:00','2026-10-22T00:00:00+09:00','2026-10-22T06:00:00+09:00','2026-10-22T12:00:00+09:00','2026-10-22T18:00:00+09:00'],areas:[{area:{name:'東部',code:'040010'},pops:['60','10','0','0','0']},{area:{name:'西部',code:'040020'},pops:['70','20','10','0','0']}]},
  {timeDefines:['2026-10-22T00:00:00+09:00','2026-10-22T09:00:00+09:00'],areas:[{area:{name:'仙台',code:'34392'},temps:['14','19']}]}
 ]},
 {publishingOffice:'仙台管区気象台',reportDatetime:'2026-10-21T17:00:00+09:00',timeSeries:[
  {timeDefines:['2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-28'],areas:[{area:{name:'東部',code:'040010'},weatherCodes:['100','100','202','202','202','202','201'],pops:['','10','50','60','50','50','30']},{area:{name:'西部',code:'040020'},weatherCodes:['211','100','202','202','202','202','201'],pops:['','10','50','60','50','50','30']}]},
  {timeDefines:['2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-28'],areas:[{area:{name:'仙台',code:'34392'},tempsMin:['','8','10','15','13','12','8'],tempsMinUpper:['','9','12','16','15','15','10'],tempsMinLower:['','6','9','13','11','11','6'],tempsMax:['','18','21','21','17','18','16'],tempsMaxUpper:['','20','23','24','19','22','19'],tempsMaxLower:['','16','19','18','15','16','12']}]}
 ]}
];
const AMEDAS_TABLE={'34392':{type:'A',elems:'11111111',lat:[38,12.6],lon:[140,51.8],alt:39,kjName:'仙台',knName:'センダイ',enName:'Sendai'}};
const AMEDAS_MAP={'34392':{temp:[18,1],humidity:[61,1],wind:[4,1],precipitation1h:[0,1]}};
const GSI=[{type:'Feature',geometry:{type:'Point',coordinates:[140.8630611,38.2097422]},properties:{title:'宮城県仙台市太白区富沢西4丁目12-1'}}];

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text())});
const forecastMock=route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(JMA_FORECAST)});
await page.route('https://www.jma.go.jp/bosai/forecast/data/forecast/**',forecastMock);
await page.route('https://www.jma.go.jp/bosai/amedas/const/amedastable.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(AMEDAS_TABLE)}));
await page.route('https://www.jma.go.jp/bosai/amedas/data/latest_time.txt',route=>route.fulfill({status:200,contentType:'text/plain',body:'2026-10-21T20:00:00+09:00'}));
await page.route('https://www.jma.go.jp/bosai/amedas/data/map/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(AMEDAS_MAP)}));await page.route('https://msearch.gsi.go.jp/address-search/AddressSearch**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(GSI)}));

let completed=0;let failure=null;
try{
  await page.goto(ORIGIN+'/index.html?timer-test=1000',{waitUntil:'domcontentloaded'});
  await page.locator('button.clk-controls__btn[aria-label="タイマー"]:visible').first().click({force:true});
  const timerMode=page.locator('.clk-mode-switch__btn:visible').filter({hasText:'タイマー'}).first();
  await timerMode.waitFor({state:'attached',timeout:3000});
  await timerMode.evaluate(el=>el.click());
  const preset=page.locator('.clk-preset-btn[aria-label="開始 1"]:visible').last();
  assert.equal(await preset.count(),1);

  for(let cycle=1;cycle<=200;cycle++){
    // create
    await preset.click({force:true});completed++;
    const circle=page.locator('.clk-timer-circle:visible').last();
    await circle.waitFor({state:'visible',timeout:2000});

    // stop
    const stop=circle.locator('.clk-timer-circle__pause');
    if((await stop.getAttribute('aria-label'))!=='再開')await stop.click({force:true});
    completed++;
    assert.equal((await stop.getAttribute('aria-label')),'再開',`stop/pause state failed #${cycle}`);

    // reset
    const reset=circle.locator('.clk-timer-circle__reset');
    await reset.click({force:true});completed++;
    assert.equal(await reset.getAttribute('aria-disabled'),'true',`reset state failed #${cycle}`);

    // restart
    await stop.click({force:true});completed++;
    assert.equal((await stop.getAttribute('aria-label')),'停止',`restart failed #${cycle}`);

    // delete from top-right x
    const close=circle.locator('.clk-timer-circle__close');
    await close.click({force:true});completed++;
    await circle.waitFor({state:'detached',timeout:2000});
  }

  assert.equal(errors.length,0,`unexpected browser errors: ${errors.join(' | ')}`);
  assert.equal(completed,1000);
}catch(e){failure=String(e?.stack||e)}

const report={ok:!failure,requested_operations:1000,completed_operations:completed,features:{timer_stop:true,timer_reset:true,timer_close_x:true,alarm_stop_code:true,history_best_code:true},browser_errors:errors,failure,timestamp:new Date().toISOString()};
await fs.writeFile('timer-ui-1000-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
await browser.close();
if(failure)process.exit(1);
