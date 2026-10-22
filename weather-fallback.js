(function () {
  'use strict';

  const CACHE_PREFIX = 'pc-open-meteo-forecast-v3:';
  const MAX_STALE_MS = 72 * 60 * 60 * 1000;

  const numericOrBlank = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : Number(value);
  const probabilityOrBlank = (value) => {
    const n = numericOrBlank(value);
    return n === '' ? '' : Math.max(0, Math.min(100, Math.round(n)));
  };

  function jstIso(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    text = text.replace(' ', 'T');
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) return text;
    if (/T\d{2}:\d{2}$/.test(text)) text += ':00';
    return text + '+09:00';
  }

  async function requestJson(url, timeoutMs = 9000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error('API応答の形式が不正です');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function cacheKey(lat, lon) {
    return CACHE_PREFIX + Number(lat).toFixed(3) + ',' + Number(lon).toFixed(3);
  }

  function jmaStyleCode(openMeteoCode) {
    const code = Number(openMeteoCode);
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '400';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return '300';
    if (code === 0 || code === 1) return '100';
    return Number.isFinite(code) ? '200' : '200';
  }

  function makeOpenMeteoUrl(lat, lon) {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
      hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      timezone: 'Asia/Tokyo',
      forecast_days: '7',
      temperature_unit: 'celsius',
      wind_speed_unit: 'kmh',
      precipitation_unit: 'mm'
    });
    return 'https://api.open-meteo.com/v1/forecast?' + params.toString();
  }

  function attachMeta(forecast, source, fetchedAt, stale) {
    forecast.__source = source || 'Open-Meteo';
    forecast.__fetchedAt = Number(fetchedAt) || Date.now();
    forecast.__stale = Boolean(stale);
    return forecast;
  }

  function validForecast(forecast) {
    if (!Array.isArray(forecast) || !forecast[0] || !forecast[1]) return false;
    const hourly = forecast[0].timeSeries;
    const daily = forecast[1].timeSeries;
    return Array.isArray(hourly) && hourly.some((ts) => Array.isArray(ts.timeDefines) && ts.areas?.some((a) => Array.isArray(a.weatherCodes))) &&
      hourly.some((ts) => Array.isArray(ts.timeDefines) && ts.areas?.some((a) => Array.isArray(a.pops))) &&
      hourly.some((ts) => Array.isArray(ts.timeDefines) && ts.areas?.some((a) => Array.isArray(a.temps))) &&
      Array.isArray(daily) && daily.some((ts) => Array.isArray(ts.timeDefines) && ts.areas?.some((a) => Array.isArray(a.weatherCodes))) &&
      daily.some((ts) => Array.isArray(ts.timeDefines) && ts.areas?.some((a) => Array.isArray(a.tempsMin) && Array.isArray(a.tempsMax)));
  }

  function fromOpenMeteo(data) {
    const hourly = data && data.hourly;
    const daily = data && data.daily;
    const now = data && data.current;
    if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.temperature_2m) ||
        !Array.isArray(hourly.weather_code) || !daily || !Array.isArray(daily.time) ||
        !Array.isArray(daily.weather_code) || !Array.isArray(daily.temperature_2m_min) ||
        !Array.isArray(daily.temperature_2m_max)) {
      throw new Error('Open-Meteoの予報データ形式が不正です');
    }

    const hourlyRows = hourly.time.map((time, index) => ({
      iso: jstIso(time),
      temp: numericOrBlank(hourly.temperature_2m[index]),
      humidity: numericOrBlank(hourly.relative_humidity_2m && hourly.relative_humidity_2m[index]),
      wind: numericOrBlank(hourly.wind_speed_10m && hourly.wind_speed_10m[index]),
      code: jmaStyleCode(hourly.weather_code[index]),
      pop: probabilityOrBlank(hourly.precipitation_probability && hourly.precipitation_probability[index])
    })).filter((row) => row.iso);

    const dailyRows = daily.time.map((date, index) => ({
      date: String(date),
      code: jmaStyleCode(daily.weather_code[index]),
      pop: probabilityOrBlank(daily.precipitation_probability_max && daily.precipitation_probability_max[index]),
      min: numericOrBlank(daily.temperature_2m_min[index]),
      max: numericOrBlank(daily.temperature_2m_max[index])
    })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));

    if (!hourlyRows.length || !dailyRows.length) throw new Error('Open-Meteoの予報が空です');

    const current = {
      time: jstIso(now && now.time),
      temp: numericOrBlank(now && now.temperature_2m),
      humidity: numericOrBlank(now && now.relative_humidity_2m),
      apparentTemp: numericOrBlank(now && now.apparent_temperature),
      wind: numericOrBlank(now && now.wind_speed_10m),
      windDirection: numericOrBlank(now && now.wind_direction_10m),
      precipitation: numericOrBlank(now && now.precipitation),
      code: jmaStyleCode(now && now.weather_code),
      isDay: Number(now && now.is_day) === 1
    };

    // Older/partial API responses are handled by using the closest hourly record.
    if (current.temp === '') {
      const target = Date.now();
      const nearest = hourlyRows.reduce((best, row) => {
        const distance = Math.abs(Date.parse(row.iso) - target);
        return !best || distance < best.distance ? { row, distance } : best;
      }, null);
      if (nearest) {
        current.time = nearest.row.iso;
        current.temp = nearest.row.temp;
        current.humidity = nearest.row.humidity;
        current.wind = nearest.row.wind;
        current.code = nearest.row.code;
      }
    }

    const area = { name: 'Open-Meteo', code: 'open-meteo' };
    const forecast = [
      {
        publishingOffice: 'Open-Meteo',
        timeSeries: [
          { timeDefines: hourlyRows.map((row) => row.iso), areas: [{ area, weatherCodes: hourlyRows.map((row) => row.code) }] },
          { timeDefines: hourlyRows.map((row) => row.iso), areas: [{ area, pops: hourlyRows.map((row) => row.pop) }] },
          { timeDefines: hourlyRows.map((row) => row.iso), areas: [{ area, temps: hourlyRows.map((row) => row.temp) }] }
        ]
      },
      {
        publishingOffice: 'Open-Meteo',
        timeSeries: [
          {
            timeDefines: dailyRows.map((row) => row.date),
            areas: [{ area, weatherCodes: dailyRows.map((row) => row.code), pops: dailyRows.map((row) => row.pop) }]
          },
          {
            timeDefines: dailyRows.map((row) => row.date),
            areas: [{ area, tempsMin: dailyRows.map((row) => row.min), tempsMax: dailyRows.map((row) => row.max) }]
          }
        ]
      }
    ];
    forecast.__current = current;
    return attachMeta(forecast, 'Open-Meteo（時間別・7日間予報）', Date.now(), false);
  }

  function saveForecast(key, forecast) {
    try {
      localStorage.setItem(key, JSON.stringify({
        version: 3,
        source: forecast.__source || 'Open-Meteo',
        fetchedAt: forecast.__fetchedAt || Date.now(),
        current: forecast.__current || null,
        forecast
      }));
    } catch (error) {
      // Storage quota/privacy mode must not block live weather.
    }
    return forecast;
  }

  function readCachedForecast(key) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null');
      if (!stored || stored.version !== 3 || !Array.isArray(stored.forecast) ||
          !validForecast(stored.forecast) || !Number.isFinite(Number(stored.fetchedAt))) return null;
      if (Date.now() - Number(stored.fetchedAt) > MAX_STALE_MS) return null;
      stored.forecast.__current = stored.current || null;
      const dateLabel = new Date(Number(stored.fetchedAt)).toLocaleString('ja-JP', { hour12: false });
      return attachMeta(stored.forecast, 'Open-Meteo（保存済み予報）', Number(stored.fetchedAt), true);
    } catch (error) {
      return null;
    }
  }

  async function getOpenMeteoForecast(lat, lon) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('緯度・経度が正しくありません');
    }
    const key = cacheKey(latitude, longitude);
    try {
      const data = await requestJson(makeOpenMeteoUrl(latitude, longitude), 9000);
      const forecast = fromOpenMeteo(data);
      if (!validForecast(forecast)) throw new Error('Open-Meteoの予報データを検証できません');
      return saveForecast(key, forecast);
    } catch (error) {
      const cached = readCachedForecast(key);
      if (cached) {
        console.warn('Open-Meteoの取得に失敗したため、保存済み予報を表示します。', error);
        return cached;
      }
      throw new Error('Open-Meteoから天気予報を取得できませんでした。通信状態を確認して再取得してください。');
    }
  }

  window.__weatherFallback = {
    getOpenMeteoForecast,
    isValidForecast: validForecast
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