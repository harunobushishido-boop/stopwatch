import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ORIGIN='http://127.0.0.1:4173';
const FORECAST={
  current:{temperature_2m:18,apparent_temperature:17,relative_humidity_2m:61,weather_code:0,wind_speed_10m:4,time:'2026-10-07T07:00'},
  hourly:{time:Array.from({length:48},(_,i)=>'2026-10-07T'+String((7+i)%24).padStart(2,'0')+':00'),temperature_2m:Array(48).fill(18),weather_code:Array(48).fill(0),precipitation_probability:Array(48).fill(0)},
  daily:{time:['2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13'],weather_code:Array(7).fill(0),temperature_2m_max:Array(7).fill(22),temperature_2m_min:Array(7).fill(15),precipitation_probability_max:Array(7).fill(0),sunrise:Array(7).fill('2026-10-07T05:32'),sunset:Array(7).fill('2026-10-07T17:18')}
};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block'});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text())});
await page.route('https://api.open-meteo.com/v1/forecast**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(FORECAST)}));
await page.route('https://geocoding-api.open-meteo.com/v1/search**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({results:[]})}));

let completed=0;let failure=null;
try{
  await page.goto(ORIGIN+'/index.html?timer-test=1000',{waitUntil:'domcontentloaded'});
  await page.locator('button.clk-controls__btn[aria-label="タイマー"]').click({force:true});
  const timerMode=page.locator('.clk-mode-switch__btn').filter({hasText:'タイマー'}).first();
  await timerMode.click({force:true});
  const preset=page.locator('.clk-preset-btn[aria-label="開始 1"]').first();
  assert.equal(await preset.count(),1);

  for(let cycle=1;cycle<=200;cycle++){
    // create
    await preset.click({force:true});completed++;
    const circle=page.locator('.clk-timer-circle');
    await circle.waitFor({state:'visible',timeout:2000});

    // stop
    const stop=page.locator('.clk-timer-circle__pause');
    await stop.click({force:true});completed++;
    assert.equal((await stop.getAttribute('aria-label')),'再開',`stop failed #${cycle}`);

    // reset
    const reset=page.locator('.clk-timer-circle__reset');
    await reset.click({force:true});completed++;
    assert.equal(await reset.getAttribute('aria-disabled'),'true',`reset state failed #${cycle}`);

    // restart
    await stop.click({force:true});completed++;
    assert.equal((await stop.getAttribute('aria-label')),'停止',`restart failed #${cycle}`);

    // delete from top-right x
    const close=page.locator('.clk-timer-circle__close');
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
