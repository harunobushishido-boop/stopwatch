(() => {
  'use strict';

  const CONFIG_KEY = 'pc-google-sheets-config-v1';
  const TOKEN_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  let accessToken = '';
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let syncButton, statusNode, errorNode, urlInput, tabInput, connectButton, testButton, testOutput;

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
      const sharedToken = window.PC_AUTH && window.PC_AUTH.getAccessToken
        ? window.PC_AUTH.getAccessToken()
        : '';
      const sharedExpiry = window.PC_AUTH && window.PC_AUTH.getAccessTokenExpiresAt
        ? Number(window.PC_AUTH.getAccessTokenExpiresAt())
        : 0;
      if (!sharedToken || !sharedExpiry || Date.now() >= sharedExpiry) {
        throw new Error('先に「Googleアカウントでログインしてアクセスを許可」を押してください。ログイン時にスプレッドシートの権限もまとめて許可できます。');
      }
      accessToken = sharedToken;
      tokenExpiresAt = sharedExpiry;
      setStatus('Googleログイン時に許可されたアクセス権を利用できます。「ストップウォッチ履歴を同期」を押してください。');
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

  function escapeSheetName(name) {
    return "'" + String(name || '').replace(/'/g, "''") + "'";
  }

  function renderPackingTest(results) {
    if (!testOutput) return;
    testOutput.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = '読み取り結果';
    title.style.cssText = 'font-size:14px;margin:0 0 8px';
    testOutput.appendChild(title);

    const allRows = [];
    for (const result of results) {
      const section = document.createElement('section');
      section.style.cssText = 'margin:12px 0;padding:10px;border:1px solid var(--clk-border,rgba(127,127,127,.25));border-radius:10px';
      const heading = document.createElement('h4');
      heading.textContent = result.title;
      heading.style.cssText = 'font-size:13px;margin:0 0 8px';
      section.appendChild(heading);
      const rows = result.values || [];
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.textContent = 'このシートに表示できるデータはありません。';
        empty.style.cssText = 'font-size:12px;opacity:.7;margin:0';
        section.appendChild(empty);
      } else {
        const tableWrap = document.createElement('div');
        tableWrap.style.cssText = 'max-width:100%;overflow:auto';
        const table = document.createElement('table');
        table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px';
        rows.forEach((row, index) => {
          const tr = document.createElement('tr');
          (row || []).forEach((cell) => {
            const td = document.createElement(index === 0 ? 'th' : 'td');
            td.textContent = String(cell == null ? '' : cell);
            td.style.cssText = 'padding:7px 8px;border:1px solid var(--clk-border,rgba(127,127,127,.2));text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top';
            if (index === 0) td.style.fontWeight = '700';
            tr.appendChild(td);
          });
          if (tr.children.length) table.appendChild(tr);
          if (row && row.some((cell) => String(cell || '').trim())) allRows.push({ sheet: result.title, row });
        });
        tableWrap.appendChild(table);
        section.appendChild(tableWrap);
      }
      testOutput.appendChild(section);
    }

    const itemTerms = /持ち物|忘れ物|持参|持ってくる|準備物|必要なもの|教科書|ノート|筆箱|水筒|給食袋|体操着|上履き|提出物|用意するもの/i;
    const itemLines = [];
    for (const result of results) {
      const rows = result.values || [];
      if (!rows.length) continue;
      const headers = (rows[0] || []).map((v) => String(v || '').trim());
      const itemCols = headers.map((h, i) => itemTerms.test(h) ? i : -1).filter((i) => i >= 0);
      if (itemCols.length) {
        rows.slice(1).forEach((row) => itemCols.forEach((col) => {
          const value = String((row || [])[col] || '').trim();
          if (value && !itemLines.some((entry) => entry.text === value && entry.sheet === result.title)) {
            itemLines.push({ sheet: result.title, text: value });
          }
        }));
      }
    }
    const itemsSection = document.createElement('section');
    itemsSection.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--clk-border,rgba(127,127,127,.25));border-radius:10px';
    const itemsTitle = document.createElement('h3');
    itemsTitle.textContent = '持ち物候補';
    itemsTitle.style.cssText = 'font-size:14px;margin:0 0 8px';
    itemsSection.appendChild(itemsTitle);
    if (itemLines.length) {
      const list = document.createElement('ul');
      list.style.cssText = 'padding-left:20px;margin:0;line-height:1.8;font-size:13px';
      itemLines.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item.text + '（' + item.sheet + '）';
        list.appendChild(li);
      });
      itemsSection.appendChild(list);
    } else {
      const note = document.createElement('p');
      note.textContent = '持ち物用の列名を自動判定できませんでした。上の読み取り結果を表示しています。表の列名に「持ち物」「準備物」「持参」などがあると、持ち物候補を自動抽出できます。';
      note.style.cssText = 'font-size:12px;line-height:1.6;opacity:.75;margin:0';
      itemsSection.appendChild(note);
    }
    testOutput.appendChild(itemsSection);
    const count = document.createElement('p');
    count.textContent = '読み取り完了：' + results.length + 'シート / ' + allRows.length + '行。スプレッドシートは変更していません。';
    count.style.cssText = 'font-size:11px;opacity:.7;margin:10px 0 0';
    testOutput.appendChild(count);
  }

  async function runPackingTest() {
    setError('');
    const config = loadConfig();
    const id = spreadsheetId(config.spreadsheetUrl);
    const token = window.PC_AUTH && window.PC_AUTH.getAccessToken ? window.PC_AUTH.getAccessToken() : '';
    const expiry = window.PC_AUTH && window.PC_AUTH.getAccessTokenExpiresAt ? Number(window.PC_AUTH.getAccessTokenExpiresAt()) : 0;
    if (!id) {
      setError('先にスプレッドシートURLを保存してください。');
      return;
    }
    if (!token || !expiry || Date.now() >= expiry) {
      setError('先にGoogleアカウントでログインして、アクセスを許可してください。');
      return;
    }
    accessToken = token;
    tokenExpiresAt = expiry;
    testButton.disabled = true;
    testButton.textContent = '持ち物を読み取り中…';
    setStatus('スプレッドシートの情報を読み取っています。');
    if (testOutput) testOutput.replaceChildren();
    try {
      const meta = await apiRequest(SHEETS_API + encodeURIComponent(id) + '?fields=properties.title,sheets.properties.title');
      const sheets = (meta.sheets || []).map((sheet) => sheet.properties && sheet.properties.title).filter(Boolean);
      if (!sheets.length) throw new Error('読み取れるシートが見つかりませんでした。');
      const results = [];
      for (const title of sheets) {
        const range = escapeSheetName(title) + '!A1:Z200';
        const data = await apiRequest(SHEETS_API + encodeURIComponent(id) + '/values/' + encodeURIComponent(range));
        results.push({ title, values: (data.values || []).filter((row) => row.some((cell) => String(cell == null ? '' : cell).trim())) });
      }
      renderPackingTest(results);
      setStatus('テスト成功：スプレッドシートの内容を読み取り、表示しました。');
    } catch (error) {
      setError('持ち物テストに失敗しました。URL・共有権限・Google Sheets APIの設定を確認してください。詳細：' + (error.message || '不明なエラー'));
      setStatus('テストに失敗しました');
      console.error('Packing reminder test failed', error);
    } finally {
      testButton.disabled = false;
      testButton.textContent = '忘れ物防止テスト';
    }
  }

  const SCHEDULE_SHEET_STORAGE_KEY = 'pc-schedule-sheet-v1';
  let scheduleCreationPromise = null;

  function scheduleSheetRecord(email) {
    try {
      const all = JSON.parse(localStorage.getItem(SCHEDULE_SHEET_STORAGE_KEY) || '{}');
      return all[email] || null;
    } catch (error) { return null; }
  }

  function saveScheduleSheetRecord(email, record) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(SCHEDULE_SHEET_STORAGE_KEY) || '{}'); } catch (error) {}
    all[email] = record;
    localStorage.setItem(SCHEDULE_SHEET_STORAGE_KEY, JSON.stringify(all));
  }

  async function autoCreateScheduleSpreadsheet() {
    if (scheduleCreationPromise) return scheduleCreationPromise;
    scheduleCreationPromise = (async () => {
      const auth = window.PC_AUTH;
      const user = auth && auth.currentUser;
      const token = auth && auth.getAccessToken && auth.getAccessToken();
      const expiry = auth && auth.getAccessTokenExpiresAt && Number(auth.getAccessTokenExpiresAt());
      if (!user || !user.email || !token || !expiry || Date.now() >= expiry) return;
      const email = String(user.email).trim().toLowerCase();
      const existing = scheduleSheetRecord(email);
      if (existing && existing.spreadsheetId && existing.url) {
        renderScheduleSheetNotice(existing, '予定表スプレッドシートは作成済みです。');
        return existing;
      }

      renderScheduleSheetNotice(null, 'Googleログインを確認しました。予定表スプレッドシートを自動作成しています…');
      const response = await fetch(SHEETS_API.replace(/\\/$/, ''), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: { title: '6年4組便利タイマー 今日の予定表', locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
          sheets: [{ properties: { title: '予定' } }]
        }),
        cache: 'no-store'
      });
      let data = {};
      try { data = await response.json(); } catch (error) {}
      if (!response.ok || !data.spreadsheetId || !data.spreadsheetUrl) {
        throw new Error(data && data.error && data.error.message || '予定表スプレッドシートを作成できませんでした。Google Sheets APIとアクセス許可を確認してください。');
      }

      const record = {
        spreadsheetId: data.spreadsheetId,
        url: data.spreadsheetUrl,
        sheetName: '予定',
        createdAt: new Date().toISOString()
      };
      saveScheduleSheetRecord(email, record);

      const headerUrl = SHEETS_API + encodeURIComponent(record.spreadsheetId) +
        '/values/' + encodeURIComponent("'予定'!A1:F1") + '?valueInputOption=USER_ENTERED';
      const headerResponse = await fetch(headerUrl, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          values: [
            ['日付', '開始時刻', '終了時刻', '予定', '発表文', '有効']
          ]
        }),
        cache: 'no-store'
      });
      let headerData = {};
      try { headerData = await headerResponse.json(); } catch (error) {}
      if (!headerResponse.ok) {
        renderScheduleSheetNotice(record, '予定表は作成されましたが、見出しの設定に失敗しました。シートを開いて確認してください。');
        throw new Error(headerData && headerData.error && headerData.error.message || '予定表の列見出しを書き込めませんでした。');
      }

      renderScheduleSheetNotice(record, '予定表スプレッドシートを自動作成しました。');
      return record;
    })().catch(error => {
      renderScheduleSheetNotice(null, '予定表の自動作成に失敗しました。Googleのアクセス許可を確認して再ログインしてください。');
      if (errorNode) setError(error.message || '予定表の作成に失敗しました。');
      console.error('Automatic schedule spreadsheet creation failed', error);
      return null;
    }).finally(() => { scheduleCreationPromise = null; });
    return scheduleCreationPromise;
  }

  function renderScheduleSheetNotice(record, message) {
    let node = document.getElementById('pcScheduleSheetNotice');
    if (!node) {
      const host = document.getElementById('pcGoogleSheetsGroup') || document.getElementById('pcGoogleLoginGroup');
      if (!host) return;
      node = document.createElement('div');
      node.id = 'pcScheduleSheetNotice';
      node.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #15803d55;border-radius:10px;font-size:12px;line-height:1.6;overflow-wrap:anywhere';
      host.appendChild(node);
    }
    node.replaceChildren();
    const text = document.createElement('p');
    text.style.margin = '0';
    text.textContent = message;
    node.appendChild(text);
    if (record && record.url) {
      const link = document.createElement('a');
      link.href = record.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '予定表スプレッドシートを開く';
      link.style.cssText = 'display:inline-block;margin-top:6px;color:inherit;text-decoration:underline;text-underline-offset:3px';
      node.appendChild(link);
      const useButton = makeButton('この予定表を連携先に設定', true);
      useButton.style.marginTop = '8px';
      useButton.addEventListener('click', () => {
        if (urlInput) urlInput.value = record.url;
        if (tabInput) tabInput.value = '予定';
        if (typeof storeConfig === 'function' && storeConfig()) {
          setStatus('自動作成した予定表を連携先に設定しました。');
        }
      });
      node.appendChild(useButton);
    }
  }

  window.addEventListener('pc-auth-changed', event => {
    if (event && event.detail && event.detail.signedIn) {
      // Wait until the OAuth access token is available; the ID-token-only state is insufficient.
      const auth = window.PC_AUTH;
      if (auth && auth.getAccessToken && auth.getAccessToken()) autoCreateScheduleSpreadsheet();
    }
  });

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
    note.textContent = 'スプレッドシートのURLを保存後、Googleアカウント欄からログインしてください。ログイン時に許可したアクセス権をこの連携で利用します。';
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
    testButton = makeButton('忘れ物防止テスト', true);
    actions.append(saveButton, connectButton, syncButton, testButton);
    testOutput = document.createElement('div');
    testOutput.id = 'pcPackingTestOutput';
    testOutput.style.cssText = 'margin-top:12px;min-width:0';
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
    group.append(title, note, fields, statusNode, errorNode, actions, testOutput, guide, foot);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);

    saveButton.addEventListener('click', storeConfig);
    connectButton.addEventListener('click', connect);
    syncButton.addEventListener('click', syncHistory);
    testButton.addEventListener('click', runPackingTest);
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