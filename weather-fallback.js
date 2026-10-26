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
        throw new Error('気象庁から予報を取得できませんでした。詳細: ' + String(error && error.message || error) + '。通信状態・ブラウザーの通信制限を確認して、時間をおいて再取得してください。');
      } finally {
        forecastInFlight.delete(office.officeCode);
      }
    })();

    forecastInFlight.set(office.officeCode, task);
    const result = await task;
    return normalizeJmaForecast(result.data, office, result.fetchedAt, Boolean(result.stale), latitude, longitude, name);
  }


  const WEATHERAPI_KEY_STORAGE = 'pc-weatherapi-key-v1';
  const YAHOO_YOLP_KEY_STORAGE = 'pc-yahoo-yolp-appid-v1';

  function readStoredWeatherKey(storageKey) {
    try { return String(localStorage.getItem(storageKey) || '').trim(); }
    catch (error) { return ''; }
  }

  function weatherApiConditionCode(condition) {
    const description = String(condition && condition.text || '').toLowerCase();
    const code = Number(condition && condition.code);
    if (description.includes('thunder') || [1087, 1273, 1276, 1279, 1282].includes(code)) {
      return (description.includes('snow') || code === 1279 || code === 1282) ? '407' : '308';
    }
    if (description.includes('blizzard') || description.includes('snow') ||
        description.includes('sleet') || description.includes('ice pellet') ||
        [1066, 1069, 1072, 1114, 1117, 1168, 1171, 1198, 1201, 1204, 1207,
          1210, 1213, 1216, 1219, 1222, 1225, 1237, 1249, 1252, 1255, 1258, 1261, 1264].includes(code)) {
      return description.includes('rain') || description.includes('freezing') ? '303' : '400';
    }
    if (description.includes('rain') || description.includes('drizzle') ||
        description.includes('shower') || description.includes('freezing rain') ||
        [1063, 1150, 1153, 1180, 1183, 1186, 1189, 1192, 1195, 1240, 1243, 1246].includes(code)) return '300';
    if (description.includes('fog') || description.includes('mist') || description.includes('haze') ||
        [1030, 1135, 1147].includes(code)) return '209';
    if (description.includes('partly cloudy') || code === 1003) return '201';
    if (description.includes('cloud') || description.includes('overcast') || code === 1006 || code === 1009) return '200';
    if (description.includes('clear') || description.includes('sunny') || code === 1000) return '100';
    return '';
  }

  function weatherApiDateTime(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return text;
    return text.replace(' ', 'T') + ':00+09:00';
  }

  function weatherApiDayTime(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T00:00:00+09:00' : weatherApiDateTime(text);
  }

  function finiteNumber(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
      ? Number(value) : '';
  }

  async function getWeatherApiForecast(lat, lon, name, key) {
    const params = new URLSearchParams({
      key: key,
      q: Number(lat) + ',' + Number(lon),
      days: '3',
      aqi: 'no',
      alerts: 'no',
      lang: 'ja'
    });
    const data = await requestJson('https://api.weatherapi.com/v1/forecast.json?' + params.toString(), 10000);
    if (data.error) {
      throw new Error('WeatherAPI.com: ' + String(data.error.message || data.error.code || 'APIエラー'));
    }
    const current = data.current;
    const forecastDays = data.forecast && Array.isArray(data.forecast.forecastday)
      ? data.forecast.forecastday : [];
    if (!current || !current.condition || !forecastDays.length) {
      throw new Error('WeatherAPI.comから予報データが返りませんでした。APIキー・利用上限・場所を確認してください。');
    }

    const hourly = [];
    forecastDays.forEach(function (day) {
      (Array.isArray(day.hour) ? day.hour : []).forEach(function (hour) {
        const iso = weatherApiDateTime(hour.time);
        if (iso) hourly.push({ iso: iso, data: hour });
      });
    });
    if (!hourly.length) throw new Error('WeatherAPI.comの時間別予報が空でした。');

    const areaName = name || '仙台市立富沢小学校';
    const area = { name: areaName, code: 'weatherapi' };
    const hourlyWeather = {
      timeDefines: hourly.map(function (item) { return item.iso; }),
      areas: [{ area: area, weatherCodes: hourly.map(function (item) {
        return weatherApiConditionCode(item.data.condition);
      }) }]
    };
    const hourlyRain = {
      timeDefines: hourly.map(function (item) { return item.iso; }),
      areas: [{ area: area, pops: hourly.map(function (item) {
        return finiteNumber(item.data.chance_of_rain) === '' ? '' : String(Math.round(Number(item.data.chance_of_rain)));
      }) }]
    };
    const hourlyTemp = {
      timeDefines: hourly.map(function (item) { return item.iso; }),
      areas: [{ area: area, temps: hourly.map(function (item) { return finiteNumber(item.data.temp_c); }) }]
    };

    const dayTimes = forecastDays.map(function (day) { return weatherApiDayTime(day.date); });
    const dailyWeather = {
      timeDefines: dayTimes,
      areas: [{ area: area,
        weatherCodes: forecastDays.map(function (day) { return weatherApiConditionCode(day.day && day.day.condition); }),
        pops: forecastDays.map(function (day) {
          const value = day.day && day.day.daily_chance_of_rain;
          return finiteNumber(value) === '' ? '' : String(Math.round(Number(value)));
        })
      }]
    };
    const dailyTemps = {
      timeDefines: dayTimes,
      areas: [{ area: area,
        tempsMin: forecastDays.map(function (day) { return finiteNumber(day.day && day.day.mintemp_c); }),
        tempsMax: forecastDays.map(function (day) { return finiteNumber(day.day && day.day.maxtemp_c); })
      }]
    };

    const currentCode = weatherApiConditionCode(current.condition);
    const result = attachMeta([
      { publishingOffice: 'WeatherAPI.com', timeSeries: [hourlyWeather, hourlyRain, hourlyTemp] },
      { publishingOffice: 'WeatherAPI.com', timeSeries: [dailyWeather, dailyTemps] }
    ], Date.now(), false, {
      time: weatherApiDateTime(current.last_updated),
      temp: finiteNumber(current.temp_c),
      humidity: finiteNumber(current.humidity),
      apparentTemp: finiteNumber(current.feelslike_c),
      wind: finiteNumber(current.wind_kph),
      windDirection: String(current.wind_dir || ''),
      precipitation: finiteNumber(current.precip_mm),
      code: currentCode,
      isDay: Number(current.is_day) === 1
    });
    result.__source = 'WeatherAPI.com';
    result.__weatherApi = true;
    return result;
  }

  function getYahooRainfallJsonp(lat, lon, appId) {
    return new Promise(function (resolve, reject) {
      const callbackName = '__pcYahooRain_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
      const script = document.createElement('script');
      let settled = false;
      const timer = setTimeout(function () {
        finish(new Error('Yahoo!雨情報APIがタイムアウトしました。Client IDと利用条件を確認してください。'));
      }, 9000);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onerror = null;
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[callbackName]; } catch (ignored) { window[callbackName] = undefined; }
        if (error) reject(error); else resolve(value);
      }
      window[callbackName] = function (payload) {
        const resultInfo = payload && payload.YDF && payload.YDF.ResultInfo;
        if (!payload || !payload.YDF || (resultInfo && Number(resultInfo.Status) !== 200)) {
          finish(new Error('Yahoo!雨情報APIから正常な応答がありませんでした。'));
          return;
        }
        finish(null, payload);
      };
      const params = new URLSearchParams({
        appid: appId,
        coordinates: Number(lon) + ',' + Number(lat),
        output: 'json',
        callback: callbackName,
        interval: '10',
        past: '1'
      });
      script.async = true;
      script.src = 'https://map.yahooapis.jp/weather/V1/place?' + params.toString();
      script.onerror = function () {
        finish(new Error('Yahoo!雨情報APIに接続できませんでした。'));
      };
      document.head.appendChild(script);
    });
  }

  async function getYahooRainfall(lat, lon, appId) {
    const payload = await getYahooRainfallJsonp(lat, lon, appId);
    const rawFeature = payload && payload.YDF && payload.YDF.Feature;
    const features = Array.isArray(rawFeature) ? rawFeature : (rawFeature ? [rawFeature] : []);
    const rawWeather = features[0] && features[0].Property &&
      features[0].Property.WeatherList && features[0].Property.WeatherList.Weather;
    const weather = Array.isArray(rawWeather) ? rawWeather : (rawWeather ? [rawWeather] : []);
    const sorted = weather.map(function (item) {
      const stamp = String(item && item.Date || '');
      const rainfall = finiteNumber(item && item.Rainfall);
      return { type: String(item && item.Type || ''), stamp: stamp, rainfall: rainfall };
    }).filter(function (item) { return item.rainfall !== '' && /^\d{12}$/.test(item.stamp); })
      .sort(function (a, b) { return a.stamp.localeCompare(b.stamp); });
    if (!sorted.length) throw new Error('Yahoo!雨情報APIに雨の強さデータが含まれていません。');
    const observed = sorted.filter(function (item) { return item.type === 'observation'; });
    const predicted = sorted.filter(function (item) { return item.type === 'forecast'; });
    const current = observed.length ? observed[observed.length - 1] : sorted[0];
    const nextHour = predicted.length ? predicted[predicted.length - 1] : sorted[sorted.length - 1];
    return { current: current.rainfall, nextHour: nextHour.rainfall, updatedAt: current.stamp };
  }

  async function getPreferredForecast(lat, lon, name) {
    const key = readStoredWeatherKey(WEATHERAPI_KEY_STORAGE);
    let forecast;
    if (!key) {
      forecast = await getJmaForecast(lat, lon, name);
      forecast.__source = '気象庁（WeatherAPI.com未設定のため予備データを使用）';
    } else {
      try {
        forecast = await getWeatherApiForecast(Number(lat), Number(lon), name, key);
      } catch (providerError) {
        forecast = await getJmaForecast(lat, lon, name);
        forecast.__source = '気象庁（WeatherAPI.com接続失敗時の予備）';
        forecast.__providerError = String(providerError && providerError.message || providerError);
      }
    }

    const yahooKey = readStoredWeatherKey(YAHOO_YOLP_KEY_STORAGE);
    if (yahooKey) {
      try {
        forecast.__yahooRainfall = await getYahooRainfall(lat, lon, yahooKey);
      } catch (yahooError) {
        forecast.__yahooError = String(yahooError && yahooError.message || yahooError);
      }
    }
    return forecast;
  }

  function installWeatherProviderSettings() {
    const host = document.querySelector('.clk-weather__privacy');
    if (!host || document.getElementById('pcWeatherProviderSettings')) return;
    const panel = document.createElement('section');
    panel.id = 'pcWeatherProviderSettings';
    panel.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #00000018;color:inherit';
    panel.innerHTML =
      '<strong style="display:block;font-size:12px;margin-bottom:6px">高精度天気API設定（任意）</strong>' +
      '<p style="font-size:11.5px;line-height:1.55;margin:0 0 10px">WeatherAPI.comの天気予報を優先し、キー未設定・接続失敗時は気象庁の予報へ戻ります。無料プランは1日ごとの予報が3日分です。キーはこのブラウザー内だけに保存され、GitHubには書き込みません。公開サイトでは、キーの使用量制限を設定してください。</p>' +
      '<label for="pcWeatherApiKeyInput" style="display:block;font-size:11.5px;margin-bottom:5px">WeatherAPI.com APIキー</label>' +
      '<input id="pcWeatherApiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="WeatherAPI.comで取得したキー" style="box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #0000002b;border-radius:8px;background:#fff;color:#111;font-size:12px">' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">' +
      '<button type="button" id="pcWeatherApiSave" style="border:1px solid #00000030;border-radius:8px;padding:7px 10px;background:#222;color:#fff;font-size:12px;cursor:pointer">予報APIキーを保存して再取得</button>' +
      '<button type="button" id="pcWeatherApiDisable" style="border:1px solid #00000030;border-radius:8px;padding:7px 10px;background:transparent;color:inherit;font-size:12px;cursor:pointer">予報APIを無効化</button>' +
      '</div>' +
      '<p id="pcWeatherApiStatus" aria-live="polite" style="font-size:11px;line-height:1.5;margin:7px 0 12px"></p>' +
      '<p style="font-size:11px;line-height:1.6;margin:0 0 15px"><a href="https://www.weatherapi.com/signup.aspx" target="_blank" rel="noopener noreferrer">WeatherAPI.comの無料登録・キー取得</a> · <a href="https://www.weatherapi.com/docs/forecast-api/" target="_blank" rel="noopener noreferrer">予報APIの仕様</a></p>' +
      '<div style="padding-top:12px;border-top:1px solid #00000018">' +
      '<strong style="display:block;font-size:12px;margin-bottom:6px">Yahoo! JAPAN 雨情報API（任意）</strong>' +
      '<p style="font-size:11.5px;line-height:1.55;margin:0 0 8px">Yahoo!の公式APIは雨の強さの実測値と60分先までの予測に対応します。気温や週間予報は含まれないため、上の予報APIの代わりではなく補助データとして使います。</p>' +
      '<label for="pcYahooYolpKeyInput" style="display:block;font-size:11.5px;margin-bottom:5px">Yahoo! YOLP Client ID</label>' +
      '<input id="pcYahooYolpKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="Yahoo!デベロッパーネットワークのClient ID" style="box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #0000002b;border-radius:8px;background:#fff;color:#111;font-size:12px">' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">' +
      '<button type="button" id="pcYahooYolpSave" style="border:1px solid #00000030;border-radius:8px;padding:7px 10px;background:#222;color:#fff;font-size:12px;cursor:pointer">Yahoo! Client IDを保存</button>' +
      '<button type="button" id="pcYahooYolpDisable" style="border:1px solid #00000030;border-radius:8px;padding:7px 10px;background:transparent;color:inherit;font-size:12px;cursor:pointer">Yahoo!雨情報を無効化</button>' +
      '</div>' +
      '<p id="pcYahooYolpStatus" aria-live="polite" style="font-size:11px;line-height:1.5;margin:7px 0 0"></p>' +
      '<p style="font-size:11px;line-height:1.6;margin:7px 0 0"><a href="https://developer.yahoo.co.jp/webapi/map/openlocalplatform/v1/weather.html" target="_blank" rel="noopener noreferrer">Yahoo!公式 気象情報APIの説明</a></p>' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;margin-top:14px">' +
      '<a href="https://www.google.com/search?q=%E4%BB%99%E5%8F%B0%E5%B8%82%E5%A4%AA%E7%99%BD%E5%8C%BA+%E5%AF%8C%E6%B2%A2+%E5%A4%A9%E6%B0%97" target="_blank" rel="noopener noreferrer">Googleで天気を見る</a>' +
      '<a href="https://weathernews.jp/" target="_blank" rel="noopener noreferrer">ウェザーニュース</a>' +
      '<a href="https://weather.yahoo.co.jp/weather/" target="_blank" rel="noopener noreferrer">Yahoo!天気</a>' +
      '</div>';
    host.appendChild(panel);

    function wireKey(storageKey, inputId, statusId, saveId, disableId, label) {
      const input = panel.querySelector('#' + inputId);
      const status = panel.querySelector('#' + statusId);
      const save = panel.querySelector('#' + saveId);
      const disable = panel.querySelector('#' + disableId);
      function update(message) { status.textContent = message; status.style.color = '#555'; }
      const existing = readStoredWeatherKey(storageKey);
      update(existing ? label + 'は保存済みです（キー自体は表示していません）。' : label + 'は未設定です。');
      save.addEventListener('click', function () {
        const value = String(input.value || '').trim();
        if (!value) { update(label + 'を入力してください。'); return; }
        try {
          localStorage.setItem(storageKey, value);
          input.value = '';
          update(label + 'をこのブラウザーに保存しました。天気を再取得します。');
          const refresh = document.querySelector('.clk-weather__refresh-btn');
          if (refresh) refresh.click();
        } catch (error) {
          update('ブラウザーに保存できませんでした。ブラウザーの保存設定を確認してください。');
        }
      });
      disable.addEventListener('click', function () {
        try { localStorage.removeItem(storageKey); } catch (error) {}
        input.value = '';
        update(label + 'を無効化しました。');
        const refresh = document.querySelector('.clk-weather__refresh-btn');
        if (refresh) refresh.click();
      });
    }
    wireKey(WEATHERAPI_KEY_STORAGE, 'pcWeatherApiKeyInput', 'pcWeatherApiStatus',
      'pcWeatherApiSave', 'pcWeatherApiDisable', 'WeatherAPI.com APIキー');
    wireKey(YAHOO_YOLP_KEY_STORAGE, 'pcYahooYolpKeyInput', 'pcYahooYolpStatus',
      'pcYahooYolpSave', 'pcYahooYolpDisable', 'Yahoo! YOLP Client ID');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWeatherProviderSettings, { once: true });
  } else {
    installWeatherProviderSettings();
  }

  window.__weatherFallback = {
    getJmaForecast: getPreferredForecast,
    getForecast: getPreferredForecast,
    isValidForecast: isValidForecast,
    hasWeatherApiKey: function () { return Boolean(readStoredWeatherKey(WEATHERAPI_KEY_STORAGE)); },
    hasYahooRainfallKey: function () { return Boolean(readStoredWeatherKey(YAHOO_YOLP_KEY_STORAGE)); }
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