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
  // TTS Quest の無料・APIキー不要のWEB版VOICEVOX APIを使用。
  // speaker=2 は VOICEVOX:四国めたん（ノーマル）。
  const TTS_QUEST_API = 'https://api.tts.quest/v3/voicevox/synthesis';
  const TTS_QUEST_SPEAKER = 2;
  const voicevoxQuestPreparedAudio = new Map();
  let voicevoxQuestNextRequestAt = 0;
  let activeAudio = null;
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function playAudioUrl(url) {
    return new Promise((resolve, reject) => {
      if (activeAudio) {
        try { activeAudio.pause(); activeAudio.src = ''; } catch (error) {}
        activeAudio = null;
      }
      const audio = new Audio(url);
      activeAudio = audio;
      audio.preload = 'auto';
      audio.volume = 1;
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        if (activeAudio === audio) activeAudio = null;
      };
      const onEnded = () => {
        if (settled) return;
        settled = true; cleanup(); resolve(true);
      };
      const onError = () => {
        if (settled) return;
        settled = true; cleanup();
        reject(new Error('VOICEVOX音声を再生できませんでした。ネット接続とブラウザーの音量を確認してください。'));
      };
      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      Promise.resolve(audio.play()).catch(error => {
        if (settled) return;
        settled = true; cleanup();
        reject(new Error(error && error.name === 'NotAllowedError'
          ? 'ブラウザーが自動再生をブロックしました。ページ上の音声テストボタンを一度押してください。'
          : 'VOICEVOX音声の再生を開始できませんでした：' + String(error && error.message || error)));
      });
    });
  }
  async function playBlob(blob) {
    const url = URL.createObjectURL(blob);
    try { return await playAudioUrl(url); }
    finally { URL.revokeObjectURL(url); }
  }
  async function requestVoicevoxQuestAudioUrl(text) {
    const phrase = String(text || '').trim();
    if (!phrase) throw new Error('読み上げる文章が空です。');
    if (phrase.length > 500) throw new Error('無料の読み上げAPIに送る文章が長すぎます。500文字以内にしてください。');
    for (let attempt = 0; attempt < 3; attempt++) {
      const waiting = voicevoxQuestNextRequestAt - Date.now();
      if (waiting > 0) await sleep(waiting);
      const url = new URL(TTS_QUEST_API);
      url.searchParams.set('text', phrase);
      url.searchParams.set('speaker', String(TTS_QUEST_SPEAKER));
      let response;
      let data;
      try {
        response = await fetch(url.toString(), { method: 'GET', cache: 'no-store' });
        data = await response.json().catch(() => ({}));
      } catch (error) {
        throw new Error('WEB版VOICEVOX APIに接続できません。ネット接続またはAPI側の状態を確認してください。');
      }
      const retryAfter = Number(data && data.retryAfter || 0);
      if (retryAfter > 0) {
        voicevoxQuestNextRequestAt = Date.now() + retryAfter * 1000;
        if (attempt >= 2) throw new Error('無料APIの利用間隔に達しました。約' + retryAfter + '秒後に音声テストをもう一度お試しください。');
        setStatus('無料VOICEVOX APIの利用間隔に達したため、' + retryAfter + '秒待ってから再試行します。');
        await sleep(Math.max(1000, retryAfter * 1000));
        continue;
      }
      if (!response.ok || !data || data.success !== true) {
        throw new Error('WEB版VOICEVOX APIが音声を受け付けませんでした（HTTP ' + response.status + '）。少し待って再試行してください。');
      }
      if (!data.audioStatusUrl || !data.mp3DownloadUrl) {
        throw new Error('WEB版VOICEVOX APIから音声URLが返されませんでした。');
      }
      // Synthesis is asynchronous. Poll the provided status URL until audio is ready.
      for (let poll = 0; poll < 60; poll++) {
        await sleep(1000);
        let statusResponse;
        let status;
        try {
          statusResponse = await fetch(data.audioStatusUrl, { cache: 'no-store' });
          status = await statusResponse.json().catch(() => ({}));
        } catch (error) {
          throw new Error('VOICEVOXの音声生成状況を確認できません。APIの接続設定を確認してください。');
        }
        if (!statusResponse.ok) throw new Error('VOICEVOXの音声生成状況を取得できませんでした（HTTP ' + statusResponse.status + '）。');
        if (status.isAudioError) throw new Error('VOICEVOXの音声合成に失敗しました。');
        if (status.isAudioReady) {
          voicevoxQuestNextRequestAt = Date.now();
          return data.mp3DownloadUrl;
        }
      }
      throw new Error('VOICEVOXの音声生成が時間内に完了しませんでした。少し待って再試行してください。');
    }
    throw new Error('VOICEVOX APIを再試行できませんでした。');
  }
  function prepareVoicevoxQuestAudio(text) {
    const phrase = String(text || '').trim();
    if (!voicevoxQuestPreparedAudio.has(phrase)) {
      const pending = requestVoicevoxQuestAudioUrl(phrase).catch(error => {
        voicevoxQuestPreparedAudio.delete(phrase);
        throw error;
      });
      voicevoxQuestPreparedAudio.set(phrase, pending);
    }
    return voicevoxQuestPreparedAudio.get(phrase);
  }
  async function speakWithVoicevoxQuest(text) {
    const audioUrl = await prepareVoicevoxQuestAudio(text);
    await playAudioUrl(audioUrl);
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
      await speakWithVoicevoxQuest(text);
      setStatus('WEB版VOICEVOX API（四国めたん・ノーマル）で発表しました。');
      return true;
    } catch (error) {
      console.warn('TTS Quest VOICEVOX unavailable; trying local/browser voice', error);
      setStatus('WEB版VOICEVOX APIが使えないため、別の読み上げ方法を試しています。', true);
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
          prepareVoicevoxQuestAudio(announcement).catch(error => console.warn('TTS.ai pre-generation failed; speech will fall back at announcement time', error));
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
    const apiHelp = document.createElement('p');
    apiHelp.style.cssText = 'margin:10px 0 0;font-size:12px;line-height:1.6';
    apiHelp.append('音声には、住所・電話番号・APIキー登録が不要な無料のWEB版VOICEVOX APIを使います。声は四国めたん（ノーマル）です。無料APIのため、混雑時は合成に時間がかかったり、再試行まで待ち時間が発生することがあります。 ');
    const apiLink = document.createElement('a');
    apiLink.href = 'https://voicevox.su-shiki.com/su-shikiapis/ttsquest/';
    apiLink.target = '_blank';
    apiLink.rel = 'noopener noreferrer';
    apiLink.textContent = 'APIの説明';
    apiLink.style.cssText = 'color:inherit;text-decoration:underline;text-underline-offset:3px';
    apiHelp.append(apiLink);
    try { localStorage.removeItem('pc-tts-ai-api-key-v1'); } catch (error) {}
    box.append(title, statusNode, note, apiHelp);
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