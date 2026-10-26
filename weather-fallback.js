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


  const WEATHER_PROVIDER_KEY = 'pc-weather-provider-v1';

  function selectedWeatherProvider() {
    try {
      return localStorage.getItem(WEATHER_PROVIDER_KEY) === 'jma' ? 'jma' : 'open-meteo';
    } catch (error) {
      return 'open-meteo';
    }
  }

  function installWeatherSourcePicker() {
    let panel = document.getElementById('pcWeatherSourcePanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'pcWeatherSourcePanel';
      panel.style.cssText = 'margin:10px 0 14px;padding:12px 14px;border:1px solid rgba(80,90,75,.18);border-radius:14px;background:rgba(128,128,128,.05)';
      const note = document.querySelector('.clk-weather__source-note');
      if (note && note.parentElement) note.parentElement.insertBefore(panel, note);
      else {
        const weather = document.querySelector('.clk-weather');
        if (weather) weather.appendChild(panel);
      }
    }
    if (panel.dataset.providerPickerReady === '1') return;
    panel.id = 'pcWeatherSourcePanel';
    panel.setAttribute('aria-label', '天気情報の取得元');
    panel.dataset.providerPickerReady = '1';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
        '<strong style="font-size:12.5px">天気予報の取得元</strong>' +
        '<span id="pcWeatherProviderStatus" aria-live="polite" style="font-size:11px;opacity:.78">Open-Meteoを優先</span>' +
      '</div>' +
      '<p style="font-size:11.5px;line-height:1.55;opacity:.78;margin:8px 0 10px">Open-Meteoと気象庁を切り替えられます。選んだAPIで取得できない場合は、もう一方のAPIへ自動で切り替えます。</p>' +
      '<div id="pcWeatherProviderOptions" style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="button" data-weather-provider="open-meteo" aria-pressed="true" style="padding:8px 12px;border:1px solid currentColor;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer">Open-Meteo</button>' +
        '<button type="button" data-weather-provider="jma" aria-pressed="false" style="padding:8px 12px;border:1px solid currentColor;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer">気象庁</button>' +
      '</div>';
    const buttons = Array.from(panel.querySelectorAll('[data-weather-provider]'));
    const status = panel.querySelector('#pcWeatherProviderStatus');
    const updateButtons = function () {
      const provider = selectedWeatherProvider();
      buttons.forEach(function (button) {
        const active = button.dataset.weatherProvider === provider;
        button.setAttribute('aria-pressed', String(active));
        button.style.background = active ? 'var(--clk-accent, #4A6FA5)' : 'transparent';
        button.style.color = active ? '#fff' : 'var(--clk-fg, #222)';
        button.style.borderColor = active ? 'var(--clk-accent, #4A6FA5)' : 'currentColor';
      });
      if (status) status.textContent = provider === 'jma' ? '気象庁を優先' : 'Open-Meteoを優先';
    };
    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        try { localStorage.setItem(WEATHER_PROVIDER_KEY, button.dataset.weatherProvider); } catch (error) {}
        updateButtons();
        const refresh = document.querySelector('.clk-weather__refresh-btn');
        if (refresh) refresh.click();
      });
    });
    updateButtons();
    const note = document.querySelector('.clk-weather__source-note');
    if (note) {
      note.textContent = '天気予報はOpen-Meteoまたは気象庁から取得します。選択した取得元で接続できない場合は、もう一方に自動で切り替えます。富沢小学校の初期座標を使用しますが、予報は学校敷地そのものの観測値ではありません。';
    }
  }

  function openMeteoWeatherCode(value) {
    const code = Number(value);
    if ([0, 1].includes(code)) return '100';
    if (code === 2) return '200';
    if ([3, 45, 48].includes(code)) return '201';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '400';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return '300';
    return '201';
  }

  function openMeteoTime(value, isDate) {
    const time = String(value || '');
    if (isDate) return time.slice(0, 10);
    if (/[zZ]|[+-][0-9]{2}:?[0-9]{2}$/.test(time)) return time;
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/.test(time)) return time + ':00+09:00';
    return time;
  }

  async function getOpenMeteoForecast(lat, lon, name) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!isValidJapanCoordinate(latitude, longitude)) {
      throw new Error('日本国内の緯度・経度を指定してください。');
    }
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('timezone', 'Asia/Tokyo');
    url.searchParams.set('forecast_days', '7');
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code');
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code');
    url.searchParams.set('daily', 'weather_code,precipitation_probability_max,temperature_2m_min,temperature_2m_max');
    url.searchParams.set('wind_speed_unit', 'ms');
    const data = await requestJson(url.toString(), 9000);
    const hourly = data && data.hourly;
    const daily = data && data.daily;
    const current = data && data.current;
    if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.weather_code) ||
        !Array.isArray(hourly.precipitation_probability) || !Array.isArray(hourly.temperature_2m) ||
        !daily || !Array.isArray(daily.time) || !Array.isArray(daily.weather_code) ||
        !Array.isArray(daily.temperature_2m_min) || !Array.isArray(daily.temperature_2m_max)) {
      throw new Error('Open-Meteoから必要な天気データが返されませんでした。');
    }
    const hourlyTimes = hourly.time.map(function (time) { return openMeteoTime(time, false); });
    const dailyTimes = daily.time.map(function (time) { return openMeteoTime(time, true); });
    const hourlyForecast = {
      publishingOffice: 'Open-Meteo',
      timeSeries: [
        { timeDefines: hourlyTimes, areas: [{ area: { name: String(name || '選択した場所'), code: '' }, weatherCodes: hourly.weather_code.map(openMeteoWeatherCode) }] },
        { timeDefines: hourlyTimes, areas: [{ area: { name: String(name || '選択した場所'), code: '' }, pops: hourly.precipitation_probability }] },
        { timeDefines: hourlyTimes, areas: [{ area: { name: String(name || '選択した場所'), code: '' }, temps: hourly.temperature_2m }] }
      ]
    };
    const dailyForecast = {
      publishingOffice: 'Open-Meteo',
      timeSeries: [
        { timeDefines: dailyTimes, areas: [{ area: { name: String(name || '選択した場所'), code: '' }, weatherCodes: daily.weather_code.map(openMeteoWeatherCode), pops: daily.precipitation_probability_max || [] }] },
        { timeDefines: dailyTimes, areas: [{ area: { name: String(name || '選択した場所'), code: '' }, tempsMin: daily.temperature_2m_min, tempsMax: daily.temperature_2m_max }] }
      ]
    };
    const currentTime = current && current.time ? openMeteoTime(current.time, false) : '';
    const currentCode = current && current.weather_code != null ? openMeteoWeatherCode(current.weather_code) : null;
    const forecast = [hourlyForecast, dailyForecast];
    forecast.__source = 'Open-Meteo';
    forecast.__fetchedAt = Date.now();
    forecast.__stale = false;
    forecast.__current = {
      time: currentTime,
      temp: numericOrBlank(current && current.temperature_2m),
      humidity: numericOrBlank(current && current.relative_humidity_2m),
      apparentTemp: numericOrBlank(current && current.apparent_temperature),
      wind: numericOrBlank(current && current.wind_speed_10m),
      code: currentCode || (hourlyForecast.timeSeries[0].areas[0].weatherCodes[0] || '')
    };
    forecast.__currentObserved = true;
    forecast.__locationName = String(name || '');
    return forecast;
  }

  async function getWeatherForecast(lat, lon, name, requestedProvider) {
    const requested = requestedProvider === 'jma' || requestedProvider === 'open-meteo'
      ? requestedProvider
      : selectedWeatherProvider();
    const first = requested === 'jma' ? getJmaForecastBase : getOpenMeteoForecast;
    const second = requested === 'jma' ? getOpenMeteoForecast : getJmaForecastBase;
    const firstName = requested === 'jma' ? '気象庁' : 'Open-Meteo';
    const secondName = requested === 'jma' ? 'Open-Meteo' : '気象庁';
    try {
      const forecast = await first(lat, lon, name);
      if (forecast && !forecast.__source) forecast.__source = firstName;
      forecast.__requestedSource = firstName;
      return forecast;
    } catch (primaryError) {
      console.warn(firstName + 'の天気取得に失敗したため' + secondName + 'へ切り替えます。', primaryError);
      try {
        const forecast = await second(lat, lon, name);
        forecast.__source = secondName + '（' + firstName + '取得失敗時の代替）';
        forecast.__fallbackFrom = firstName;
        forecast.__requestedSource = firstName;
        forecast.__primaryError = String(primaryError && primaryError.message || primaryError);
        return forecast;
      } catch (fallbackError) {
        throw new Error(firstName + 'と' + secondName + 'の両方から天気を取得できませんでした。' +
          ' ' + firstName + ': ' + String(primaryError && primaryError.message || primaryError) +
          ' / ' + secondName + ': ' + String(fallbackError && fallbackError.message || fallbackError));
      }
    }
  }

  installWeatherSourcePicker();

  window.__weatherFallback = {
    getJmaForecast: getWeatherForecast,
    getOpenMeteoForecast: getOpenMeteoForecast,
    getForecast: getWeatherForecast,
    isValidForecast: isValidForecast,
    getSelectedProvider: selectedWeatherProvider
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