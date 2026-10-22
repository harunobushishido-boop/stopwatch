(function () {
  'use strict';

  // このキーは公開ページのJavaScriptから読めます。ユーザーの指定により直接埋め込みます。
  const WEATHERAPI_KEY = '';
  const CACHE_PREFIX = 'pc-weather-forecast-v2:';
  const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const nativeFetch = window.fetch.bind(window);

  function cacheKey(lat, lon) {
    return CACHE_PREFIX + Number(lat).toFixed(3) + ',' + Number(lon).toFixed(3);
  }

  function numericOrBlank(value) {
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : Number(value);
  }

  function probabilityOrBlank(value) {
    const n = numericOrBlank(value);
    return n === '' ? '' : Math.max(0, Math.min(100, Math.round(n)));
  }

  function jstIso(value) {
    let s = String(value || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    s = s.replace(' ', 'T');
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return s;
    if (/T\d{2}:\d{2}$/.test(s)) s += ':00';
    return s + '+09:00';
  }

  async function requestJson(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, timeoutMs || 7000);
    try {
      const response = await nativeFetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error('JSONの形式が不正です');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function hasSeries(item, field) {
    return Array.isArray(item && item.timeSeries) &&
      item.timeSeries.some(function (ts) {
        return Array.isArray(ts.timeDefines) &&
          Array.isArray(ts.areas) &&
          ts.areas.some(function (area) { return Array.isArray(area[field]); });
      });
  }

  function validForecast(data) {
    if (!Array.isArray(data) || !data.length || !data[0]) return false;
    const weekly = data.find(function (item, index) {
      return index > 0 && Array.isArray(item && item.timeSeries) && item.timeSeries.length > 0;
    }) || data[data.length - 1];
    return hasSeries(data[0], 'weatherCodes') &&
      hasSeries(data[0], 'pops') &&
      hasSeries(weekly, 'weatherCodes');
  }

  function attachMeta(forecast, source, fetchedAt, stale) {
    forecast.__source = source;
    forecast.__fetchedAt = fetchedAt || Date.now();
    forecast.__stale = Boolean(stale);
    return forecast;
  }

  function saveForecast(key, forecast) {
    try {
      localStorage.setItem(key, JSON.stringify({
        version: 2,
        source: forecast.__source,
        fetchedAt: forecast.__fetchedAt || Date.now(),
        forecast: forecast
      }));
    } catch (error) {
      // ストレージ容量やプライベートモードの制限があっても予報表示は続行します。
    }
    return forecast;
  }

  function readForecastCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (!cached || cached.version !== 2 || !Array.isArray(cached.forecast) ||
          !validForecast(cached.forecast) || !Number.isFinite(Number(cached.fetchedAt))) return null;
      if (Date.now() - Number(cached.fetchedAt) > MAX_STALE_MS) return null;
      const when = new Date(Number(cached.fetchedAt)).toLocaleString('ja-JP', { hour12: false });
      return attachMeta(
        cached.forecast,
        '前回保存（' + (cached.source || '天気API') + '・' + when + '）',
        Number(cached.fetchedAt),
        true
      );
    } catch (error) {
      return null;
    }
  }

  function jmaCodeFromOpenMeteo(value) {
    const code = Number(value);
    if ([71, 73, 75, 77, 85, 86].indexOf(code) !== -1) return '400';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].indexOf(code) !== -1) return '300';
    if (code === 0 || code === 1) return '100';
    if (Number.isFinite(code)) return '200';
    return '200';
  }

  function jmaCodeFromWeatherApi(code, text) {
    const name = String(text || '').toLowerCase();
    if (/snow|sleet|blizzard|ice|freezing/.test(name) ||
        [1066, 1069, 1072, 1114, 1117, 1147].indexOf(Number(code)) !== -1) return '400';
    if (/rain|drizzle|shower|thunder|storm/.test(name) ||
        [1087, 1117, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201, 1240, 1243, 1246, 1273, 1276].indexOf(Number(code)) !== -1) return '300';
    if (Number(code) === 1000 || /sunny|clear/.test(name)) return '100';
    return '200';
  }

  function makeJmaShape(hourRows, dayRows, office, source) {
    if (!hourRows.length || !dayRows.length) throw new Error(source + 'に予報データがありません');
    const forecastArea = {
      name: String((office && office.pref) || (office && office.label) || '宮城県'),
      code: String((office && office.code) === '040000' ? '040010' : ((office && office.code) || '040000'))
    };
    // 宮城県は東西で予報区域が分かれるため、既存の地域選択ロジックに合わせます。
    if (office && office.code === '040000') forecastArea.code = Number(office.lon || 140.863) >= 140.35 ? '040010' : '040020';
    const tempArea = { name: String((office && office.label) || forecastArea.name), code: forecastArea.code };
    const hourlyTimes = hourRows.map(function (row) { return row.iso; });
    const dailyTimes = dayRows.map(function (row) { return row.date; });
    const forecast = [
      {
        publishingOffice: source,
        timeSeries: [
          { timeDefines: hourlyTimes, areas: [{ area: forecastArea, weatherCodes: hourRows.map(function (r) { return r.code; }) }] },
          { timeDefines: hourlyTimes, areas: [{ area: forecastArea, pops: hourRows.map(function (r) { return r.pop; }) }] },
          { timeDefines: hourlyTimes, areas: [{ area: tempArea, temps: hourRows.map(function (r) { return r.temp; }) }] }
        ]
      },
      {
        publishingOffice: source,
        timeSeries: [
          { timeDefines: dailyTimes, areas: [{ area: forecastArea, weatherCodes: dayRows.map(function (r) { return r.code; }), pops: dayRows.map(function (r) { return r.pop; }) }] },
          { timeDefines: dailyTimes, areas: [{ area: tempArea, tempsMin: dayRows.map(function (r) { return r.min; }), tempsMax: dayRows.map(function (r) { return r.max; }) }] }
        ]
      }
    ];
    return attachMeta(forecast, source, Date.now(), false);
  }

  function fromOpenMeteo(data, office) {
    const h = data && data.hourly;
    const d = data && data.daily;
    if (!h || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m) ||
        !Array.isArray(h.weather_code) || !d || !Array.isArray(d.time) ||
        !Array.isArray(d.weather_code) || !Array.isArray(d.temperature_2m_min) ||
        !Array.isArray(d.temperature_2m_max)) {
      throw new Error('Open-Meteoの予報データ形式が不正です');
    }
    const hourRows = h.time.map(function (time, i) {
      return {
        iso: jstIso(time),
        temp: numericOrBlank(h.temperature_2m[i]),
        code: jmaCodeFromOpenMeteo(h.weather_code[i]),
        pop: probabilityOrBlank(h.precipitation_probability && h.precipitation_probability[i])
      };
    }).filter(function (row) { return Boolean(row.iso); });
    const dayRows = d.time.map(function (date, i) {
      return {
        date: String(date),
        code: jmaCodeFromOpenMeteo(d.weather_code[i]),
        pop: probabilityOrBlank(d.precipitation_probability_max && d.precipitation_probability_max[i]),
        min: numericOrBlank(d.temperature_2m_min[i]),
        max: numericOrBlank(d.temperature_2m_max[i])
      };
    }).filter(function (row) { return /^\d{4}-\d{2}-\d{2}$/.test(row.date); });
    return makeJmaShape(hourRows, dayRows, office, 'Open-Meteo');
  }

  function fromWeatherApi(data, office) {
    const forecastDays = data && data.forecast && data.forecast.forecastday;
    if (!Array.isArray(forecastDays) || !forecastDays.length) {
      throw new Error('WeatherAPI.comの予報データ形式が不正です');
    }
    const hourRows = [];
    const dayRows = [];
    forecastDays.forEach(function (day) {
      if (!day || !day.day || !day.date) return;
      (Array.isArray(day.hour) ? day.hour : []).forEach(function (hour) {
        if (!hour || !hour.time) return;
        const code = hour.condition && hour.condition.code;
        const text = hour.condition && hour.condition.text;
        const rain = numericOrBlank(hour.chance_of_rain);
        const snow = numericOrBlank(hour.chance_of_snow);
        const pop = rain === '' ? snow : (snow === '' ? rain : Math.max(rain, snow));
        hourRows.push({
          iso: jstIso(hour.time),
          temp: numericOrBlank(hour.temp_c),
          code: jmaCodeFromWeatherApi(code, text),
          pop: probabilityOrBlank(pop)
        });
      });
      const condition = day.day.condition || {};
      const rainChance = numericOrBlank(day.day.daily_chance_of_rain);
      const snowChance = numericOrBlank(day.day.daily_chance_of_snow);
      dayRows.push({
        date: String(day.date),
        code: jmaCodeFromWeatherApi(condition.code, condition.text),
        pop: probabilityOrBlank(rainChance === '' ? snowChance : (snowChance === '' ? rainChance : Math.max(rainChance, snowChance))),
        min: numericOrBlank(day.day.mintemp_c),
        max: numericOrBlank(day.day.maxtemp_c)
      });
    });
    return makeJmaShape(hourRows, dayRows, office, 'WeatherAPI.com');
  }

  function makeOpenMeteoUrl(lat, lon) {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'Asia/Tokyo',
      forecast_days: '7'
    });
    return 'https://api.open-meteo.com/v1/forecast?' + params.toString();
  }

  function getWeatherApiKey() {
    let key = WEATHERAPI_KEY;
    try {
      if (!key) key = String(localStorage.getItem('pc-weatherapi-key') || '').trim();
    } catch (error) {}
    if (!key) throw new Error('WeatherAPI.comのAPIキーが未設定です。天気パネルの設定ボタンから登録してください。');
    return key;
  }

  function makeWeatherApiUrl(lat, lon) {
    const params = new URLSearchParams({
      key: getWeatherApiKey(),
      q: Number(lat) + ',' + Number(lon),
      days: '3',
      aqi: 'no',
      alerts: 'no'
    });
    return 'https://api.weatherapi.com/v1/forecast.json?' + params.toString();
  }

  async function getForecast(lat, lon, office) {
    const key = cacheKey(lat, lon);
    const jmaUrl = 'https://www.jma.go.jp/bosai/forecast/data/forecast/' + office.code + '.json';
    const failures = [];

    try {
      const jma = await requestJson(jmaUrl, 6500);
      if (!validForecast(jma)) throw new Error('気象庁の予報項目が不足しています');
      return saveForecast(key, attachMeta(jma, '気象庁 ' + ((jma[0] && jma[0].publishingOffice) || office.pref || ''), Date.now(), false));
    } catch (error) {
      failures.push('気象庁: ' + String(error && error.message || error));
    }

    try {
      const openMeteo = fromOpenMeteo(await requestJson(makeOpenMeteoUrl(lat, lon), 7500), Object.assign({}, office, { lon: Number(lon) }));
      if (!validForecast(openMeteo)) throw new Error('Open-Meteoの予報データを検証できません');
      return saveForecast(key, openMeteo);
    } catch (error) {
      failures.push('Open-Meteo: ' + String(error && error.message || error));
    }

    try {
      const weatherApi = fromWeatherApi(await requestJson(makeWeatherApiUrl(lat, lon), 7500), Object.assign({}, office, { lon: Number(lon) }));
      if (!validForecast(weatherApi)) throw new Error('WeatherAPI.comの予報データを検証できません');
      return saveForecast(key, weatherApi);
    } catch (error) {
      failures.push('WeatherAPI.com: ' + String(error && error.message || error));
    }

    const cached = readForecastCache(key);
    if (cached) {
      console.warn('すべての天気予報APIに失敗したため、前回保存データを使用します。', failures);
      return cached;
    }
    throw new Error('気象庁・Open-Meteo・WeatherAPI.comから予報を取得できませんでした。' + failures.join(' / '));
  }

  async function getBackupForecast(lat, lon, office) {
    const key = cacheKey(lat, lon);
    const failures = [];
    try {
      const openMeteo = fromOpenMeteo(await requestJson(makeOpenMeteoUrl(lat, lon), 7500), Object.assign({}, office, { lon: Number(lon) }));
      if (!validForecast(openMeteo)) throw new Error('Open-Meteoの予報データを検証できません');
      return saveForecast(key, openMeteo);
    } catch (error) {
      failures.push('Open-Meteo: ' + String(error && error.message || error));
    }
    try {
      const weatherApi = fromWeatherApi(await requestJson(makeWeatherApiUrl(lat, lon), 7500), Object.assign({}, office, { lon: Number(lon) }));
      if (!validForecast(weatherApi)) throw new Error('WeatherAPI.comの予報データを検証できません');
      return saveForecast(key, weatherApi);
    } catch (error) {
      failures.push('WeatherAPI.com: ' + String(error && error.message || error));
    }
    const cached = readForecastCache(key);
    if (cached) {
      console.warn('予報APIが失敗したため、前回保存データを使用します。', failures);
      return cached;
    }
    throw new Error('Open-Meteo・WeatherAPI.comから予報を取得できず、利用可能な保存データもありません。' + failures.join(' / '));
  }

  async function enrichWithHourlyForecast(lat, lon, office, forecast) {
    if (!Array.isArray(forecast) || !forecast.length || !forecast[0] || !Array.isArray(forecast[0].timeSeries)) return forecast;
    const currentSource = String(forecast.__source || '');
    // Open-Meteo / WeatherAPI の fallback データには既に時間別の系列があります。
    if (/Open-Meteo|WeatherAPI\.com/.test(currentSource) || forecast.__stale) return forecast;

    const key = cacheKey(lat, lon);
    const failures = [];
    const providers = [
      {
        name: 'Open-Meteo',
        load: async function () {
          return fromOpenMeteo(
            await requestJson(makeOpenMeteoUrl(lat, lon), 7500),
            Object.assign({}, office, { lon: Number(lon) })
          );
        }
      },
      {
        name: 'WeatherAPI.com',
        load: async function () {
          return fromWeatherApi(
            await requestJson(makeWeatherApiUrl(lat, lon), 7500),
            Object.assign({}, office, { lon: Number(lon) })
          );
        }
      }
    ];

    for (const provider of providers) {
      try {
        const supplemental = await provider.load();
        const series = supplemental && supplemental[0] && supplemental[0].timeSeries;
        if (!Array.isArray(series)) throw new Error('時間別予報がありません');
        const weather = series.find(function (ts) { return ts.areas && ts.areas.some(function (a) { return Array.isArray(a.weatherCodes); }); });
        const pops = series.find(function (ts) { return ts.areas && ts.areas.some(function (a) { return Array.isArray(a.pops); }); });
        const temps = series.find(function (ts) { return ts.areas && ts.areas.some(function (a) { return Array.isArray(a.temps); }); });
        if (!weather || !pops || !temps ||
            !Array.isArray(weather.timeDefines) || weather.timeDefines.length < 4 ||
            !Array.isArray(pops.timeDefines) || !Array.isArray(temps.timeDefines)) {
          throw new Error('時間別の天気・降水確率・気温がそろっていません');
        }

        const base = forecast[0];
        const existing = Array.isArray(base.timeSeries) ? base.timeSeries : [];
        const isWeatherSeries = function (ts) { return ts && ts.areas && ts.areas.some(function (a) { return Array.isArray(a.weatherCodes); }); };
        const isPopSeries = function (ts) { return ts && ts.areas && ts.areas.some(function (a) { return Array.isArray(a.pops); }); };
        const isTempSeries = function (ts) { return ts && ts.areas && ts.areas.some(function (a) { return Array.isArray(a.temps); }); };
        // 時間別系列を先頭に置き、既存の描画処理がより細かい時刻を使えるようにします。
        base.timeSeries = [weather, pops, temps].concat(existing.filter(function (ts) {
          return !isWeatherSeries(ts) && !isPopSeries(ts) && !isTempSeries(ts);
        }));
        forecast.__source = '気象庁（地域・週間予報）＋' + provider.name + '（時間別予報）';
        forecast.__fetchedAt = Date.now();
        forecast.__stale = false;
        return saveForecast(key, forecast);
      } catch (error) {
        failures.push(provider.name + ': ' + String(error && error.message || error));
      }
    }

    if (failures.length) {
      forecast.__source = '気象庁（地域・週間予報）／時間別予報の補完に失敗';
      console.warn('時間別予報の補完に失敗しました。気象庁の通常予報を表示します。', failures);
    }
    return forecast;
  }

  function rememberForecast(lat, lon, forecast, source) {
    const label = source || ('気象庁 ' + String(forecast && forecast[0] && forecast[0].publishingOffice || '公式予報'));
    attachMeta(forecast, label, Date.now(), false);
    return saveForecast(cacheKey(lat, lon), forecast);
  }

  window.__weatherFallback = {
    getForecast: getForecast,
    getBackupForecast: getBackupForecast,
    enrichWithHourlyForecast: enrichWithHourlyForecast,
    rememberForecast: rememberForecast,
    isValidForecast: validForecast
  };

  function installWeatherApiKeyControl() {
    const footer = document.querySelector('.clk-weather__footer');
    if (!footer || document.getElementById('pcWeatherApiKeyButton')) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px';
    const button = document.createElement('button');
    button.id = 'pcWeatherApiKeyButton';
    button.type = 'button';
    button.textContent = 'WeatherAPI.com のキーを設定';
    button.style.cssText = 'align-self:flex-start;padding:8px 12px;border:1px solid currentColor;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer';
    const status = document.createElement('span');
    status.id = 'pcWeatherApiKeyStatus';
    status.style.cssText = 'font-size:11px;opacity:.75';
    const updateStatus = () => {
      let saved = '';
      try { saved = String(localStorage.getItem('pc-weatherapi-key') || '').trim(); } catch (error) {}
      status.textContent = saved ? 'このブラウザーにキーを保存済み' : '未設定（他のAPIが失敗した場合のみ使用）';
    };
    button.addEventListener('click', () => {
      let previous = '';
      try { previous = String(localStorage.getItem('pc-weatherapi-key') || ''); } catch (error) {}
      const value = window.prompt('WeatherAPI.comのAPIキーを入力してください。この端末のブラウザー内に保存されます。キーはサイトのコードには書き込みません。空欄で保存済みキーを削除できます。', previous);
      if (value === null) return;
      try {
        if (String(value).trim()) localStorage.setItem('pc-weatherapi-key', String(value).trim());
        else localStorage.removeItem('pc-weatherapi-key');
      } catch (error) {
        window.alert('このブラウザーにキーを保存できませんでした。');
        return;
      }
      updateStatus();
      if (String(value).trim()) document.querySelector('.clk-weather__refresh-btn')?.click();
    });
    wrap.append(button, status);
    footer.insertBefore(wrap, footer.firstChild || null);
    updateStatus();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWeatherApiKeyControl, { once: true });
  } else {
    installWeatherApiKeyControl();
  }

  // 「履歴を見る」はパネル内だけをスクロールさせ、画面全体のスクロールと分離します。
  const style = document.createElement('style');
  style.id = 'pc-weather-fallback-history-scroll';
  style.textContent =
    '.clk-stage--sw-main>.clk-sw-history-panel{display:flex!important;flex-direction:column!important;box-sizing:border-box;max-height:min(52vh,460px)!important;min-height:0;overflow:hidden!important}' +
    '.clk-stage--sw-main>.clk-sw-history-panel .clk-lap-list--scroll{flex:0 1 auto;min-height:0;max-height:min(38vh,320px)!important;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;scrollbar-width:thin}' +
    '@media(max-width:720px){.clk-stage--sw-main>.clk-sw-history-panel{max-height:56vh!important}.clk-stage--sw-main>.clk-sw-history-panel .clk-lap-list--scroll{max-height:42vh!important}}';
  (document.head || document.documentElement).appendChild(style);
})();