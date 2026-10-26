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
  let announcementCheckInFlight = false;
  let lastTokenRefreshRequestAt = 0;

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
  async function readRows(force = false) {
    if (readInFlight) return cachedRows;
    if (!force && Date.now() - lastReadAt < 4000) return cachedRows;
    let record = recordForCurrentUser();
    const token = tokenNow();
    if (!record || !record.spreadsheetId || !token) return cachedRows;
    readInFlight = true;
    try {
      const range = encodeURIComponent("'予定'!A1:F2");
      const readSheet = async (spreadsheetId) => {
        const response = await fetch(API + encodeURIComponent(spreadsheetId) + '/values/' + range, {
          headers: { Authorization: 'Bearer ' + token }, cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        return { response, data };
      };
      let result = await readSheet(record.spreadsheetId);
      const errText = String(result.data && result.data.error && result.data.error.message || '');
      const missingFile = result.response.status === 404 || (/not found|does not exist|requested entity was not found/i.test(errText) && result.response.status !== 401 && result.response.status !== 403);
      const missingTab = result.response.status === 400 && /unable to parse range|sheet.*not found|no grid with id|unrecognized range/i.test(errText);
      if (!result.response.ok && (missingFile || missingTab) &&
          window.PC_SHEETS && typeof window.PC_SHEETS.ensureScheduleSpreadsheet === 'function') {
        // Repair a deleted spreadsheet or deleted "予定" tab and restore the dropdowns.
        const oldId = record.spreadsheetId;
        await window.PC_SHEETS.ensureScheduleSpreadsheet();
        record = recordForCurrentUser();
        if (record && record.spreadsheetId) {
          result = await readSheet(record.spreadsheetId);
          if (!result.response.ok && record.spreadsheetId === oldId && missingFile) {
            throw new Error('削除された予定表を自動再作成しましたが、新しい予定表を読み取れませんでした。もう一度確認してください。');
          }
        }
      }
      if (!result.response.ok) {
        const message = result.data && result.data.error && result.data.error.message;
        throw new Error(message || '予定表を読み取れませんでした（HTTP ' + result.response.status + '）。');
      }
      cachedRows = Array.isArray(result.data.values) ? result.data.values.slice(1) : [];
      lastReadAt = Date.now();
      return cachedRows;
    } finally { readInFlight = false; }
  }
  function announcementText(row) {
    const source = Array.isArray(row) ? row : [];
    const kind = String(source[1] || '').trim();
    const specialDetail = String(source[2] || '').trim();
    const rawItems = String(source[3] || '').trim();
    const additional = String(source[4] || '').trim();
    const cleanSentencePart = value => String(value || '')
      .replace(/^明日の持ち物(?:は)?[、,：:\s]*/,'')
      .replace(/[。．.!！?？]+$/,'')
      .replace(/です$/,'')
      .trim();
    const items = cleanSentencePart(rawItems);
    if (!items) return '明日の持ち物が入力されていません。';
    const sentences = ['明日の持ち物は、' + items + 'です。'];
    const detail = cleanSentencePart(specialDetail);
    if (detail) {
      sentences.push(kind === '特別'
        ? '明日の特別な予定は、' + detail + 'です。'
        : (/[。．.!！?？]$/.test(specialDetail) ? specialDetail : specialDetail + '。'));
    }
    const extra = String(additional || '').trim();
    const classCountAnnouncement = /(?:今日|本日)?(?:の)?授業は?\s*[1-6]時間授業|[1-6]時間授業です/.test(extra);
    if (extra && !classCountAnnouncement && extra !== items && !extra.includes(items) && !/^明日の持ち物/.test(extra)) {
      sentences.push(/[。．.!！?？]$/.test(extra) ? extra : extra + '。');
    }
    return sentences.join(' ');
  }
  window.PC_SCHEDULE_ANNOUNCEMENT_TEXT = announcementText;

  function targetTimeForClasses(classes, row) {
    if (classes === 5) return '14:25';
    if (classes === 6) return '15:15';
    if (!Number.isInteger(classes) || classes < 1 || classes > 4) return '';
    const raw = String(row && row[5] != null ? row[5] : '').trim();
    const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return '';
    return String(Number(match[1])).padStart(2, '0') + ':' + match[2];
  }
  window.PC_SCHEDULE_TARGET_TIME = targetTimeForClasses;


  // TTS Quest の無料・APIキー不要のWEB版VOICEVOX APIを使用。
  // speaker=2 は VOICEVOX:四国めたん（ノーマル）。
  const TTS_QUEST_API = 'https://api.tts.quest/v3/voicevox/synthesis';
  const TTS_FAST_API = 'https://deprecatedapis.tts.quest/v2/voicevox/audio/';
  const TTS_QUEST_SPEAKER = 2;
  const TTS_FAST_KEY_STORAGE = 'pc-voicevox-fast-api-key-v1';
  const TTS_FAST_KEY_DISABLED = '__DISABLED__';
  const TTS_FAST_TIMEOUT_MS = 8000;
  let fastApiRetryAfter = 0;
  const getFastApiKey = () => {
    try {
      const saved = localStorage.getItem(TTS_FAST_KEY_STORAGE);
      return saved && saved !== TTS_FAST_KEY_DISABLED ? String(saved).trim() : '';
    } catch (error) {
      return '';
    }
  };
  const voicevoxQuestPreparedAudio = new Map();
  const VOICEVOX_AUDIO_URL_CACHE_MS = 10 * 60 * 1000;
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
  async function requestFastVoicevoxBlob(text) {
    const key = getFastApiKey();
    if (!key) throw new Error('高速APIキーが設定されていません。');
    const phrase = String(text || '').trim();
    if (!phrase) throw new Error('読み上げる文章が空です。');
    if (phrase.length > 500) throw new Error('読み上げ文が長いため、高速APIは使わず別の方法を試します。');

    // The API documentation accepts the key and text in the POST body.
    // Voice/tuning options are query parameters on this endpoint.
    const options = new URLSearchParams({
      speaker: String(TTS_QUEST_SPEAKER),
      pitch: '0',
      intonationScale: '1',
      speed: '1'
    });
    const body = new URLSearchParams({ key, text: phrase });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TTS_FAST_TIMEOUT_MS);
    let response;
    let blob;
    try {
      response = await fetch(TTS_FAST_API + '?' + options.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      blob = await response.blob();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('高速APIが8秒以内に応答しませんでした。低速APIに切り替えます。');
      }
      throw new Error('高速APIに接続できません。低速APIに切り替えます。');
    } finally {
      clearTimeout(timeout);
    }

    const contentType = String(response.headers.get('content-type') || blob.type || '').toLowerCase();
    const preview = await blob.slice(0, 256).text().catch(() => '');
    if (/invalidApiKey/i.test(preview)) throw new Error('高速APIキーが無効です。低速APIに切り替えます。');
    if (/notEnoughPoints/i.test(preview)) throw new Error('高速APIのポイントが不足しています。低速APIに切り替えます。');
    if (!response.ok) throw new Error('高速APIがHTTP ' + response.status + 'を返しました。低速APIに切り替えます。');
    if (/failed/i.test(preview) && !contentType.startsWith('audio/')) {
      throw new Error('高速APIで音声合成に失敗しました。低速APIに切り替えます。');
    }

    const signature = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const header = signature.length >= 4 ? String.fromCharCode(...signature.slice(0, 4)) : '';
    const hasRiff = header === 'RIFF';
    const hasOgg = header === 'OggS';
    const hasId3 = signature.length >= 3 && String.fromCharCode(...signature.slice(0, 3)) === 'ID3';
    const hasMpegFrame = signature.length >= 2 && signature[0] === 0xff && (signature[1] & 0xe0) === 0xe0;
    if (!blob.size || (!contentType.startsWith('audio/') && !hasRiff && !hasOgg && !hasId3 && !hasMpegFrame)) {
      throw new Error('高速APIから音声データが返されませんでした。低速APIに切り替えます。');
    }
    return blob;
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
    const now = Date.now();
    const cached = voicevoxQuestPreparedAudio.get(phrase);
    if (cached && now - cached.createdAt < VOICEVOX_AUDIO_URL_CACHE_MS) return cached.promise;
    const entry = { createdAt: now, promise: null };
    entry.promise = requestVoicevoxQuestAudioUrl(phrase).catch(error => {
      if (voicevoxQuestPreparedAudio.get(phrase) === entry) voicevoxQuestPreparedAudio.delete(phrase);
      throw error;
    });
    voicevoxQuestPreparedAudio.set(phrase, entry);
    return entry.promise;
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
    const fastKey = getFastApiKey();
    if (fastKey && Date.now() >= fastApiRetryAfter) {
      let fastBlob = null;
      try {
        fastBlob = await requestFastVoicevoxBlob(text);
        fastApiRetryAfter = 0;
      } catch (error) {
        fastApiRetryAfter = Date.now() + 30000;
        console.warn('Fast VOICEVOX API unavailable; falling back to keyless API.', error);
        setStatus('高速APIが使えないため、APIキー不要の低速APIへ切り替えます。', true);
      }
      if (fastBlob) {
        try {
          await playBlob(fastBlob);
          setStatus('WEB版VOICEVOX 高速API（四国めたん）で発表しました。');
          return true;
        } catch (error) {
          // Do not request another paid-point audio just because browser playback was blocked.
          fastApiRetryAfter = Date.now() + 60000;
          console.warn('Fast VOICEVOX audio fetched but playback failed.', error);
          try {
            const metanFound = await speakWithBrowser(text);
            setStatus(metanFound
              ? '音声の再生制限があったため、四国めたんのブラウザー音声で発表しました。'
              : '音声の再生制限があったため、ブラウザー音声で発表しました。');
            return true;
          } catch (browserError) {
            setStatus('高速APIから音声を取得しましたが、再生できませんでした。ページを一度クリックしてから音声テストをお試しください。', true);
            console.error('Fast VOICEVOX playback and browser speech failed', error, browserError);
            return false;
          }
        }
      }
    }

    try {
      await speakWithVoicevoxQuest(text);
      setStatus('WEB版VOICEVOX API（低速・四国めたん）で発表しました。');
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
  async function checkAnnouncement(forceRefresh = false) {
    if (announcementCheckInFlight) return;
    announcementCheckInFlight = true;
    try {
      const auth = window.PC_AUTH;
      if (!auth || !auth.currentUser) {
        setStatus('Googleアカウントに接続すると、明日の持ち物を自動発表します。');
        return;
      }
      if (!tokenNow()) {
        setStatus('保存済みのGoogle接続を確認しています…');
        if (typeof window.__pcGoogleRequestAccess === 'function' &&
            Date.now() - lastTokenRefreshRequestAt > 30000) {
          lastTokenRefreshRequestAt = Date.now();
          window.__pcGoogleRequestAccess(true);
        }
        return;
      }
      const record = recordForCurrentUser();
      if (!record || !record.spreadsheetId) {
        setStatus('明日の持ち物シートを準備しています…');
        return;
      }
      const rows = await readRows(forceRefresh);
      const row = rows.find(value => (value || []).some(cell => String(cell == null ? '' : cell).trim()));
      if (!row) {
        setStatus('「予定」シートのA2で授業時間数、D2で明日の持ち物を入力してください。1〜4時間授業はF2に発表時刻を入力します。');
        return;
      }
      const classes = Number(String(row[0] == null ? '' : row[0]).replace(/[^0-9]/g, ''));
      if (!Number.isInteger(classes) || classes < 1 || classes > 6) {
        setStatus('「予定」シートのA2で、授業時間数を1〜6時間から選んでください。');
        return;
      }

      const target = targetTimeForClasses(classes, row);
      if (!target) {
        setStatus(classes + '時間授業：F2に発表時刻（例：13:20）を入力してください。');
        return;
      }
      const [hour, minute] = target.split(':').map(Number);
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const targetMinutes = hour * 60 + minute;
      const key = todayKey() + ':' + classes + ':' + target;
      const items = String(row[3] == null ? '' : row[3]).trim();
      if (!items) {
        setStatus(classes + '時間授業：自動発表予定は' + target + 'です。D2に明日の持ち物を入力すると発表します。');
        return;
      }

      if (nowMinutes < targetMinutes) {
        if (!getFastApiKey() && targetMinutes - nowMinutes <= 2) {
          prepareVoicevoxQuestAudio(announcementText(row, classes)).catch(error =>
            console.warn('TTS pre-generation failed; speech will fall back at announcement time', error));
        }
        setStatus('明日の持ち物を' + target + 'に音声で発表します。');
        return;
      }
      if (nowMinutes > targetMinutes + 20) {
        setStatus('明日の持ち物の自動発表時刻（' + target + '）を過ぎています。必要に応じて「持ち物テスト」で今すぐ発表できます。');
        return;
      }

      let announced = {};
      try { announced = JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || '{}'); } catch (error) {}
      if (announced[key]) {
        setStatus(classes + '時間授業の発表は本日分を実行済みです。');
        return;
      }
      const played = await speak(announcementText(row));
      if (played) {
        announced[key] = true;
        localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(announced));
      }
    } catch (error) {
      setStatus('明日の持ち物を読み取れませんでした。Google接続と予定表を確認してください。', true);
      console.error('Today schedule read failed', error);
    } finally {
      announcementCheckInFlight = false;
    }
  }
  function installStatus() {
    const host = document.getElementById('pcGoogleSheetsGroup') || document.getElementById('pcGoogleLoginGroup');
    if (!host || document.getElementById('pcScheduleAnnouncementStatus')) return;
    const box = document.createElement('div');
    box.id = 'pcScheduleAnnouncementStatus';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #15803d55;border-radius:10px;font-size:12px;line-height:1.65';
    const title = document.createElement('strong');
    title.textContent = '明日の持ち物の自動音声発表';
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:5px 0 0';
    const note = document.createElement('p');
    note.style.cssText = 'margin:5px 0 0;opacity:.75';
    note.textContent = '「予定」シートのA2で授業時間数、D2で明日の持ち物、必要ならE2で追加のお知らせを入力します。授業時間数は読み上げず、自動発表時刻の計算だけに使います（5時間=14:25、6時間=15:25）。ページを開いたままにしてください。';
    const apiHelp = document.createElement('p');
    apiHelp.style.cssText = 'margin:10px 0 0;font-size:12px;line-height:1.6';
    apiHelp.textContent = '高速APIキーを設定すると、音声発表時に高速APIを優先します。キー未設定・無効・ポイント不足・タイムアウト時は、APIキー不要の低速APIへ切り替えます。高速APIは利用ポイントを消費します。声は四国めたん（ノーマル）です。';

    const apiLink = document.createElement('a');
    apiLink.href = 'https://voicevox.su-shiki.com/su-shikiapis/';
    apiLink.target = '_blank';
    apiLink.rel = 'noopener noreferrer';
    apiLink.textContent = '高速APIの説明';
    apiLink.style.cssText = 'color:inherit;text-decoration:underline;text-underline-offset:3px';

    const keyLink = document.createElement('a');
    keyLink.href = 'https://su-shiki.com/api/';
    keyLink.target = '_blank';
    keyLink.rel = 'noopener noreferrer';
    keyLink.textContent = 'APIキーを取得';
    keyLink.style.cssText = 'color:inherit;text-decoration:underline;text-underline-offset:3px;margin-left:10px';

    const keyLabel = document.createElement('label');
    keyLabel.style.cssText = 'display:block;margin-top:10px;font-weight:600';
    keyLabel.textContent = '高速APIキー（このブラウザー内に保存）';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    keyInput.placeholder = '新しいAPIキーを貼り付け';
    keyInput.value = getFastApiKey();
    keyInput.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:8px 10px;border:1px solid var(--clk-border,rgba(127,127,127,.35));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px';

    const keyActions = document.createElement('div');
    keyActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:7px';
    const saveKeyButton = document.createElement('button');
    saveKeyButton.type = 'button';
    saveKeyButton.textContent = '高速APIキーを保存';
    saveKeyButton.style.cssText = 'padding:7px 10px;border:1px solid #15803d;border-radius:8px;background:#15803d;color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer';
    const clearKeyButton = document.createElement('button');
    clearKeyButton.type = 'button';
    clearKeyButton.textContent = '高速APIを無効化';
    clearKeyButton.style.cssText = 'padding:7px 10px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer';
    const keyStatus = document.createElement('p');
    keyStatus.style.cssText = 'margin:6px 0 0;font-size:11px;opacity:.75';
    keyStatus.setAttribute('aria-live', 'polite');

    const persistKey = () => {
      const value = String(keyInput.value || '').trim();
      try {
        if (value) {
          localStorage.setItem(TTS_FAST_KEY_STORAGE, value);
          fastApiRetryAfter = 0;
          keyStatus.textContent = '高速APIキーを保存しました。この端末の音声発表時に高速APIを優先します。';
        } else {
          localStorage.removeItem(TTS_FAST_KEY_STORAGE);
          fastApiRetryAfter = 0;
          keyStatus.textContent = '高速APIを無効にしました。次回はAPIキー不要の低速APIを使います。';
        }
      } catch (error) {
        keyStatus.textContent = 'ブラウザーに保存できませんでした。プライベートモードの設定などを確認してください。';
      }
    };
    saveKeyButton.addEventListener('click', persistKey);
    clearKeyButton.addEventListener('click', () => {
      keyInput.value = '';
      persistKey();
    });
    if (getFastApiKey()) {
      keyStatus.textContent = '高速APIキーが保存されています。音声発表時に高速APIを優先します。';
    } else {
      keyStatus.textContent = '高速APIキー未設定：APIキー不要の低速APIを使います。';
    }
    keyActions.append(saveKeyButton, clearKeyButton);
    keyLabel.appendChild(keyInput);
    box.append(title, statusNode, note, apiHelp, apiLink, document.createTextNode(' '), keyLink, keyLabel, keyActions, keyStatus);
    host.appendChild(box);
  }
  function start() {
    installStatus();
    if (timer) clearInterval(timer);
    checkAnnouncement();
    // Google Sheets APIはPush通知を直接送らないため、5秒ごとに最新の2行を確認する。
    timer = setInterval(() => checkAnnouncement(true), 5000);
  }
  window.addEventListener('pc-auth-changed', () => {
    installStatus();
    lastReadAt = 0;
    checkAnnouncement(true);
  });
  window.addEventListener('focus', () => {
    lastReadAt = 0;
    checkAnnouncement(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastReadAt = 0;
      checkAnnouncement(true);
    }
  });
  const observer = new MutationObserver(() => { if (!statusNode) installStatus(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();