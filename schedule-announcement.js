(() => {
  'use strict';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const RECORD_KEY = 'pc-schedule-sheet-v1';
  const ANNOUNCED_KEY = 'pc-schedule-announced-v1';
  // Public GitHub Pages key: intentionally client-visible per owner's request.
  // Anyone can use these points; rotate the key if unexpected usage appears.
  const VOICEVOX_API_KEY = 'U33-l43-947-47I';
  const VOICEVOX_API = 'https://deprecatedapis.tts.quest/v2/voicevox/';
  const SPEAKER_CACHE_KEY = 'pc-voicevox-shikoku-metan-speaker-v1';
  const AUDIO_CACHE_NAME = 'pc-voicevox-audio-v1';
  const VOICEVOX_LOCAL_BASE = 'http://127.0.0.1:50021';
  let lastReadAt = 0;
  let cachedRows = [];
  let readInFlight = false;
  let statusNode = null;
  let timer = null;
  let speakerPromise = null;

  const todayKey = (date = new Date()) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  };
  const recordForCurrentUser = () => {
    try {
      const email = String(window.PC_AUTH && window.PC_AUTH.currentUser && window.PC_AUTH.currentUser.email || '').trim().toLowerCase();
      if (!email) return null;
      return JSON.parse(localStorage.getItem(RECORD_KEY) || '{}')[email] || null;
    } catch (error) { return null; }
  };
  const tokenNow = () => {
    const auth = window.PC_AUTH;
    const token = auth && auth.getAccessToken && auth.getAccessToken();
    const expiry = auth && auth.getAccessTokenExpiresAt && Number(auth.getAccessTokenExpiresAt());
    return token && expiry && Date.now() < expiry ? token : '';
  };
  const setStatus = (message, error = false) => {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.style.color = error ? '#b91c1c' : '';
  };
  function normalizeDate(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    let m = raw.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/);
    if (!m && /^\d{4}-\d{2}-\d{2}T/.test(raw)) m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (!m) return '';
    return m[1] + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[3])).padStart(2, '0');
  }
  async function readRows(force = false) {
    if (readInFlight) return cachedRows;
    if (!force && Date.now() - lastReadAt < 60000) return cachedRows;
    const record = recordForCurrentUser();
    const token = tokenNow();
    if (!record || !record.spreadsheetId || !token) return cachedRows;
    readInFlight = true;
    try {
      const range = encodeURIComponent("'予定'!A1:G200");
      const response = await fetch(API + encodeURIComponent(record.spreadsheetId) + '/values/' + range, {
        headers: { Authorization: 'Bearer ' + token }, cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data && data.error && data.error.message || '予定表を読み取れませんでした。');
      cachedRows = Array.isArray(data.values) ? data.values.slice(1) : [];
      lastReadAt = Date.now();
      return cachedRows;
    } finally { readInFlight = false; }
  }
  function enabled(row) {
    const v = String(row[6] == null ? '' : row[6]).trim().toLowerCase();
    return !['false', '0', 'no', '無効', 'off'].includes(v);
  }
  function announcementText(rows, classes) {
    const custom = rows.map(r => String(r[5] || '').trim()).filter(Boolean);
    if (custom.length) return [...new Set(custom)].join('。');
    const plans = rows.map(r => String(r[4] || '').trim()).filter(Boolean);
    const intro = '今日の予定を発表します。今日は' + classes + '時間授業です。';
    return intro + (plans.length ? '今日の予定は、' + [...new Set(plans)].join('。') + '。' : '');
  }
  function findMetanId(value, inheritedId = null) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findMetanId(item, null);
        if (found !== null) return found;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const name = String(value.name || value.speaker_name || value.character_name || value.speakerName || '');
    const ids = [value.speaker_id, value.speakerId, value.id, value.speaker, inheritedId];
    const id = ids.find(v => v !== undefined && v !== null && /^\d+$/.test(String(v)));
    if (/四国めたん|四国メタン|Shikoku Metan/i.test(name) && id !== undefined) return Number(id);
    for (const [key, child] of Object.entries(value)) {
      const found = findMetanId(child, /^\d+$/.test(key) ? key : null);
      if (found !== null) return found;
    }
    return null;
  }
  async function getMetanSpeakerId() {
    try {
      const saved = Number(localStorage.getItem(SPEAKER_CACHE_KEY));
      if (Number.isInteger(saved) && saved >= 0) return saved;
    } catch (error) {}
    if (!speakerPromise) {
      speakerPromise = (async () => {
        const response = await fetch(VOICEVOX_API + 'speakers/', { cache: 'no-store' });
        if (!response.ok) throw new Error('話者一覧を取得できませんでした。');
        const data = await response.json();
        const id = findMetanId(data);
        if (!Number.isInteger(id) || id < 0) throw new Error('話者一覧から四国めたんのIDを特定できませんでした。');
        try { localStorage.setItem(SPEAKER_CACHE_KEY, String(id)); } catch (error) {}
        return id;
      })().finally(() => { speakerPromise = null; });
    }
    return speakerPromise;
  }
  async function cacheKeyFor(text, speakerId) {
    const raw = 'shikoku-metan-v1|' + speakerId + '|0|1|1|' + text;
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    return encodeURIComponent(raw).slice(0, 180);
  }
  async function getCachedAudio(key) {
    if (!('caches' in window)) return null;
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const response = await cache.match(new Request(location.origin + '/__voicevox_audio_cache__/' + key));
      return response && response.ok ? await response.blob() : null;
    } catch (error) { return null; }
  }
  async function saveCachedAudio(key, blob) {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      await cache.put(new Request(location.origin + '/__voicevox_audio_cache__/' + key), new Response(blob, {
        headers: { 'Content-Type': blob.type || 'audio/wav', 'Cache-Control': 'public, max-age=31536000' }
      }));
    } catch (error) { /* Cache storage may be disabled or full. */ }
  }
  async function playBlob(blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    try { await audio.play(); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    return true;
  }
  async function speakWithSuShiki(text) {
    const speakerId = await getMetanSpeakerId();
    const cacheKey = await cacheKeyFor(text, speakerId);
    const cached = await getCachedAudio(cacheKey);
    if (cached) {
      await playBlob(cached);
      return { cached: true };
    }
    const form = new URLSearchParams();
    form.set('key', VOICEVOX_API_KEY);
    form.set('text', text);
    form.set('speaker', String(speakerId));
    form.set('pitch', '0');
    form.set('intonationScale', '1');
    form.set('speed', '1');
    const response = await fetch(VOICEVOX_API + 'audio/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      cache: 'no-store'
    });
    const blob = await response.blob();
    if (!response.ok || !blob.size || !/^audio\//i.test(blob.type)) {
      const detail = await blob.text().catch(() => '');
      throw new Error('VOICEVOX API error (' + response.status + '): ' + detail.slice(0, 160));
    }
    await saveCachedAudio(cacheKey, blob);
    await playBlob(blob);
    return { cached: false };
  }
  async function speakWithLocalVoicevox(text) {
    const queryUrl = VOICEVOX_LOCAL_BASE + '/audio_query?text=' + encodeURIComponent(text) + '&speaker=2';
    const queryResponse = await fetch(queryUrl, { method: 'POST', mode: 'cors' });
    if (!queryResponse.ok) throw new Error('Local VOICEVOX engine unavailable');
    const query = await queryResponse.json();
    const audioResponse = await fetch(VOICEVOX_LOCAL_BASE + '/synthesis?speaker=2', {
      method: 'POST', mode: 'cors',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query)
    });
    if (!audioResponse.ok) throw new Error('Local VOICEVOX synthesis failed');
    return playBlob(await audioResponse.blob());
  }
  function speakWithBrowser(text) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return reject(new Error('このブラウザーでは音声読み上げを利用できません。'));
      const voices = window.speechSynthesis.getVoices();
      const metan = voices.find(v => /四国めたん|四国メタン|Shikoku Metan/i.test(v.name));
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1;
      if (metan) utterance.voice = metan;
      utterance.onend = () => resolve(Boolean(metan));
      utterance.onerror = () => reject(new Error('ブラウザー音声で読み上げできませんでした。'));
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }
  async function speak(text) {
    try {
      const result = await speakWithSuShiki(text);
      setStatus(result.cached
        ? '保存済みの四国めたん音声で予定を発表しました（APIポイント消費なし）。'
        : 'su-shiki.com のVOICEVOX API（四国めたん）で予定を発表しました。');
      return true;
    } catch (error) {
      console.warn('su-shiki VOICEVOX API unavailable; trying local/browser voice', error);
    }
    try {
      await speakWithLocalVoicevox(text);
      setStatus('このPCのVOICEVOXで予定を発表しました。');
      return true;
    } catch (error) {}
    try {
      const metanFound = await speakWithBrowser(text);
      setStatus(metanFound
        ? '四国めたんのブラウザー音声で予定を発表しました。'
        : '予定を読み上げました。VOICEVOX APIに接続できなかったため、ブラウザー音声を使いました。');
      return true;
    } catch (error) {
      setStatus('発表できませんでした。ページを開いたままにし、音声再生とAPI接続を確認してください。', true);
      console.error('Schedule announcement audio failed', error);
      return false;
    }
  }
  window.PC_SCHEDULE_SPEAK = speak;
  async function checkAnnouncement() {
    const auth = window.PC_AUTH;
    if (!auth || !auth.currentUser || !tokenNow()) {
      setStatus('Googleログインすると、スプレッドシートの授業時間数に合わせて発表します。');
      return;
    }
    const record = recordForCurrentUser();
    if (!record || !record.spreadsheetId) {
      setStatus('予定表スプレッドシートを準備しています…');
      return;
    }
    try {
      const rows = await readRows();
      const today = todayKey();
      const todays = rows.filter(row => normalizeDate(row[0]) === today && enabled(row));
      if (!todays.length) {
        setStatus('今日の予定がありません。スプレッドシート「予定」シートのA列に今日の日付を入力してください。');
        return;
      }
      const classes = Number(String(todays.find(r => String(r[1] || '').trim())?.[1] || '').replace(/[^0-9]/g, ''));
      if (![5, 6].includes(classes)) {
        setStatus('今日の授業時間数をスプレッドシートのB列に「5」または「6」と入力してください。');
        return;
      }
      const target = classes === 6 ? '15:25' : '14:25';
      const [hour, minute] = target.split(':').map(Number);
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const targetMinutes = hour * 60 + minute;
      const key = today + ':' + classes + ':' + target;
      if (nowMinutes < targetMinutes) {
        setStatus(classes + '時間授業：' + target + 'に四国めたんで発表します。');
        return;
      }
      if (nowMinutes > targetMinutes + 20) {
        setStatus('発表時刻（' + target + '）を過ぎています。明日の予定を確認します。');
        return;
      }
      let announced = {};
      try { announced = JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || '{}'); } catch (error) {}
      if (announced[key]) {
        setStatus(classes + '時間授業の発表は本日分を実行済みです。');
        return;
      }
      const played = await speak(announcementText(todays, classes));
      if (played) {
        announced[key] = true;
        localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(announced));
      }
    } catch (error) {
      setStatus('予定表を読み取れませんでした。Googleログインとアクセス許可を確認してください。', true);
      console.error('Schedule spreadsheet read failed', error);
    }
  }
  function installStatus() {
    const host = document.getElementById('pcGoogleSheetsGroup') || document.getElementById('pcGoogleLoginGroup');
    if (!host || document.getElementById('pcScheduleAnnouncementStatus')) return;
    const box = document.createElement('div');
    box.id = 'pcScheduleAnnouncementStatus';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #15803d55;border-radius:10px;font-size:12px;line-height:1.65';
    const title = document.createElement('strong');
    title.textContent = '授業時間数に合わせた音声発表';
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:5px 0 0';
    const note = document.createElement('p');
    note.style.cssText = 'margin:5px 0 0;opacity:.75';
    note.textContent = '「予定」シート：A列=日付、B列=授業時間数（5または6）、E列=予定、F列=発表文、G列=有効。5時間は14:25、6時間は15:25。ページを開いたままにしてください。同じ文章の音声は端末内に保存して再利用します。';
    box.append(title, statusNode, note);
    host.appendChild(box);
  }
  function start() {
    installStatus();
    if (timer) clearInterval(timer);
    checkAnnouncement();
    timer = setInterval(checkAnnouncement, 10000);
  }
  window.addEventListener('pc-auth-changed', () => {
    installStatus();
    lastReadAt = 0;
    checkAnnouncement();
  });
  const observer = new MutationObserver(() => { if (!statusNode) installStatus(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();