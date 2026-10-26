(function () {
  'use strict';

  // The reference HTML was saved without its linked component CSS. Re-apply the clock
  // component stylesheet that accompanies mihata.jp/clock; local overrides below/after it remain intact.
  if (!document.getElementById('pc-reference-clock-css')) {
    const referenceCss = document.createElement('link');
    referenceCss.id = 'pc-reference-clock-css';
    referenceCss.rel = 'stylesheet';
    referenceCss.href = 'https://mihata.jp/_next/static/css/3zv_yakpu51ie.css';
    referenceCss.addEventListener('error', function () {
      console.warn('Reference clock stylesheet could not be loaded; using the embedded clock styles.');
    }, { once: true });
    (document.head || document.documentElement).appendChild(referenceCss);
  }

  const YAHOO_CLIENT_ID_KEY = 'pc-yahoo-weather-client-id-v1';
  function readYahooClientId() {
    try { return String(localStorage.getItem(YAHOO_CLIENT_ID_KEY) || '').trim(); }
    catch (error) { return ''; }
  }

  function yahooJsonp(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const callbackName = '__pcYahooWeatherCallback_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      let timer = null;
      let settled = false;
      const cleanup = function () {
        if (timer) clearTimeout(timer);
        try { delete window[callbackName]; } catch (error) { window[callbackName] = undefined; }
        script.remove();
      };
      const finish = function (error, data) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(data);
      };
      window[callbackName] = function (data) { finish(null, data); };
      script.async = true;
      script.onerror = function () { finish(new Error('Yahoo! JAPAN気象情報APIに接続できませんでした。')); };
      const requestUrl = new URL(url);
      requestUrl.searchParams.set('output', 'json');
      requestUrl.searchParams.set('callback', callbackName);
      script.src = requestUrl.toString();
      timer = setTimeout(function () {
        finish(new Error('Yahoo! JAPAN気象情報APIが時間内に応答しませんでした。'));
      }, timeoutMs || 6000);
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function yahooDate(value) {
    const stamp = String(value || '');
    if (!/^\\d{12}$/.test(stamp)) return NaN;
    return Date.parse(stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) +
      'T' + stamp.slice(8, 10) + ':' + stamp.slice(10, 12) + ':00+09:00');
  }

  async function getYahooRainfall(lat, lon) {
    const clientId = readYahooClientId();
    if (!clientId) throw new Error('Yahoo! Client ID未設定');
    const url = new URL('https://map.yahooapis.jp/weather/V1/place');
    // Yahoo! 気象情報API expects longitude,latitude in that order.
    url.searchParams.set('coordinates', Number(lon) + ',' + Number(lat));
    url.searchParams.set('appid', clientId);
    const payload = await yahooJsonp(url.toString(), 6000);
    const ydf = payload && (payload.YDF || payload);
    const status = ydf && ydf.ResultInfo && Number(ydf.ResultInfo.Status);
    if (status && status !== 200) throw new Error('Yahoo! JAPAN気象情報APIの応答コード: ' + status);
    const features = Array.isArray(ydf && ydf.Feature) ? ydf.Feature : (ydf && ydf.Feature ? [ydf.Feature] : []);
    const prop = features[0] && features[0].Property;
    const list = prop && prop.WeatherList && prop.WeatherList.Weather;
    const rows = Array.isArray(list) ? list : (list ? [list] : []);
    const valid = rows.map(function (item) {
      return {
        type: String(item && item.Type || '').toLowerCase(),
        date: String(item && item.Date || ''),
        time: yahooDate(item && item.Date),
        rainfall: item && item.Rainfall !== '' && item.Rainfall !== null && item.Rainfall !== undefined && Number.isFinite(Number(item.Rainfall)) ? Number(item.Rainfall) : null
      };
    }).filter(function (item) { return item.time === item.time && item.rainfall !== null; });
    if (!valid.length) throw new Error('Yahoo! JAPANから有効な雨の強さデータが返されませんでした。');
    const observations = valid.filter(function (item) { return item.type === 'observation'; })
      .sort(function (a, b) { return a.time - b.time; });
    const forecasts = valid.filter(function (item) { return item.type === 'forecast' && item.time >= Date.now() - 10 * 60 * 1000; })
      .sort(function (a, b) { return a.time - b.time; });
    const current = observations[observations.length - 1] || null;
    const target = Date.now() + 60 * 60 * 1000;
    const next = forecasts.length ? forecasts.reduce(function (best, item) {
      return !best || Math.abs(item.time - target) < Math.abs(best.time - target) ? item : best;
    }, null) : null;
    return {
      current: current ? current.rainfall : (forecasts[0] ? forecasts[0].rainfall : null),
      nextHour: next ? next.rainfall : null,
      updatedAt: current ? current.date : '',
      forecastAt: next ? next.date : ''
    };
  }

  function installYahooClientIdEditor() {
    const panel = document.getElementById('pcYahooRainPanel');
    if (!panel || document.getElementById('pcYahooClientIdEditor')) return;
    const box = document.createElement('div');
    box.id = 'pcYahooClientIdEditor';
    box.style.cssText = 'display:flex;flex-direction:column;gap:7px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(127,127,127,.2)';
    const label = document.createElement('label');
    label.htmlFor = 'pcYahooClientIdInput';
    label.textContent = 'Yahoo! JAPAN Client ID';
    label.style.cssText = 'font-size:12px;font-weight:600';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:stretch;flex-wrap:wrap';
    const input = document.createElement('input');
    input.id = 'pcYahooClientIdInput';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Client IDを入力';
    input.value = readYahooClientId();
    input.style.cssText = 'min-width:0;flex:1;width:220px;padding:9px 10px;border:1px solid rgba(127,127,127,.4);border-radius:9px;background:var(--clk-bg,#fff);color:var(--clk-fg,#222);font:inherit;font-size:12px';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = '保存して取得';
    save.style.cssText = 'padding:9px 12px;border:1px solid currentColor;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer';
    const note = document.createElement('p');
    note.id = 'pcYahooClientIdNote';
    note.style.cssText = 'margin:0;font-size:11px;line-height:1.55;opacity:.75';
    note.textContent = 'Client IDはこのブラウザー内に保存されます。未設定でも気象庁の天気予報は利用できます。';
    const link = document.createElement('a');
    link.href = 'https://developer.yahoo.co.jp/webapi/map/openlocalplatform/v1/weather.html';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Yahoo! JAPAN 気象情報APIの説明';
    link.style.cssText = 'font-size:11px;color:inherit;opacity:.8;text-decoration:underline;align-self:flex-start';
    save.addEventListener('click', function () {
      const value = input.value.trim();
      try {
        if (value) localStorage.setItem(YAHOO_CLIENT_ID_KEY, value);
        else localStorage.removeItem(YAHOO_CLIENT_ID_KEY);
      } catch (error) {
        note.textContent = 'ブラウザーに保存できませんでした。プライベートモードなどの設定を確認してください。';
        return;
      }
      note.textContent = value ? 'Client IDを保存しました。雨の強さ情報を再取得します。' : 'Client IDを削除しました。気象庁の予報を使用します。';
      const refresh = document.querySelector('.clk-weather__refresh-btn');
      if (refresh) refresh.click();
    });
    row.append(input, save);
    box.append(label, row, note, link);
    panel.appendChild(box);
  }

  const FORECAST_CACHE_PREFIX = 'pc-jma-forecast-v1:';
  const OFFICE_CACHE_PREFIX = 'pc-jma-office-v1:';
  const CACHE_FRESH_MS = 30 * 60 * 1000;
  const MAX_STALE_MS = 24 * 60 * 60 * 1000;
  const OFFICE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const DEFAULT_LOCATION = { lat: 38.2097422, lon: 140.8630611, officeCode: '040000', regionCode: '040010' };
  const memoryForecasts = new Map();
  const officeLookupMemory = new Map();
  const forecastInFlight = new Map();

  const OFFICE_BY_PREFECTURE = Object.freeze({
    '01': '016000', '02': '020000', '03': '030000', '04': '040000',
    '05': '050000', '06': '060000', '07': '070000', '08': '080000',
    '09': '090000', '10': '100000', '11': '110000', '12': '120000',
    '13': '130000', '14': '140000', '15': '150000', '16': '160000',
    '17': '170000', '18': '180000', '19': '190000', '20': '200000',
    '21': '210000', '22': '220000', '23': '230000', '24': '240000',
    '25': '250000', '26': '260000', '27': '270000', '28': '280000',
    '29': '290000', '30': '300000', '31': '310000', '32': '320000',
    '33': '330000', '34': '340000', '35': '350000', '36': '360000',
    '37': '370000', '38': '380000', '39': '390000', '40': '400000',
    '41': '410000', '42': '420000', '43': '430000', '44': '440000',
    '45': '450000', '46': '460100', '47': '471000'
  });

  function numericOrBlank(value) {
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : Number(value);
  }

  async function requestJson(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error('API response was not JSON');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function coordsKey(lat, lon) {
    return Number(lat).toFixed(3) + ',' + Number(lon).toFixed(3);
  }

  function isValidJapanCoordinate(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= 20 && lat <= 46.5 && lon >= 122 && lon <= 154;
  }

  function selectMiyagiRegion(lat, lon, name) {
    const label = String(name || '');
    if (label.indexOf('白石') >= 0 || label.indexOf('蔵王') >= 0 ||
        label.indexOf('七ヶ宿') >= 0 || Number(lon) < 140.70) return '040020';
    return '040010';
  }

  function readOfficeCache(key) {
    try {
      const item = JSON.parse(localStorage.getItem(OFFICE_CACHE_PREFIX + key) || 'null');
      if (!item || typeof item.officeCode !== 'string' ||
          !Number.isFinite(Number(item.savedAt)) ||
          Date.now() - Number(item.savedAt) > OFFICE_CACHE_MAX_AGE_MS) return null;
      return { officeCode: item.officeCode, regionCode: item.regionCode || '' };
    } catch (error) {
      return null;
    }
  }

  function saveOfficeCache(key, result) {
    try {
      localStorage.setItem(OFFICE_CACHE_PREFIX + key, JSON.stringify({
        officeCode: result.officeCode,
        regionCode: result.regionCode || '',
        savedAt: Date.now()
      }));
    } catch (error) {}
  }

  async function resolveOffice(lat, lon, name) {
    const key = coordsKey(lat, lon);
    if (officeLookupMemory.has(key)) return officeLookupMemory.get(key);

    if (Math.abs(lat - DEFAULT_LOCATION.lat) < 0.03 &&
        Math.abs(lon - DEFAULT_LOCATION.lon) < 0.03) {
      const known = { officeCode: DEFAULT_LOCATION.officeCode, regionCode: DEFAULT_LOCATION.regionCode };
      officeLookupMemory.set(key, known);
      return known;
    }

    const stored = readOfficeCache(key);
    if (stored) {
      officeLookupMemory.set(key, stored);
      return stored;
    }

    const reverseUrl = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=' +
      encodeURIComponent(String(lat)) + '&lon=' + encodeURIComponent(String(lon));
    const result = await requestJson(reverseUrl, 6500);
    const municipalityCode = String(result && result.results && result.results.muniCd || '');
    const prefectureCode = municipalityCode.slice(0, 2);
    const officeCode = OFFICE_BY_PREFECTURE[prefectureCode];
    if (!officeCode) {
      throw new Error('場所の都道府県を特定できませんでした。日本国内の場所を選び直してください。');
    }

    const resolved = {
      officeCode: officeCode,
      regionCode: officeCode === '040000' ? selectMiyagiRegion(lat, lon, name) : ''
    };
    officeLookupMemory.set(key, resolved);
    saveOfficeCache(key, resolved);
    return resolved;
  }

  function validRawForecast(data) {
    return Array.isArray(data) && Boolean(data[0] && Array.isArray(data[0].timeSeries) &&
      data[0].timeSeries.length && data[1] && Array.isArray(data[1].timeSeries) &&
      data[1].timeSeries.length);
  }

  function readCachedForecast(officeCode) {
    const key = FORECAST_CACHE_PREFIX + officeCode;
    let stored = memoryForecasts.get(key) || null;
    if (!stored) {
      try { stored = JSON.parse(localStorage.getItem(key) || 'null'); }
      catch (error) { stored = null; }
    }
    if (!stored || stored.version !== 1 || !validRawForecast(stored.data) ||
        !Number.isFinite(Number(stored.fetchedAt)) ||
        Date.now() - Number(stored.fetchedAt) > MAX_STALE_MS) return null;
    memoryForecasts.set(key, stored);
    return stored;
  }

  function saveForecast(officeCode, data) {
    const stored = { version: 1, fetchedAt: Date.now(), data: data, stale: false };
    const key = FORECAST_CACHE_PREFIX + officeCode;
    memoryForecasts.set(key, stored);
    try { localStorage.setItem(key, JSON.stringify(stored)); }
    catch (error) {}
    return stored;
  }

  function findSeries(timeSeries, predicate) {
    if (!Array.isArray(timeSeries)) return null;
    return timeSeries.find(function (series) {
      return Array.isArray(series && series.timeDefines) && Array.isArray(series.areas) &&
        series.areas.some(function (area) { return predicate(area); });
    }) || null;
  }

  function chooseArea(series, preferredCode) {
    if (!series || !Array.isArray(series.areas) || !series.areas.length) return null;
    if (preferredCode) {
      const match = series.areas.find(function (area) {
        return String(area && area.area && area.area.code || '') === String(preferredCode);
      });
      if (match) return match;
    }
    return series.areas[0];
  }

  function attachMeta(forecast, fetchedAt, stale, current) {
    forecast.__source = '気象庁（時間帯・週間予報）';
    forecast.__fetchedAt = Number(fetchedAt) || Date.now();
    forecast.__stale = Boolean(stale);
    forecast.__current = current || { time: '', temp: '', humidity: '', apparentTemp: '', wind: '', code: '' };
    return forecast;
  }

  function normalizeJmaForecast(data, office, fetchedAt, stale, lat, lon, name) {
    if (!validRawForecast(data)) throw new Error('気象庁の予報データ形式が正しくありません。');

    const shortRaw = data[0];
    const weeklyRaw = data[1] || data[0];
    const regionCode = office.regionCode || (office.officeCode === '040000' ? selectMiyagiRegion(lat, lon, name) : '');
    const shortWeatherSeries = findSeries(shortRaw.timeSeries, function (area) { return Array.isArray(area.weatherCodes); });
    const shortPopSeries = findSeries(shortRaw.timeSeries, function (area) { return Array.isArray(area.pops); });
    const shortTempSeries = findSeries(shortRaw.timeSeries, function (area) { return Array.isArray(area.temps); });
    const weeklyWeatherSeries = findSeries(weeklyRaw.timeSeries, function (area) { return Array.isArray(area.weatherCodes); });
    const weeklyTempSeries = findSeries(weeklyRaw.timeSeries, function (area) {
      return Array.isArray(area.tempsMin) && Array.isArray(area.tempsMax);
    });

    if (!shortWeatherSeries || !shortPopSeries || !weeklyWeatherSeries) {
      throw new Error('気象庁の予報項目が見つかりません。');
    }

    const shortWeatherArea = chooseArea(shortWeatherSeries, regionCode);
    const shortPopArea = chooseArea(shortPopSeries, shortWeatherArea && shortWeatherArea.area && shortWeatherArea.area.code);
    const shortTempArea = chooseArea(shortTempSeries, '');
    const weeklyWeatherArea = chooseArea(weeklyWeatherSeries, regionCode);
    const weeklyTempArea = chooseArea(weeklyTempSeries, '');

    if (!shortWeatherArea || !shortPopArea || !weeklyWeatherArea) {
      throw new Error('気象庁の予報エリアが見つかりません。');
    }

    const shortForecast = {
      publishingOffice: shortRaw.publishingOffice || '気象庁',
      timeSeries: [
        {
          timeDefines: shortWeatherSeries.timeDefines,
          areas: [{ area: shortWeatherArea.area || {}, weatherCodes: shortWeatherArea.weatherCodes || [] }]
        },
        {
          timeDefines: shortPopSeries.timeDefines,
          areas: [{ area: shortPopArea.area || {}, pops: shortPopArea.pops || [] }]
        }
      ]
    };
    if (shortTempSeries && shortTempArea) {
      shortForecast.timeSeries.push({
        timeDefines: shortTempSeries.timeDefines,
        areas: [{ area: shortTempArea.area || {}, temps: shortTempArea.temps || [] }]
      });
    }

    const weeklyForecast = {
      publishingOffice: weeklyRaw.publishingOffice || shortRaw.publishingOffice || '気象庁',
      timeSeries: [
        {
          timeDefines: weeklyWeatherSeries.timeDefines,
          areas: [{
            area: weeklyWeatherArea.area || {},
            weatherCodes: weeklyWeatherArea.weatherCodes || [],
            pops: weeklyWeatherArea.pops || []
          }]
        }
      ]
    };
    if (weeklyTempSeries && weeklyTempArea) {
      weeklyForecast.timeSeries.push({
        timeDefines: weeklyTempSeries.timeDefines,
        areas: [{
          area: weeklyTempArea.area || {},
          tempsMin: weeklyTempArea.tempsMin || [],
          tempsMax: weeklyTempArea.tempsMax || []
        }]
      });
    }

    const now = Date.now();
    const weatherTimes = shortWeatherSeries.timeDefines || [];
    const codes = shortWeatherArea.weatherCodes || [];
    let weatherIndex = -1;
    for (let i = 0; i < weatherTimes.length; i += 1) {
      const time = Date.parse(weatherTimes[i]);
      if (Number.isFinite(time) && time <= now) weatherIndex = i;
    }
    if (weatherIndex < 0 && codes.length) weatherIndex = 0;
    const currentCode = weatherIndex >= 0 ? codes[weatherIndex] : '';

    let currentTemp = '';
    let currentTempTime = '';
    if (shortTempSeries && shortTempArea) {
      const tempTimes = shortTempSeries.timeDefines || [];
      const temps = shortTempArea.temps || [];
      let nearest = null;
      for (let i = 0; i < tempTimes.length; i += 1) {
        const timestamp = Date.parse(tempTimes[i]);
        const temp = numericOrBlank(temps[i]);
        if (!Number.isFinite(timestamp) || temp === '') continue;
        const distance = Math.abs(timestamp - now);
        if (!nearest || distance < nearest.distance) nearest = { distance: distance, value: temp, time: tempTimes[i] };
      }
      if (nearest && nearest.distance <= 3 * 60 * 60 * 1000) {
        currentTemp = nearest.value;
        currentTempTime = nearest.time;
      }
    }

    return attachMeta([shortForecast, weeklyForecast], fetchedAt, stale, {
      time: currentTempTime || (weatherIndex >= 0 ? weatherTimes[weatherIndex] : ''),
      temp: currentTemp,
      humidity: '',
      apparentTemp: '',
      wind: '',
      windDirection: '',
      precipitation: '',
      code: currentCode,
      isDay: null
    });
  }


  // Current observations from JMA AMeDAS; forecasts remain from JMA's prefectural JSON.
  const AMEDAS_TABLE_URL = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';
  const AMEDAS_LATEST_TIME_URL = 'https://www.jma.go.jp/bosai/amedas/data/latest_time.txt';
  const AMEDAS_MAP_BASE = 'https://www.jma.go.jp/bosai/amedas/data/map/';
  const AMEDAS_CACHE_PREFIX = 'pc-jma-amedas-current-v1:';
  let amedasTablePromise = null;

  async function requestText(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, timeoutMs || 7000);
    try {
      const response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.text();
    } finally { clearTimeout(timeout); }
  }

  function amedasCoordinate(value) {
    if (!Array.isArray(value) || value.length < 2) return NaN;
    const degrees = Number(value[0]), minutes = Number(value[1]);
    return Number.isFinite(degrees) && Number.isFinite(minutes) ? degrees + minutes / 60 : NaN;
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function amedasValue(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw))) return '';
    return Number(raw);
  }

  async function getAmedasObservation(lat, lon) {
    const cacheKey = AMEDAS_CACHE_PREFIX + coordsKey(lat, lon);
    let stale = null;
    try {
      stale = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (stale && stale.observation && Date.now() - Number(stale.savedAt) < 5 * 60 * 1000) return stale.observation;
    } catch (error) { stale = null; }

    try {
      if (!amedasTablePromise) {
        amedasTablePromise = requestJson(AMEDAS_TABLE_URL, 8000).catch(function (error) {
          amedasTablePromise = null;
          throw error;
        });
      }
      const [table, latestText] = await Promise.all([
        amedasTablePromise,
        requestText(AMEDAS_LATEST_TIME_URL, 7000)
      ]);
      const latestRaw = String(latestText || '').trim();
      const stampMatch = latestRaw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!stampMatch) throw new Error('アメダスの最新時刻を読み取れませんでした。');
      const stamp = stampMatch.slice(1).join('');
      const map = await requestJson(AMEDAS_MAP_BASE + stamp + '00.json', 8000);

      const stations = Object.entries(table || {}).map(([code, station]) => ({
        code, station,
        lat: amedasCoordinate(station && station.lat),
        lon: amedasCoordinate(station && station.lon)
      })).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon) && map && map[item.code]);
      stations.sort((a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon));

      let found = null;
      for (const item of stations) {
        const data = map[item.code] || {};
        const observation = {
          stationCode: item.code,
          stationName: String(item.station && item.station.kjName || item.station && item.station.knName || 'アメダス観測所'),
          distanceKm: distanceKm(lat, lon, item.lat, item.lon),
          time: latestRaw,
          temp: amedasValue(data.temp),
          humidity: amedasValue(data.humidity),
          wind: amedasValue(data.wind),
          precipitation1h: amedasValue(data.precipitation1h)
        };
        if (observation.temp !== '' || observation.humidity !== '' || observation.wind !== '') {
          found = observation;
          break;
        }
      }
      if (!found) throw new Error('地点に近いアメダスの最新観測データが見つかりませんでした。');
      try { localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), observation: found })); } catch (error) {}
      return found;
    } catch (error) {
      if (stale && stale.observation && Date.now() - Number(stale.savedAt) < 60 * 60 * 1000) {
        console.warn('最新のアメダス観測を取得できないため、保存済み観測を表示します。', error);
        return stale.observation;
      }
      throw error;
    }
  }

  async function addAmedasObservation(forecast, lat, lon) {
    try {
      const observation = await getAmedasObservation(lat, lon);
      const current = Object.assign({}, forecast.__current || {});
      if (observation.temp !== '') current.temp = observation.temp;
      if (observation.humidity !== '') current.humidity = observation.humidity;
      if (observation.wind !== '') current.wind = observation.wind;
      current.time = observation.time || current.time || '';
      forecast.__current = current;
      forecast.__observation = observation;
      forecast.__currentObserved = true;
    } catch (error) {
      forecast.__observation = null;
      forecast.__currentObserved = false;
      console.warn('アメダスの現在観測を取得できませんでした。気象庁の予報を続けて表示します。', error);
    }
    return forecast;
  }

  function isValidForecast(forecast) {
    if (!Array.isArray(forecast) || !forecast[0] || !forecast[1]) return false;
    const hourly = forecast[0].timeSeries;
    const daily = forecast[1].timeSeries;
    return Array.isArray(hourly) &&
      hourly.some(function (ts) { return Array.isArray(ts.timeDefines) && ts.areas && ts.areas.some(function (area) { return Array.isArray(area.weatherCodes); }); }) &&
      hourly.some(function (ts) { return Array.isArray(ts.timeDefines) && ts.areas && ts.areas.some(function (area) { return Array.isArray(area.pops); }); }) &&
      Array.isArray(daily) &&
      daily.some(function (ts) { return Array.isArray(ts.timeDefines) && ts.areas && ts.areas.some(function (area) { return Array.isArray(area.weatherCodes); }); });
  }

  async function getJmaForecastBase(lat, lon, name) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!isValidJapanCoordinate(latitude, longitude)) {
      throw new Error('日本国内の緯度・経度を指定してください。');
    }

    const office = await resolveOffice(latitude, longitude, name);
    const cached = readCachedForecast(office.officeCode);
    if (cached && Date.now() - Number(cached.fetchedAt) < CACHE_FRESH_MS) {
      return await addAmedasObservation(normalizeJmaForecast(cached.data, office, cached.fetchedAt, false, latitude, longitude, name), latitude, longitude);
    }

    if (forecastInFlight.has(office.officeCode)) {
      const shared = await forecastInFlight.get(office.officeCode);
      return await addAmedasObservation(normalizeJmaForecast(shared.data, office, shared.fetchedAt, Boolean(shared.stale), latitude, longitude, name), latitude, longitude);
    }

    const task = (async function () {
      try {
        const url = 'https://www.jma.go.jp/bosai/forecast/data/forecast/' + office.officeCode + '.json';
        const data = await requestJson(url, 9000);
        if (!validRawForecast(data)) throw new Error('気象庁の予報データ形式が正しくありません。');
        return saveForecast(office.officeCode, data);
      } catch (error) {
        const backup = readCachedForecast(office.officeCode);
        if (backup) {
          console.warn('気象庁への接続に失敗したため、保存済みの気象庁予報を表示します。', error);
          return { version: 1, fetchedAt: backup.fetchedAt, data: backup.data, stale: true };
        }
        throw new Error('気象庁から予報を取得できませんでした。詳細: ' + String(error && error.message || error) + '。通信状態・ブラウザーの通信制限を確認して、時間をおいて再取得してください。');
      } finally {
        forecastInFlight.delete(office.officeCode);
      }
    })();

    forecastInFlight.set(office.officeCode, task);
    const result = await task;
    return await addAmedasObservation(normalizeJmaForecast(result.data, office, result.fetchedAt, Boolean(result.stale), latitude, longitude, name), latitude, longitude);
  }


  // JMA remains the forecast fallback. Yahoo! is used for its rain-intensity nowcast
  // when a Client ID has been configured; a Yahoo failure must never hide the JMA forecast.
  async function getJmaForecast(lat, lon, name) {
    const basePromise = getJmaForecastBase(lat, lon, name);
    const yahooPromise = getYahooRainfall(lat, lon).then(
      function (rainfall) { return { rainfall: rainfall, error: null }; },
      function (error) { return { rainfall: null, error: error }; }
    );
    const forecast = await basePromise;
    const yahoo = await yahooPromise;
    forecast.__yahooRainfall = yahoo.rainfall;
    forecast.__yahooStatus = yahoo.rainfall ? '' : String(yahoo.error && yahoo.error.message || 'Yahoo!の雨情報を取得できませんでした。');
    if (yahoo.error && readYahooClientId()) console.warn('Yahoo! rainfall unavailable; showing JMA forecast:', yahoo.error);
    return forecast;
  }

  installYahooClientIdEditor();

  // Weather sources: JMA hourly/daily forecasts and optional Yahoo! rainfall nowcast.
  window.__weatherFallback = {
    getJmaForecast: getJmaForecast,
    getForecast: getJmaForecast,
    isValidForecast: isValidForecast
  };

  // Keep the stopwatch history list independently scrollable.
  const style = document.createElement('style');
  style.id = 'pc-weather-fallback-history-scroll';
  style.textContent =
    '.clk-stage--sw-main>.clk-sw-history-panel{display:flex!important;flex-direction:column!important;box-sizing:border-box;max-height:min(52vh,460px)!important;min-height:0;overflow:hidden!important}' +
    '.clk-stage--sw-main>.clk-sw-history-panel .clk-lap-list--scroll{flex:0 1 auto;min-height:0;max-height:min(38vh,320px)!important;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;scrollbar-width:thin}' +
    '@media(max-width:720px){.clk-stage--sw-main>.clk-sw-history-panel{max-height:56vh!important}.clk-stage--sw-main>.clk-sw-history-panel .clk-lap-list--scroll{max-height:42vh!important}}';
  (document.head || document.documentElement).appendChild(style);
})();