import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ORIGIN='http://127.0.0.1:4173';
const FORECAST={
  current:{temperature_2m:18,apparent_temperature:17,relative_humidity_2m:61,weather_code:0,wind_speed_10m:4,time:'2026-10-05T18:00'},
  hourly:{time:Array.from({length:48},(_,i)=>'2026-10-05T'+String((18+i)%24).padStart(2,'0')+':00'),temperature_2m:Array(48).fill(18),weather_code:Array(48).fill(0),precipitation_probability:Array(48).fill(0)},
  daily:{time:['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'],weather_code:Array(7).fill(0),temperature_2m_max:Array(7).fill(22),temperature_2m_min:Array(7).fill(15),precipitation_probability_max:Array(7).fill(0),sunrise:Array(7).fill('2026-10-05T05:32'),sunset:Array(7).fill('2026-10-05T17:18')}
};
const ZIP={status:200,message:null,results:[{zipcode:'9820032',prefcode:'04',address1:'宮城県',address2:'仙台市太白区',address3:'富沢',kana1:'ミヤギケン',kana2:'センダイシタイハクク',kana3:'トミザワ'}]};
const GEO={results:[{id:1,name:'仙台市太白区 富沢',latitude:38.209958,longitude:140.860147,country:'日本',country_code:'JP',admin1:'宮城県',admin2:'仙台市太白区'}]};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block',permissions:['geolocation'],geolocation:{latitude:38.209958,longitude:140.860147}});
const page=await context.newPage();
const errors=[];
let forecastRequests=0;
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text())});
await page.route('https://api.open-meteo.com/v1/forecast**',async route=>{forecastRequests++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(FORECAST)})});
await page.route('https://geocoding-api.open-meteo.com/v1/search**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(GEO)}));
await page.route('https://zipcloud.ibsnet.co.jp/api/search**',async route=>{
  const cb=new URL(route.request().url()).searchParams.get('callback')||'__noop';
  await route.fulfill({status:200,contentType:'application/javascript',body:`${cb}(${JSON.stringify(ZIP)})`});
});

let completed=0,failure=null,started=Date.now();
try{
  await page.goto(ORIGIN+'/index.html?weather-test=v2', {waitUntil:'domcontentloaded'});
  await page.locator('button.clk-controls__btn[aria-label="天気"]').evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
  await page.waitForTimeout(10);

  const edit=page.locator('.clk-weather__edit-btn');
  const mode=page.locator('.clk-weather__mode-btn');
  const refresh=page.locator('.clk-weather__refresh-btn');
  const input=page.locator('.clk-wx-picker__input');
  assert.equal(await edit.getAttribute('aria-expanded'),'false');
  assert.ok(await mode.count());
  assert.ok(await refresh.count());

  const clickRaw=async locator=>{await locator.evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})))};

  // 350: edit open/close, alternating for every click.
  let openState=false;
  for(let i=0;i<350;i++){await clickRaw(edit);completed++;openState=!openState;assert.equal(await edit.getAttribute('aria-expanded'),String(openState),`edit click #${i+1}`)}

  // 250: auto/manual toggle, alternating state after every click.
  let autoState=(await mode.innerText()).includes('自動');
  for(let i=0;i<250;i++){await clickRaw(mode);completed++;await page.waitForTimeout(1);autoState=!autoState;assert.equal((await mode.innerText()).includes('自動'),autoState,`mode click #${i+1}`)}

  // 200: refresh weather.
  for(let i=0;i<200;i++){await clickRaw(refresh);completed++;await page.waitForTimeout(1);assert.match((await refresh.innerText()).trim(),/更新したばかり|更新中|分前に更新/,`refresh #${i+1}`)}

  // 200: 100 postal searches + result selections.
  for(let i=0;i<100;i++){
    if((await edit.getAttribute('aria-expanded'))!=='true'){await clickRaw(edit);completed++;openState=true;assert.equal(await edit.getAttribute('aria-expanded'),'true')}
    await input.fill('982-0032');
    await page.locator('.clk-wx-picker__row').first().waitFor({state:'visible',timeout:3000});
    assert.match(await page.locator('.clk-wx-picker__row').first().innerText(),/富沢/,`zip result #${i+1}`);
    await page.locator('.clk-wx-picker__row').first().evaluate(el=>el.click());completed++;
    await page.waitForTimeout(1);
    assert.equal(await edit.getAttribute('aria-expanded'),'false',`zip close #${i+1}`);
  }

  assert.equal(completed,1000);
  assert.equal(errors.length,0,`browser errors: ${errors.join(' | ')}`);
  assert.ok(forecastRequests>0);
}catch(e){failure=String(e?.stack||e)}

const report={ok:!failure,requested_operations:1000,completed_operations:completed,elapsed_ms:Date.now()-started,forecast_requests:forecastRequests,features:{edit_address:true,auto_manual_toggle:true,refresh_weather:true,zip_search:true},browser_errors:errors,failure,timestamp:new Date().toISOString()};
await fs.writeFile('weather-ui-test-v2-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
await browser.close();
if(failure)process.exit(1);
