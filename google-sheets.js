(() => {
  'use strict';

  const CONFIG_KEY = 'pc-google-sheets-config-v1';
  const TOKEN_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  let accessToken = '';
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let syncButton, statusNode, errorNode, urlInput, tabInput, connectButton;

  const loadConfig = () => {
    try {
      const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return { clientId: configuredClientId(), spreadsheetUrl: String(value.spreadsheetUrl || ''), sheetName: String(value.sheetName || '記録') };
    } catch (error) {
      return { clientId: configuredClientId(), spreadsheetUrl: '', sheetName: '記録' };
    }
  };

  function configuredClientId() {
    return String(window.PC_GOOGLE_LOGIN_CONFIG && window.PC_GOOGLE_LOGIN_CONFIG.clientId || '').trim();
  }

  const setStatus = (message) => { if (statusNode) statusNode.textContent = message; };
  const setError = (message) => {
    if (!errorNode) return;
    errorNode.textContent = message || '';
    errorNode.hidden = !message;
  };

  const makeButton = (text, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = 'padding:9px 13px;border:1px solid ' + (primary ? '#15803d' : 'currentColor') + ';border-radius:10px;background:' + (primary ? '#15803d' : 'transparent') + ';color:' + (primary ? '#fff' : 'inherit') + ';font:inherit;font-size:13px;font-weight:600;cursor:pointer';
    return b;
  };

  const makeInput = (labelText, placeholder, value) => {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12px;min-width:0;flex:1 1 220px';
    const label = document.createElement('span');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #0000002b;border-radius:9px;background:var(--clk-bg,#fff);color:inherit;font:inherit;font-size:12px';
    wrap.append(label, input);
    return { wrap, input };
  };

  function spreadsheetId(value) {
    const text = String(value || '').trim();
    if (/^[\w-]{20,}$/.test(text)) return text;
    const match = text.match(/\/spreadsheets\/d\/([\w-]+)/);
    return match ? match[1] : '';
  }

  function readFormConfig() {
    return {
      clientId: configuredClientId(),
      spreadsheetUrl: String(urlInput && urlInput.value || '').trim(),
      sheetName: String(tabInput && tabInput.value || '').trim() || '記録'
    };
  }

  function storeConfig() {
    const config = readFormConfig();
    if (!config.clientId.endsWith('.apps.googleusercontent.com')) {
      setError('Googleログイン用クライアントIDが未設定です。google-login-config.js の設定を確認してください。');
      return false;
    }
    if (!spreadsheetId(config.spreadsheetUrl)) {
      setError('GoogleスプレッドシートのURLまたはIDが正しくありません。');
      return false;
    }
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }
    catch (error) { setError('設定をこのブラウザーに保存できませんでした。'); return false; }
    setError('');
    setStatus('連携設定を保存しました。次にGoogleアカウントのアクセス許可を行ってください。');
    tokenClient = null;
    accessToken = '';
    syncButton.disabled = true;
    return true;
  }

  function loadGoogleIdentity() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (window.__pcGoogleIdentityPromise) return window.__pcGoogleIdentityPromise;
    window.__pcGoogleIdentityPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) resolve();
        else reject(new Error('Google Identity Servicesを初期化できませんでした。'));
      };
      script.onerror = () => reject(new Error('Googleの認証ライブラリを読み込めませんでした。ネットワークを確認してください。'));
      document.head.appendChild(script);
    });
    return window.__pcGoogleIdentityPromise;
  }

  async function apiRequest(url, options = {}) {
    if (!accessToken || Date.now() >= tokenExpiresAt) {
      accessToken = '';
      throw new Error('Googleのアクセス許可が期限切れです。「Googleスプレッドシートに接続」を押し直してください。');
    }
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + accessToken }, options.body ? { 'Content-Type': 'application/json' } : {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    let data = null;
    try { data = await response.json(); } catch (error) {}
    if (!response.ok) {
      if (response.status === 401) accessToken = '';
      throw new Error(data && data.error && data.error.message || ('Google Sheets APIエラー（HTTP ' + response.status + '）'));
    }
    return data || {};
  }

  function rangeUrl(id, range, action) {
    const base = SHEETS_API + encodeURIComponent(id) + '/values/' + encodeURIComponent(range);
    return action ? base + ':' + action + '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS' : base;
  }

  async function appendValues(id, range, values) {
    return apiRequest(rangeUrl(id, range, 'append'), { method: 'POST', body: { values } });
  }

  function durationLabel(ms) {
    const n = Math.max(0, Math.floor(Number(ms) || 0));
    return String(Math.floor(n / 60000)).padStart(2, '0') + ':' +
      String(Math.floor(n / 1000) % 60).padStart(2, '0') + '.' +
      String(Math.floor(n / 10) % 100).padStart(2, '0');
  }

  async function connect() {
    setError('');
    const config = readFormConfig();
    if (!config.clientId.endsWith('.apps.googleusercontent.com') || !spreadsheetId(config.spreadsheetUrl)) {
      setError('Googleログイン用クライアントIDの設定とスプレッドシートURLを確認し、「設定を保存」を押してください。');
      return;
    }
    if (JSON.stringify(config) !== JSON.stringify(loadConfig())) {
      setError('入力内容が保存前です。「設定を保存」を押してから接続してください。');
      return;
    }
    connectButton.disabled = true;
    connectButton.textContent = 'Googleに接続中…';
    try {
      await loadGoogleIdentity();
      await new Promise((resolve, reject) => {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: TOKEN_SCOPE,
          callback: (response) => {
            if (response && response.access_token) {
              accessToken = response.access_token;
              tokenExpiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600) - 60) * 1000;
              resolve();
            } else {
              reject(new Error(response && response.error_description || response && response.error || 'Googleからアクセス許可を取得できませんでした。'));
            }
          },
          error_callback: (error) => reject(new Error(error && error.message || 'Googleの認証画面を開けませんでした。'))
        });
        tokenClient.requestAccessToken({ prompt: 'consent' });
      });
      setStatus('Googleスプレッドシートへのアクセスが許可されました。次に「ストップウォッチ履歴を同期」を押してください。');
      syncButton.disabled = false;
    } catch (error) {
      setError(error.message || 'Googleに接続できませんでした。OAuthクライアントIDと承認済みドメインを確認してください。');
      setStatus('未接続');
      console.error('Google Sheets authorization failed', error);
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = 'Googleスプレッドシートに接続';
    }
  }

  async function syncHistory() {
    setError('');
    if (!accessToken || Date.now() >= tokenExpiresAt) {
      accessToken = '';
      syncButton.disabled = true;
      setError('先に「Googleスプレッドシートに接続」を押してアクセスを許可してください。');
      return;
    }
    const config = loadConfig();
    const id = spreadsheetId(config.spreadsheetUrl);
    if (!id) { setError('スプレッドシートURLが保存されていません。'); return; }
    const history = window.PC_STOPWATCH_HISTORY && window.PC_STOPWATCH_HISTORY.getAll
      ? await window.PC_STOPWATCH_HISTORY.getAll()
      : [];
    if (!history.length) { setStatus('送信できるストップウォッチ履歴がまだありません。'); return; }

    syncButton.disabled = true;
    syncButton.textContent = '履歴を同期中…';
    try {
      const tabRange = "'" + config.sheetName.replace(/'/g, "''") + "'";
      const first = await apiRequest(SHEETS_API + encodeURIComponent(id) + '/values/' + encodeURIComponent(tabRange + '!A1:F1'));
      if (!Array.isArray(first.values) || !first.values.length || !first.values[0].some((cell) => String(cell || '').trim())) {
        await appendValues(id, tabRange + '!A:F', [[
          '記録日時（端末時刻）', '記録ID', '合計時間（ms）', '合計時間', 'ラップ数', 'ラップ経過時間（ms・JSON）'
        ]]);
      }

      const column = await apiRequest(SHEETS_API + encodeURIComponent(id) + '/values/' + encodeURIComponent(tabRange + '!B:B'));
      const existingIds = new Set((column.values || []).map((row) => String(row[0] || '')).filter(Boolean));
      const uniqueHistory = history.filter((record) => record && record.id && !existingIds.has(String(record.id)));
      if (!uniqueHistory.length) {
        setStatus('このスプレッドシートには、現在のストップウォッチ履歴は同期済みです。');
        return;
      }

      const rows = uniqueHistory.map((record) => [
        new Date(record.at).toLocaleString('ja-JP', { hour12: false }),
        String(record.id),
        Math.round(Number(record.elapsed) || 0),
        durationLabel(record.elapsed),
        Array.isArray(record.laps) ? record.laps.length : 0,
        JSON.stringify(Array.isArray(record.laps) ? record.laps : [])
      ]);
      await appendValues(id, tabRange + '!A:F', rows);
      setStatus(uniqueHistory.length + '件のストップウォッチ履歴をスプレッドシートに追加しました。');
    } catch (error) {
      setError('同期できませんでした。シート名が「' + config.sheetName + '」か、編集権限とGoogle Sheets APIの設定を確認してください。詳細：' + (error.message || '不明なエラー'));
      console.error('Google Sheets history sync failed', error);
    } finally {
      syncButton.disabled = !accessToken;
      syncButton.textContent = 'ストップウォッチ履歴を同期';
    }
  }

  function installUI() {
    const panes = [...document.querySelectorAll('.clk-panel__pane')];
    const pane = panes.find((item) => item.querySelector('[aria-label="フォントの太さ"]')) || panes[5];
    if (!pane || document.getElementById('pcGoogleSheetsGroup')) return;

    const config = loadConfig();
    const group = document.createElement('section');
    group.id = 'pcGoogleSheetsGroup';
    group.className = 'clk-group';
    group.style.cssText = 'padding:14px;border:1px solid var(--clk-fg,#1e40af);border-radius:14px;margin-top:12px';
    const title = document.createElement('div');
    title.className = 'clk-group__label';
    title.textContent = 'Googleスプレッドシート連携';
    const note = document.createElement('p');
    note.className = 'clk-group__hint';
    note.textContent = 'Googleログイン用のクライアントIDを自動で使います。スプレッドシートのURLを入力し、Googleアカウントでアクセスを許可してください。';
    const fields = document.createElement('div');
    fields.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:10px';
    const sheet = makeInput('スプレッドシートURLまたはID', 'https://docs.google.com/spreadsheets/d/...', config.spreadsheetUrl);
    const tab = makeInput('シート名', '記録', config.sheetName);
    urlInput = sheet.input;
    tabInput = tab.input;
    fields.append(sheet.wrap, tab.wrap);
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:9px 0;font-size:12.5px;line-height:1.5';
    statusNode.textContent = '未接続';
    errorNode = document.createElement('p');
    errorNode.style.cssText = 'color:#b91c1c;margin:6px 0;font-size:12px;line-height:1.5';
    errorNode.hidden = true;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px';
    const saveButton = makeButton('設定を保存');
    connectButton = makeButton('Googleスプレッドシートに接続', true);
    syncButton = makeButton('ストップウォッチ履歴を同期');
    syncButton.disabled = true;
    actions.append(saveButton, connectButton, syncButton);
    const guide = document.createElement('a');
    guide.href = 'https://github.com/harunobushishido-boop/stopwatch/blob/main/GOOGLE_LOGIN_SETUP.md';
    guide.target = '_blank';
    guide.rel = 'noopener noreferrer';
    guide.textContent = '連携の初期設定ガイド';
    guide.style.cssText = 'display:inline-block;margin-top:10px;font-size:12px;color:inherit;text-decoration:underline;text-underline-offset:3px';
    const foot = document.createElement('p');
    foot.className = 'clk-group__hint';
    foot.style.marginTop = '10px';
    foot.textContent = '選択したスプレッドシートを読み、未登録の記録を末尾に追加します。既存の行は上書き・削除しません。アクセストークンはページを閉じるまでメモリ内にだけ保持します。';
    group.append(title, note, fields, statusNode, errorNode, actions, guide, foot);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);

    saveButton.addEventListener('click', storeConfig);
    connectButton.addEventListener('click', connect);
    syncButton.addEventListener('click', syncHistory);
    if (config.clientId && spreadsheetId(config.spreadsheetUrl)) setStatus('設定を読み込みました。接続してから同期してください。');
    window.PC_SHEETS = {
      connect,
      syncHistory,
      get connected() { return Boolean(accessToken && Date.now() < tokenExpiresAt); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUI, { once: true });
  else installUI();
})();