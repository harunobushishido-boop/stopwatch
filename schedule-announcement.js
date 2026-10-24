(() => {
  'use strict';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const RECORD_KEY = 'pc-schedule-sheet-v1';
  const ANNOUNCED_KEY = 'pc-schedule-announced-v1';
  const VOICEVOX_LOCAL_BASE = 'http://127.0.0.1:50021';
  let lastReadAt = 0;
  let cachedRows = [];
  let readInFlight = false;
  let statusNode = null;
  let timer = null;

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
      const range = encodeURIComponent("'予定'!A1:F200");
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
  function announcementText(rows, classes) {
    const special = rows.map(r => {
      const kind = String(r[2] || '').trim();
      const detail = String(r[3] || '').trim();
      if (!detail) return '';
      return kind === '特別' ? '特別：' + detail : detail;
    }).filter(Boolean);
    const plans = rows.map(r => String(r[4] || '').trim()).filter(Boolean);
    const custom = rows.map(r => String(r[5] || '').trim()).filter(Boolean);
    const details = [...new Set([...special, ...plans])];
    if (custom.length) return [...new Set([...custom, ...details])].join('。');
    const intro = '今日の予定を発表します。今日は' + classes + '時間授業です。';
    return intro + (details.length ? '今日の予定は、' + details.join('。') + '。' : '');
  }
  const TTS_AI_BASE = 'https://api.tts.ai/v1';
  let ttsAiVoicePromise = null;
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function ttsAiVoice() {
    if (!ttsAiVoicePromise) {
      ttsAiVoicePromise = (async () => {
        const response = await fetch(TTS_AI_BASE + '/voices/?model=kokoro&language=ja', { cache: 'no-store' });
        if (!response.ok) throw new Error('TTS.aiの日本語音声一覧を取得できませんでした（HTTP ' + response.status + '）。');
        const data = await response.json();
        const voices = Array.isArray(data.voices) ? data.voices : [];
        const chosen = voices.find(v => /alpha/i.test(String(v.id || '') + ' ' + String(v.name || ''))) ||
          voices.find(v => /gongitsune|ごんぎつね/i.test(String(v.id || '') + ' ' + String(v.name || ''))) ||
          voices.find(v => String(v.language || '').toLowerCase().startsWith('ja')) || voices[0];
        if (!chosen || !chosen.id) throw new Error('TTS.aiの日本語音声が見つかりませんでした。');
        return String(chosen.id);
      })().catch(error => {
        ttsAiVoicePromise = null;
        throw error;
      });
    }
    return ttsAiVoicePromise;
  }
  async function responseAudio(response) {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('TTS.ai APIエラー（HTTP ' + response.status + '）：' + detail.slice(0, 200));
    }
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('audio/')) return response.blob();
    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (error) {
      throw new Error('TTS.aiから音声データではない応答が返されました。');
    }
    if (data.error || data.status === 'failed') {
      throw new Error('TTS.ai音声生成失敗：' + String(data.error || data.message || '原因不明').slice(0, 180));
    }
    const directUrl = data.result_url || data.audio_url || data.url;
    if (directUrl) {
      const audioResponse = await fetch(directUrl, { cache: 'no-store' });
      if (!audioResponse.ok) throw new Error('生成した音声をダウンロードできませんでした（HTTP ' + audioResponse.status + '）。');
      return audioResponse.blob();
    }
    const jobId = data.uuid || data.job_id || data.id;
    if (!jobId) throw new Error('TTS.aiの応答に音声URLまたは生成IDがありません。');
    for (let attempt = 0; attempt < 45; attempt++) {
      await sleep(1200);
      const poll = await fetch(TTS_AI_BASE + '/speech/results/?uuid=' + encodeURIComponent(jobId), { cache: 'no-store' });
      if (!poll.ok) {
        const detail = await poll.text().catch(() => '');
        throw new Error('TTS.aiの生成結果を確認できません（HTTP ' + poll.status + '）：' + detail.slice(0, 120));
      }
      const result = await poll.json();
      if (result.status === 'failed') throw new Error('TTS.ai音声生成失敗：' + String(result.error || result.message || '原因不明').slice(0, 180));
      if (result.status === 'completed') {
        const url = result.result_url || result.audio_url || result.url;
        if (!url) throw new Error('TTS.aiは生成完了を返しましたが、音声URLがありません。');
        const audioResponse = await fetch(url, { cache: 'no-store' });
        if (!audioResponse.ok) throw new Error('生成した音声を取得できません（HTTP ' + audioResponse.status + '）。');
        return audioResponse.blob();
      }
    }
    throw new Error('TTS.aiの音声生成に時間がかかりすぎています。');
  }
  const ttsAiPreparedAudio = new Map();
  async function createTtsAiAudio(text) {
    if (String(text || '').length > 500) throw new Error('無料の未登録利用は1回500文字までです。');
    const voice = await ttsAiVoice();
    const response = await fetch(TTS_AI_BASE + '/tts/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', language: 'ja', voice, text, format: 'mp3' }),
      cache: 'no-store'
    });
    const blob = await responseAudio(response);
    if (!blob || !blob.size) throw new Error('TTS.aiから空の音声が返されました。');
    return blob;
  }
  function prepareTtsAiAudio(text) {
    if (!ttsAiPreparedAudio.has(text)) {
      const pending = createTtsAiAudio(text).catch(error => {
        ttsAiPreparedAudio.delete(text);
        throw error;
      });
      ttsAiPreparedAudio.set(text, pending);
    }
    return ttsAiPreparedAudio.get(text);
  }
  async function speakWithTtsAi(text) {
    const blob = await prepareTtsAiAudio(text);
    await playBlob(blob);
    return true;
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
      await speakWithTtsAi(text);
      setStatus('TTS.aiの無料日本語音声で予定を発表しました。');
      return true;
    } catch (error) {
      console.warn('TTS.ai unavailable; trying local/browser voice', error);
      setStatus('TTS.aiに接続できないため、別の読み上げ方法を試しています。', true);
    }
    try {
      await speakWithLocalVoicevox(text);
      setStatus('このPCのVOICEVOXで予定を発表しました。');
      return true;
    } catch (error) {
      console.warn('Local VOICEVOX unavailable; using browser speech', error);
    }
    try {
      const metanFound = await speakWithBrowser(text);
      setStatus(metanFound
        ? '四国めたんのブラウザー音声で予定を発表しました。'
        : 'ブラウザーの日本語音声で予定を発表しました。');
      return true;
    } catch (error) {
      setStatus('発表できませんでした。ネット接続とブラウザーの音声を確認してください。', true);
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
      const todays = rows.filter(row => normalizeDate(row[0]) === today);
      if (!todays.length) {
        setStatus('今日の予定がありません。スプレッドシート「予定」シートのA列に今日の日付を入力してください。');
        return;
      }
      const classes = Number(String(todays.find(r => String(r[1] || '').trim())?.[1] || '').replace(/[^0-9]/g, ''));
      if (!Number.isInteger(classes) || classes < 1 || classes > 6) {
        setStatus('今日の授業時間数をスプレッドシートのB列から1〜6時間で選んでください。');
        return;
      }
      // Existing known anchors: 5 periods end at 14:25, 6 periods at 15:25.
      // The selected lesson count moves the announcement by one hour per period.
      const targetMinutesFromMidnight = (14 * 60 + 25) + (classes - 5) * 60;
      const target = String(Math.floor(targetMinutesFromMidnight / 60)).padStart(2, '0') + ':' +
        String(targetMinutesFromMidnight % 60).padStart(2, '0');
      const [hour, minute] = target.split(':').map(Number);
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const targetMinutes = hour * 60 + minute;
      const key = today + ':' + classes + ':' + target;
      if (nowMinutes < targetMinutes) {
        if (targetMinutes - nowMinutes <= 2) {
          const announcement = announcementText(todays, classes);
          prepareTtsAiAudio(announcement).catch(error => console.warn('TTS.ai pre-generation failed; speech will fall back at announcement time', error));
        }
        setStatus(classes + '時間授業：' + target + 'に音声で発表します。');
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
    note.textContent = '「予定」シート：A列=日付（プルダウン）、B列=授業時間数（プルダウン）、C列=通常/特別（プルダウン）、D列=特別の記入、E列=予定、F列=発表文。授業時間数に合わせて発表時刻を自動計算します（5時間=14:25、6時間=15:25を基準）。日付が今日の行だけを読み込み、有効/無効や開始時刻の列は使いません。特別な予定はD列に書き込めます。ページを開いたままにしてください。';
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