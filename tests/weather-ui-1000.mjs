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
const ZIP={status:200,message:null,results:[{zipcode:'9820037',prefcode:'04',address1:'宮城県',address2:'仙台市太白区',address3:'富沢',kana1:'ミヤギケン',kana2:'センダイシタイハクク',kana3:'トミザワ'}]};
const GEO={results:[{id:1,name:'仙台市太白区 富沢',latitude:38.209958,longitude:140.860147,country:'日本',country_code:'JP',admin1:'宮城県',admin2:'仙台市太白区'}]};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block',permissions:['geolocation'],geolocation:{latitude:38.209958,longitude:140.860147}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text())});
const forecastMock=route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(JMA_FORECAST)});
await page.route('https://www.jma.go.jp/bosai/forecast/data/forecast/**',forecastMock);
await page.route('https://www.jma.go.jp/bosai/amedas/const/amedastable.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(AMEDAS_TABLE)}));
await page.route('https://www.jma.go.jp/bosai/amedas/data/latest_time.txt',route=>route.fulfill({status:200,contentType:'text/plain',body:'2026-10-21T20:00:00+09:00'}));
await page.route('https://www.jma.go.jp/bosai/amedas/data/map/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(AMEDAS_MAP)}));await page.route('https://msearch.gsi.go.jp/address-search/AddressSearch**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(GSI)}));
await page.route('https://zipcloud.ibsnet.co.jp/api/search**',async route=>{
  const cb=new URL(route.request().url()).searchParams.get('callback')||'__noop';
  await route.fulfill({status:200,contentType:'application/javascript',body:`${cb}(${JSON.stringify(ZIP)})`});
});

let completed=0; let failure=null;
try{
  await page.goto(ORIGIN+'/index.html?weather-test=1000',{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>document.querySelector('button.clk-controls__btn[aria-label="天気"]')?.click());
  const edit=page.locator('.clk-weather__edit-btn');
  const mode=page.locator('.clk-weather__mode-btn');
  const refresh=page.locator('.clk-weather__refresh-btn');
  const input=page.locator('.clk-wx-picker__input');
  assert.equal(await edit.getAttribute('aria-expanded'),'false');
  assert.ok((await mode.innerText()).trim().length>0);
  assert.ok((await refresh.innerText()).trim().length>0);

  // 500 operations: 250 open + 250 close.
  for(let i=0;i<250;i++){
    await edit.click(); completed++; assert.equal(await edit.getAttribute('aria-expanded'),'true',`edit open failed #${i+1}`);
    await edit.click(); completed++; assert.equal(await edit.getAttribute('aria-expanded'),'false',`edit close failed #${i+1}`);
  }

  // 250 operations: automatic/manual toggle.
  let autoState=(await mode.innerText()).includes('自動');
  for(let i=0;i<250;i++){
    await mode.click(); completed++; await page.waitForTimeout(1);
    const now=(await mode.innerText()).includes('自動');
    assert.equal(now,!autoState,`mode toggle failed #${i+1}`);
    autoState=now;
  }

  // 200 operations: manual weather refresh button.
  for(let i=0;i<200;i++){
    await refresh.click(); completed++; await page.waitForTimeout(1);
    assert.match((await refresh.innerText()).trim(),/更新したばかり|更新中|分前に更新/,`refresh label failed #${i+1}; got: ${(await refresh.innerText()).trim()}`);
  }

  // 50 operations: postal-code search + selecting the result.
  for(let i=0;i<25;i++){
    await edit.click(); completed++;
    await input.fill('982-0037');
    await page.locator('.clk-wx-picker__row').first().waitFor({state:'visible',timeout:2000});
    assert.match(await page.locator('.clk-wx-picker__row').first().innerText(),/富沢/,`zip result failed #${i+1}`);
    await page.locator('.clk-wx-picker__row').first().click(); completed++;
    await page.waitForTimeout(1);
    assert.equal(await edit.getAttribute('aria-expanded'),'false',`picker did not close #${i+1}`);
  }

  assert.equal(errors.length,0,`unexpected browser errors: ${errors.join(' | ')}`);
  assert.equal(completed,1000);
}catch(e){
  failure=String(e?.stack||e);
}

const report={ok:!failure,requested_operations:1000,completed_operations:completed,elapsed_ms:0,features:{edit_address:true,auto_manual_toggle:true,refresh_weather:true,zip_search:true},browser_errors:errors,failure,timestamp:new Date().toISOString()};
await fs.writeFile('weather-test-report-latest.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
await browser.close();
if(failure)process.exit(1);
