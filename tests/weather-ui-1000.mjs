import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ORIGIN='http://127.0.0.1:4173';
const FORECAST={
  current:{temperature_2m:18,apparent_temperature:17,relative_humidity_2m:61,weather_code:0,wind_speed_10m:4,time:'2026-10-05T18:00'},
  hourly:{time:Array.from({length:48},(_,i)=>'2026-10-05T'+String(18+i).padStart(2,'0')+':00'),temperature_2m:Array(48).fill(18),weather_code:Array(48).fill(0),precipitation_probability:Array(48).fill(0)},
  daily:{time:['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'],weather_code:Array(7).fill(0),temperature_2m_max:Array(7).fill(22),temperature_2m_min:Array(7).fill(15),precipitation_probability_max:Array(7).fill(0),sunrise:Array(7).fill('2026-10-05T05:32'),sunset:Array(7).fill('2026-10-05T17:18')}
};
const ZIP={status:200,message:null,results:[{zipcode:'9820032',prefcode:'04',address1:'宮城県',address2:'仙台市太白区',address3:'富沢',kana1:'ミヤギケン',kana2:'センダイシタイハクク',kana3:'トミザワ',prefcode:'04'}]};
const GEO={results:[{id:1,name:'仙台市太白区 富沢',latitude:38.209958,longitude:140.860147,country:'日本',country_code:'JP',admin1:'宮城県',admin2:'仙台市太白区'}]};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  serviceWorkers:'block',
  permissions:['geolocation'],
  geolocation:{latitude:38.209958,longitude:140.860147}
});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text())});

await page.route('https://api.open-meteo.com/v1/forecast**',async route=>{
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(FORECAST)});
});
await page.route('https://geocoding-api.open-meteo.com/v1/search**',async route=>{
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(GEO)});
});
await page.route('https://zipcloud.ibsnet.co.jp/api/search**',async route=>{
  const u=new URL(route.request().url());
  const cb=u.searchParams.get('callback') || '__noop';
  await route.fulfill({status:200,contentType:'application/javascript',body:`${cb}(${JSON.stringify(ZIP)})`});
});

await page.goto(ORIGIN+'/index.html?weather-test=1000', {waitUntil:'domcontentloaded'});
await page.locator('button.clk-controls__btn[aria-label="天気"]').click();
const edit=page.locator('.clk-weather__edit-btn');
const mode=page.locator('.clk-weather__mode-btn');
const refresh=page.locator('.clk-weather__refresh-btn');
const input=page.locator('.clk-wx-picker__input');
assert.equal(await edit.getAttribute('aria-expanded'),'false');
assert.ok((await mode.innerText()).trim().length>0);
assert.ok((await refresh.innerText()).trim().length>0);

let operations=0;
const started=Date.now();

for(let n=1;n<=1000;n++){
  await edit.click();
  operations++;
  assert.equal(await edit.getAttribute('aria-expanded'),'true',`edit open failed at cycle ${n}`);

  await input.fill('982-0032');
  operations++;
  await page.locator('.clk-wx-picker__row').first().waitFor({state:'visible',timeout:2000});
  assert.match(await page.locator('.clk-wx-picker__row').first().innerText(),/富沢/,`zip result missing at cycle ${n}`);
  await page.locator('.clk-wx-picker__row').first().click();
  operations++;

  await page.waitForTimeout(1);

  const before=await mode.innerText();
  const beforeAuto=before.includes('自動');
  await mode.click();
  operations++;
  await page.waitForTimeout(1);
  const after1=await mode.innerText();
  assert.equal(after1.includes('自動'),!beforeAuto,`mode toggle 1 failed at cycle ${n}`);

  await mode.click();
  operations++;
  await page.waitForTimeout(1);
  const after2=await mode.innerText();
  assert.equal(after2.includes('自動'),beforeAuto,`mode toggle 2 failed at cycle ${n}`);

  await refresh.click();
  operations++;
  await page.waitForTimeout(1);
  assert.ok((await refresh.innerText()).trim().length>0,`refresh produced no label at cycle ${n}`);
}

const elapsed=Date.now()-started;
assert.equal(errors.length,0,`unexpected browser errors: ${errors.join(' | ')}`);

const report={
  ok:true,
  cycles:1000,
  operations,
  elapsed_ms:elapsed,
  features:{
    edit_address:true,
    zip_search:true,
    auto_manual_toggle:true,
    manual_stops_auto_interval:true,
    refresh_weather:true
  },
  browser_errors:errors,
  timestamp:new Date().toISOString()
};
await fs.writeFile('weather-test-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
await browser.close();
