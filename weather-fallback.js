(function () {
  'use strict';

  const CACHE_PREFIX = 'pc-jma-forecast-v1:';
  const MAX_STALE_MS = 72 * 60 * 60 * 1000;
  const JMA_FORECAST_URL = 'https://www.jma.go.jp/bosai/forecast/data/forecast/';
  const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

  const numericOrBlank = value =>
    value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : Number(value);
  const probabilityOrBlank = value => {
    const n = numericOrBlank(value);
    return n === '' ? '' : Math.max(0, Math.min(100, Math.round(n)));
  };

  function jstIso(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + 'T00:00:00+09:00';
    return text.replace(/Z$/, '+00:00');
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

  function attachMeta(forecast, source, fetchedAt, stale) {
    forecast.__source = source || '気象庁';
    forecast.__fetchedAt = Number(fetchedAt) || Date.now();
    forecast.__stale = Boolean(stale);
    return forecast;
  }

  function validForecast(forecast) {
    if (!Array.isArray(forecast) || !forecast[0] || !forecast[1]) return false;
    const short = forecast[0].timeSeries;
    const weekly = forecast[1].timeSeries;
    return Array.isArray(short) &&
      short.some(ts => Array.isArray(ts.timeDefines) && ts.areas?.some(a => Array.isArray(a.weatherCodes))) &&
      short.some(ts => Array.isArray(ts.timeDefines) && ts.areas?.some(a => Array.isArray(a.pops))) &&
      short.some(ts => Array.isArray(ts.timeDefines) && ts.areas?.some(a => Array.isArray(a.temps))) &&
      Array.isArray(weekly) &&
      weekly.some(ts => Array.isArray(ts.timeDefines) && ts.areas?.some(a => Array.isArray(a.weatherCodes))) &&
      weekly.some(ts => Array.isArray(ts.timeDefines) && ts.areas?.some(a => Array.isArray(a.tempsMin) && Array.isArray(a.tempsMax)));
  }

  async function prefectureForecastCode(lat, lon) {
    const url = GSI_REVERSE_URL + '?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon);
    try {
      const data = await requestJson(url, 7000);
      const muniCode = String(data && data.results && data.results.muniCd || '').replace(/\D/g, '');
      const prefecture = muniCode.slice(0, 2);
      if (/^\d{2}$/.test(prefecture) && Number(prefecture) >= 1 && Number(prefecture) <= 47) {
        return prefecture.padStart(2, '0') + '0000';
      }
    } catch (error) {
      console.warn('国土地理院の逆ジオコーディングに失敗しました。', error);
    }

    // The user's saved default point is Tomizawa Elementary School, Sendai.
    // Use this only as a narrow fallback for the Sendai area, never for unrelated coordinates.
    if (lat >= 37.9 && lat <= 38.6 && lon >= 140.45 && lon <= 141.25) return '040000';
    throw new Error('この位置の都道府県コードを取得できませんでした。位置情報を再取得するか、場所を選び直してください。');
  }

  function pickArea(areas, prefectureCode, lat, lon) {
    const rows = Array.isArray(areas) ? areas : [];
    if (!rows.length) return null;
    if (prefectureCode === '040000') {
      const preferred = lon < 140.65 ? '西部' : '東部';
      return rows.find(item => String(item.area && item.area.name || '').includes(preferred)) || rows[0];
    }
    return rows[0];
  }

  function pickTemperatureArea(areas, prefectureCode) {
    const rows = Array.isArray(areas) ? areas : [];
    if (!rows.length) return null;
    // The JMA forecast's temperature series is station-based, unlike the regional weather forecast.
    if (prefectureCode === '040000') {
      return rows.find(item => String(item.area && item.area.name || '') === '仙台') || rows[0];
    }
    return rows[0];
  }

  function atOrBefore(timeDefines, values, targetTime) {
    if (!Array.isArray(timeDefines) || !Array.isArray(values) || !timeDefines.length) return '';
    const target = Date.parse(targetTime);
    let chosen = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < timeDefines.length; i++) {
      const stamp = Date.parse(timeDefines[i]);
      if (!Number.isFinite(stamp)) continue;
      if (stamp <= target && target - stamp < bestDistance) {
        chosen = i;
        bestDistance = target - stamp;
      }
    }
    if (chosen < 0) {
      let nearest = 0;
      for (let i = 1; i < timeDefines.length; i++) {
        if (Math.abs(Date.parse(timeDefines[i]) - target) < Math.abs(Date.parse(timeDefines[nearest]) - target)) nearest = i;
      }
      chosen = nearest;
    }
    return numericOrBlank(values[chosen]);
  }

  function fromJma(data, prefectureCode, lat, lon) {
    if (!Array.isArray(data) || !data[0] || !Array.isArray(data[0].timeSeries) || !data[1] || !Array.isArray(data[1].timeSeries)) {
      throw new Error('気象庁の天気予報データ形式が正しくありません');
    }
    const shortTs = data[0].timeSeries;
    const weeklyTs = data[1].timeSeries;
    const shortWeather = shortTs.find(ts => ts.areas?.some(a => Array.isArray(a.weatherCodes)));
    const shortPop = shortTs.find(ts => ts.areas?.some(a => Array.isArray(a.pops)));
    const shortTemp = shortTs.find(ts => ts.areas?.some(a => Array.isArray(a.temps)));
    const weeklyWeather = weeklyTs.find(ts => ts.areas?.some(a => Array.isArray(a.weatherCodes)));
    const weeklyTemp = weeklyTs.find(ts => ts.areas?.some(a => Array.isArray(a.tempsMin) && Array.isArray(a.tempsMax)));
    if (!shortWeather || !shortPop || !shortTemp || !weeklyWeather || !weeklyTemp) {
      throw new Error('気象庁の予報項目がそろっていません');
    }

    const regionWeather = pickArea(shortWeather.areas, prefectureCode, lat, lon);
    const regionPop = pickArea(shortPop.areas, prefectureCode, lat, lon);
    const regionalWeekly = pickArea(weeklyWeather.areas, prefectureCode, lat, lon);
    const stationTemp = pickTemperatureArea(shortTemp.areas, prefectureCode);
    const weeklyStationTemp = pickTemperatureArea(weeklyTemp.areas, prefectureCode);
    if (!regionWeather || !regionPop || !regionalWeekly || !stationTemp || !weeklyStationTemp) {
      throw new Error('選択地点の予報エリアが見つかりません');
    }

    const codeArea = { name: regionWeather.area && regionWeather.area.name || '予報エリア', code: regionWeather.area && regionWeather.area.code || '' };
    const tempArea = { name: stationTemp.area && stationTemp.area.name || '気温予報地点', code: stationTemp.area && stationTemp.area.code || '' };
    const weeklyTempArea = { name: weeklyStationTemp.area && weeklyStationTemp.area.name || '気温予報地点', code: weeklyStationTemp.area && weeklyStationTemp.area.code || '' };
    const shortWeatherTimes = (shortWeather.timeDefines || []).map(jstIso);
    const shortPopTimes = (shortPop.timeDefines || []).map(jstIso);
    const shortTempTimes = (shortTemp.timeDefines || []).map(jstIso);
    const weeklyWeatherTimes = (weeklyWeather.timeDefines || []).map(jstIso);
    const weeklyTempTimes = (weeklyTemp.timeDefines || []).map(jstIso);

    const forecast = [
      {
        publishingOffice: data[0].publishingOffice || '気象庁',
        reportDatetime: data[0].reportDatetime || '',
        timeSeries: [
          { timeDefines: shortWeatherTimes, areas: [{ area: codeArea, weatherCodes: (regionWeather.weatherCodes || []).map(String) }] },
          { timeDefines: shortPopTimes, areas: [{ area: codeArea, pops: (regionPop.pops || []).map(probabilityOrBlank) }] },
          { timeDefines: shortTempTimes, areas: [{ area: tempArea, temps: (stationTemp.temps || []).map(numericOrBlank) }] }
        ]
      },
      {
        publishingOffice: data[1].publishingOffice || data[0].publishingOffice || '気象庁',
        reportDatetime: data[1].reportDatetime || '',
        timeSeries: [
          {
            timeDefines: (weeklyWeather.timeDefines || []).map(jstIso),
            areas: [{
              area: codeArea,
              weatherCodes: (regionalWeekly.weatherCodes || []).map(String),
              pops: (regionalWeekly.pops || []).map(probabilityOrBlank)
            }]
          },
          {
            timeDefines: weeklyTempTimes,
            areas: [{
              area: weeklyTempArea,
              tempsMin: (weeklyStationTemp.tempsMin || []).map(numericOrBlank),
              tempsMax: (weeklyStationTemp.tempsMax || []).map(numericOrBlank)
            }]
          }
        ]
      }
    ];

    const nowIso = new Date().toISOString();
    const currentWeather = atOrBefore(shortWeatherTimes, regionWeather.weatherCodes || [], nowIso);
    const currentTemp = atOrBefore(shortTempTimes, stationTemp.temps || [], nowIso);
    const current = {
      time: shortTempTimes.find((time, index) => Date.parse(time) <= Date.now() && numericOrBlank((stationTemp.temps || [])[index]) !== '') || shortTempTimes[0] || '',
      temp: currentTemp,
      humidity: '',
      apparentTemp: '',
      wind: '',
      windDirection: '',
      precipitation: '',
      code: currentWeather === '' ? '200' : String(currentWeather).padStart(3, '0'),
      isDay: true
    };
    forecast.__current = current;
    forecast.__reportDatetime = data[0].reportDatetime || '';
    forecast.__regionName = codeArea.name;
    return attachMeta(forecast, '気象庁（地域予報・週間予報）', Date.now(), false);
  }

  function saveForecast(key, forecast) {
    try {
      localStorage.setItem(key, JSON.stringify({
        version: 4,
        source: forecast.__source || '気象庁',
        fetchedAt: forecast.__fetchedAt || Date.now(),
        current: forecast.__current || null,
        reportDatetime: forecast.__reportDatetime || '',
        regionName: forecast.__regionName || '',
        forecast
      }));
    } catch (error) {}
    return forecast;
  }

  function readCachedForecast(key) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null');
      if (!stored || stored.version !== 4 || !Array.isArray(stored.forecast) ||
          !validForecast(stored.forecast) || !Number.isFinite(Number(stored.fetchedAt))) return null;
      if (Date.now() - Number(stored.fetchedAt) > MAX_STALE_MS) return null;
      stored.forecast.__current = stored.current || null;
      stored.forecast.__reportDatetime = stored.reportDatetime || '';
      stored.forecast.__regionName = stored.regionName || '';
      return attachMeta(stored.forecast, '気象庁（保存済み予報）', Number(stored.fetchedAt), true);
    } catch (error) {
      return null;
    }
  }

  async function getJmaForecast(lat, lon) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('緯度・経度が正しくありません');
    }
    const key = cacheKey(latitude, longitude);
    try {
      const prefectureCode = await prefectureForecastCode(latitude, longitude);
      const data = await requestJson(JMA_FORECAST_URL + encodeURIComponent(prefectureCode) + '.json', 10000);
      const forecast = fromJma(data, prefectureCode, latitude, longitude);
      if (!validForecast(forecast)) throw new Error('気象庁の予報データを検証できません');
      return saveForecast(key, forecast);
    } catch (error) {
      const cached = readCachedForecast(key);
      if (cached) {
        console.warn('気象庁からの取得に失敗したため、保存済み予報を表示します。', error);
        return cached;
      }
      throw new Error('気象庁の天気予報を取得できませんでした。位置情報・通信状態を確認して再取得してください。(' + String(error && error.message || error) + ')');
    }
  }

  window.__weatherFallback = {
    getJmaForecast,
    // A compatibility alias for the inline weather renderer; it now uses JMA data only.
    getOpenMeteoForecast: getJmaForecast,
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

  // Keep the weather attribution accurate when the main page's inline renderer updates status text.
  function applyJmaLabels() {
    const sourceNote = document.querySelector('.clk-weather__source-note');
    const root = sourceNote && sourceNote.closest('.clk-panel__pane') || document;
    const sectionTitle = root.querySelector('.clk-weather__section-title');
    if (sectionTitle) sectionTitle.textContent = sectionTitle.textContent.replace(/Open-Meteo/gi, '気象庁');
    for (const selector of ['.clk-weather__source-note', '.clk-weather__privacy-note', '.clk-weather__feels']) {
      const node = root.querySelector(selector);
      if (!node) continue;
      node.textContent = node.textContent
        .replace(/Open-Meteo/gi, '気象庁')
        .replace('現在値', '予報値')
        .replace('時間別・7日間', '地域予報・週間予報')
        .replace(
          '富沢小学校周辺の座標を使い、気象庁から時間別予報と7日間の予報を取得します。予報は学校敷地そのものの観測値ではありません。',
          '緯度・経度から都道府県の気象庁予報を取得します。気温は予報地点、天気と降水確率は地域予報で、学校敷地そのものの観測値ではありません。'
        )
        .replace(
          '天気予報の取得には気象庁へ緯度・経度を送信します。GPSを使う場合は現在地の座標も送信されます。住所検索には国土地理院の住所検索APIを利用します。',
          '位置から都道府県を特定するため、国土地理院の逆ジオコーディングを使います。天気の取得先は気象庁です。GPSを使う場合は現在地の座標を国土地理院へ送信します。'
        );
    }
    const links = root.querySelectorAll('.clk-weather__source-links a');
    if (links[0]) {
      links[0].href = 'https://www.jma.go.jp/bosai/forecast/';
      links[0].textContent = '気象庁公式サイト';
    }
    if (links[1]) {
      links[1].href = 'https://www.data.jma.go.jp/developer/weatherdataguide/knowledge.html';
      links[1].textContent = '気象データの説明';
    }
    root.querySelectorAll('.clk-weather-inline').forEach(button => {
      button.title = button.ariaLabel = '気象庁の天気予報を開く';
    });
  }

  applyJmaLabels();
  const weatherRoot = document.querySelector('.clk-weather__source-note')?.closest('.clk-panel__pane');
  if (weatherRoot) {
    const labelObserver = new MutationObserver(applyJmaLabels);
    labelObserver.observe(weatherRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'href'] });
  }
})();