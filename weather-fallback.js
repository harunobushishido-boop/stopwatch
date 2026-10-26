(function () {
  'use strict';

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

  async function getJmaForecast(lat, lon, name) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!isValidJapanCoordinate(latitude, longitude)) {
      throw new Error('日本国内の緯度・経度を指定してください。');
    }

    const office = await resolveOffice(latitude, longitude, name);
    const cached = readCachedForecast(office.officeCode);
    if (cached && Date.now() - Number(cached.fetchedAt) < CACHE_FRESH_MS) {
      return normalizeJmaForecast(cached.data, office, cached.fetchedAt, false, latitude, longitude, name);
    }

    if (forecastInFlight.has(office.officeCode)) {
      const shared = await forecastInFlight.get(office.officeCode);
      return normalizeJmaForecast(shared.data, office, shared.fetchedAt, Boolean(shared.stale), latitude, longitude, name);
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
        throw new Error('気象庁から予報を取得できませんでした。通信状態を確認して、時間をおいて再取得してください。');
      } finally {
        forecastInFlight.delete(office.officeCode);
      }
    })();

    forecastInFlight.set(office.officeCode, task);
    const result = await task;
    return normalizeJmaForecast(result.data, office, result.fetchedAt, Boolean(result.stale), latitude, longitude, name);
  }

  window.__weatherFallback = {
    getJmaForecast: getJmaForecast,
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