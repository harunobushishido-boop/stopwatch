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


  const GOOGLE_WEATHER_KEY_STORAGE = 'pc-google-weather-api-key-v1';

  function readGoogleWeatherKey() {
    try { return String(localStorage.getItem(GOOGLE_WEATHER_KEY_STORAGE) || '').trim(); }
    catch (error) { return ''; }
  }

  function googleConditionCode(condition) {
    const value = String(condition && (condition.type || (condition.description && condition.description.text)) || '').toUpperCase();
    if (value.includes('THUNDER')) return '308';
    if (value.includes('BLIZZARD')) return '407';
    if (value.includes('SNOW') || value.includes('SLEET') || value.includes('ICE')) return '400';
    if (value.includes('FREEZING') || value.includes('RAIN_AND_SNOW')) return '303';
    if (value.includes('RAIN') || value.includes('SHOWER') || value.includes('DRIZZLE')) return '300';
    if (value.includes('FOG') || value.includes('HAZE')) return '209';
    if (value.includes('PARTLY_CLOUDY')) return '201';
    if (value.includes('MOSTLY_CLOUDY') || value === 'CLOUDY' || value.includes('OVERCAST')) return '200';
    if (value.includes('MOSTLY_CLEAR')) return '101';
    if (value.includes('CLEAR') || value.includes('SUNNY')) return '100';
    return '200';
  }

  function jstIsoFromDateParts(dateParts) {
    if (!dateParts || !Number.isFinite(Number(dateParts.year)) ||
        !Number.isFinite(Number(dateParts.month)) || !Number.isFinite(Number(dateParts.day))) return '';
    const year = String(dateParts.year).padStart(4, '0');
    const month = String(dateParts.month).padStart(2, '0');
    const day = String(dateParts.day).padStart(2, '0');
    const hour = String(Number(dateParts.hours || 0)).padStart(2, '0');
    return year + '-' + month + '-' + day + 'T' + hour + ':00:00+09:00';
  }

  function jstIsoFromTimestamp(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce(function (out, item) {
      if (item.type !== 'literal') out[item.type] = item.value;
      return out;
    }, {});
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' +
      parts.hour + ':' + parts.minute + ':' + parts.second + '+09:00';
  }

  function googleHourIso(hour) {
    return jstIsoFromDateParts(hour && hour.displayDateTime) ||
      jstIsoFromTimestamp(hour && hour.interval && hour.interval.startTime);
  }

  function googleDayIso(day) {
    const d = day && day.displayDate;
    if (d && Number.isFinite(Number(d.year)) && Number.isFinite(Number(d.month)) && Number.isFinite(Number(d.day))) {
      return String(d.year).padStart(4, '0') + '-' + String(d.month).padStart(2, '0') + '-' +
        String(d.day).padStart(2, '0') + 'T00:00:00+09:00';
    }
    return jstIsoFromTimestamp(day && day.interval && day.interval.startTime).slice(0, 25);
  }

  function numericField(value) {
    return value && Number.isFinite(Number(value.degrees)) ? Number(value.degrees) : '';
  }

  function kmhFromWind(wind) {
    if (!wind || !wind.speed || !Number.isFinite(Number(wind.speed.value))) return '';
    const value = Number(wind.speed.value);
    const unit = String(wind.speed.unit || '').toUpperCase();
    if (unit === 'METERS_PER_SECOND' || unit === 'M/S') return Math.round(value * 3.6 * 10) / 10;
    if (unit === 'MILES_PER_HOUR' || unit === 'MPH') return Math.round(value * 1.609344 * 10) / 10;
    return value;
  }

  async function getGoogleWeatherForecast(lat, lon, name, key) {
    const base = 'https://weather.googleapis.com/v1/';
    function apiUrl(path, extras) {
      const params = new URLSearchParams({
        key: key,
        'location.latitude': String(lat),
        'location.longitude': String(lon)
      });
      Object.keys(extras || {}).forEach(function (field) { params.set(field, String(extras[field])); });
      return base + path + '?' + params.toString();
    }

    const results = await Promise.all([
      requestJson(apiUrl('currentConditions:lookup'), 9000),
      requestJson(apiUrl('forecast/hours:lookup', { hours: 48 }), 9000),
      requestJson(apiUrl('forecast/days:lookup', { days: 10 }), 9000)
    ]);
    const current = results[0];
    const hours = Array.isArray(results[1] && results[1].forecastHours) ? results[1].forecastHours : [];
    const days = Array.isArray(results[2] && results[2].forecastDays) ? results[2].forecastDays : [];
    if (!current || !current.weatherCondition || !hours.length || !days.length) {
      throw new Error('Google Weather API から必要な予報項目が返りませんでした。APIの有効化・キー・利用上限を確認してください。');
    }

    const hourTimes = hours.map(googleHourIso);
    const hourlyWeather = {
      timeDefines: hourTimes,
      areas: [{
        area: { name: name || '富沢小学校', code: 'google-weather' },
        weatherCodes: hours.map(function (item) { return googleConditionCode(item.weatherCondition); })
      }]
    };
    const hourlyRain = {
      timeDefines: hourTimes,
      areas: [{
        area: { name: name || '富沢小学校', code: 'google-weather' },
        pops: hours.map(function (item) {
          const percent = item && item.precipitation && item.precipitation.probability && item.precipitation.probability.percent;
          return Number.isFinite(Number(percent)) ? String(Math.round(Number(percent))) : '';
        })
      }]
    };
    const hourlyTemp = {
      timeDefines: hourTimes,
      areas: [{
        area: { name: name || '富沢小学校', code: 'google-weather' },
        temps: hours.map(function (item) { return numericField(item && item.temperature); })
      }]
    };

    const dayTimes = days.map(googleDayIso);
    const dailyWeather = {
      timeDefines: dayTimes,
      areas: [{
        area: { name: name || '富沢小学校', code: 'google-weather' },
        weatherCodes: days.map(function (item) {
          const condition = item && (item.daytimeForecast || item.nighttimeForecast);
          return googleConditionCode(condition && condition.weatherCondition);
        }),
        pops: days.map(function (item) {
          const dayPercent = item && item.daytimeForecast && item.daytimeForecast.precipitation &&
            item.daytimeForecast.precipitation.probability && item.daytimeForecast.precipitation.probability.percent;
          const nightPercent = item && item.nighttimeForecast && item.nighttimeForecast.precipitation &&
            item.nighttimeForecast.precipitation.probability && item.nighttimeForecast.precipitation.probability.percent;
          const values = [dayPercent, nightPercent].filter(function (v) { return Number.isFinite(Number(v)); }).map(Number);
          return values.length ? String(Math.max.apply(null, values)) : '';
        })
      }]
    };
    const dailyTemps = {
      timeDefines: dayTimes,
      areas: [{
        area: { name: name || '富沢小学校', code: 'google-weather' },
        tempsMin: days.map(function (item) { return numericField(item && item.minTemperature); }),
        tempsMax: days.map(function (item) { return numericField(item && item.maxTemperature); })
      }]
    };

    const result = attachMeta([
      { publishingOffice: 'Google Weather API', timeSeries: [hourlyWeather, hourlyRain, hourlyTemp] },
      { publishingOffice: 'Google Weather API', timeSeries: [dailyWeather, dailyTemps] }
    ], Date.now(), false, {
      time: current.currentTime || new Date().toISOString(),
      temp: numericField(current.temperature),
      humidity: Number.isFinite(Number(current.relativeHumidity)) ? Number(current.relativeHumidity) : '',
      apparentTemp: numericField(current.feelsLikeTemperature),
      wind: kmhFromWind(current.wind),
      windDirection: current.wind && current.wind.direction && current.wind.direction.cardinal || '',
      precipitation: current.precipitation && current.precipitation.probability &&
        Number.isFinite(Number(current.precipitation.probability.percent)) ? Number(current.precipitation.probability.percent) : '',
      code: googleConditionCode(current.weatherCondition),
      isDay: Boolean(current.isDaytime)
    });
    result.__source = 'Google Weather API';
    result.__googleWeather = true;
    return result;
  }

  async function getPreferredForecast(lat, lon, name) {
    const key = readGoogleWeatherKey();
    if (!key) return getJmaForecast(lat, lon, name);
    try {
      return await getGoogleWeatherForecast(Number(lat), Number(lon), name, key);
    } catch (googleError) {
      try {
        const fallback = await getJmaForecast(lat, lon, name);
        fallback.__source = '気象庁（Google Weather API 接続失敗時の予備）';
        fallback.__providerError = String(googleError && googleError.message || googleError);
        return fallback;
      } catch (jmaError) {
        throw new Error('Google Weather API: ' + String(googleError && googleError.message || googleError) +
          ' / 気象庁: ' + String(jmaError && jmaError.message || jmaError));
      }
    }
  }

  function installGoogleWeatherSettings() {
    const host = document.querySelector('.clk-weather__privacy');
    if (!host || document.getElementById('pcGoogleWeatherSettings')) return;
    const panel = document.createElement('section');
    panel.id = 'pcGoogleWeatherSettings';
    panel.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #00000018;color:inherit';
    panel.innerHTML =
      '<strong style="display:block;font-size:12px;margin-bottom:6px">Google Weather API（任意）</strong>' +
      '<p style="font-size:11.5px;line-height:1.55;margin:0 0 8px">Googleの予報を優先して使います。キーはこのブラウザー内だけに保存し、GitHubには書き込みません。キー未設定・通信失敗時は気象庁の予報へ戻ります。通常キーを使う場合は、Google Cloudで利用元サイトとWeather APIに制限を設定してください。</p>' +
      '<label for="pcGoogleWeatherKeyInput" style="display:block;font-size:11.5px;margin-bottom:5px">Google Weather API キー</label>' +
      '<input id="pcGoogleWeatherKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="Googleから取得したキーを貼り付け" style="box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #0000002b;border-radius:8px;background:#fff;color:#111;font-size:12px">' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">' +
      '<button type="button" id="pcGoogleWeatherSave" style="border:1px solid #00000030;border-radius:8px;padding:7px 10px;background:#222;color:#fff;font-size:12px;cursor:pointer">キーを保存して再取得</button>' +
      '<button type="button" id="pcGoogleWeatherDisable" style="border:1px solid #00000030;border-radius:8px;padding:7px 10px;background:transparent;color:inherit;font-size:12px;cursor:pointer">Google APIを無効化</button>' +
      '</div>' +
      '<p id="pcGoogleWeatherStatus" aria-live="polite" style="font-size:11px;line-height:1.5;margin:7px 0 0"></p>' +
      '<p style="font-size:11px;line-height:1.6;margin:7px 0 0"><a href="https://developers.google.com/maps/documentation/weather/demo-key?hl=ja" target="_blank" rel="noopener noreferrer">Googleの無料デモキー取得・説明</a>（試用向け。継続運用にはGoogle Cloudの設定が必要です）</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;margin-top:8px">' +
      '<a href="https://www.google.com/search?q=%E4%BB%99%E5%8F%B0%E5%B8%82%E5%A4%AA%E7%99%BD%E5%8C%BA+%E5%AF%8C%E6%B2%A2+%E5%A4%A9%E6%B0%97" target="_blank" rel="noopener noreferrer">Googleで天気を見る</a>' +
      '<a href="https://weathernews.jp/" target="_blank" rel="noopener noreferrer">ウェザーニュース</a>' +
      '<a href="https://weather.yahoo.co.jp/weather/" target="_blank" rel="noopener noreferrer">Yahoo!天気</a>' +
      '</div>';
    host.appendChild(panel);
    const input = panel.querySelector('#pcGoogleWeatherKeyInput');
    const status = panel.querySelector('#pcGoogleWeatherStatus');
    const save = panel.querySelector('#pcGoogleWeatherSave');
    const disable = panel.querySelector('#pcGoogleWeatherDisable');
    function updateStatus(message) {
      status.textContent = message;
      status.style.color = '#555';
    }
    const savedKey = readGoogleWeatherKey();
    updateStatus(savedKey ? 'Google Weather API キーは保存済みです（キー自体は表示していません）。' : 'Google API未設定：現在は気象庁の予報を使用しています。');
    save.addEventListener('click', function () {
      const value = String(input.value || '').trim();
      if (!value) {
        updateStatus('Google APIキーを入力してください。');
        return;
      }
      try {
        localStorage.setItem(GOOGLE_WEATHER_KEY_STORAGE, value);
        input.value = '';
        updateStatus('キーをこのブラウザーに保存しました。予報を再取得します。');
        const refresh = document.querySelector('.clk-weather__refresh-btn');
        if (refresh) refresh.click();
      } catch (error) {
        updateStatus('ブラウザーに保存できませんでした。プライベート閲覧設定などを確認してください。');
      }
    });
    disable.addEventListener('click', function () {
      try { localStorage.removeItem(GOOGLE_WEATHER_KEY_STORAGE); } catch (error) {}
      input.value = '';
      updateStatus('Google APIを無効化しました。気象庁の予報へ切り替えます。');
      const refresh = document.querySelector('.clk-weather__refresh-btn');
      if (refresh) refresh.click();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installGoogleWeatherSettings, { once: true });
  } else {
    installGoogleWeatherSettings();
  }

  window.__weatherFallback = {
    getJmaForecast: getPreferredForecast,
    getForecast: getPreferredForecast,
    isValidForecast: isValidForecast,
    hasGoogleWeatherKey: function () { return Boolean(readGoogleWeatherKey()); }
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