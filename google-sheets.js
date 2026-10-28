(() => {
  'use strict';

  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  window.PC_SHEETS_BUILD = 'v116';
  let accessToken = '';
  let tokenExpiresAt = 0;
  let statusNode, errorNode, connectButton, testButton, testOutput, manualSaveButton, manualAnnounceButton;

  function activeScheduleRecord() {
    const email = String(window.PC_AUTH && window.PC_AUTH.currentUser && window.PC_AUTH.currentUser.email || '').trim().toLowerCase();
    return email ? scheduleSheetRecord(email) : null;
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

  async function apiRequest(url, options = {}) {
    if (!accessToken || Date.now() >= tokenExpiresAt) {
      accessToken = '';
      throw new Error('Googleのアクセス許可が期限切れです。Googleログインをやり直してください。');
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

  async function scheduleApiJson(url, token, options = {}) {
    const bearer = String(token || accessToken || '').trim();
    if (!bearer) throw new Error('Googleのアクセス許可がありません。Googleアカウントでログインしてください。');
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + bearer }, options.body ? { 'Content-Type': 'application/json' } : {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    let data = null;
    try { data = await response.json(); } catch (error) {}
    if (!response.ok) {
      const message = data && data.error && data.error.message;
      const apiError = (description) => { const error = new Error(description); error.status = response.status; return error; };
      if (response.status === 401) {
        throw apiError('Googleのログイン許可の有効期限が切れています。スプレッドシート設定タブからGoogleアカウントを再接続してください。' + (message ? ' 詳細: ' + message : ''));
      }
      if (response.status === 403) {
        throw apiError('Google APIからアクセスを拒否されました。リンク共有が編集可でも、接続中のGoogleアカウント・Sheets APIの有効化・OAuthの許可範囲を確認してください。' + (message ? ' 詳細: ' + message : ''));
      }
      if (response.status === 404) {
        throw apiError('スプレッドシートが見つかりません。URLのIDが正しいか、接続しているGoogleアカウントから開けるか確認してください。' + (message ? ' 詳細: ' + message : ''));
      }
      throw apiError(message || ('Google Sheets APIエラー（HTTP ' + response.status + '）'));
    }
    return data || {};
  }

  window.PC_SHEETS_API_JSON = scheduleApiJson;

  async function connect() {
    setError('');
    connectButton.disabled = true;
    connectButton.textContent = '接続を確認中…';
    try {
      const auth = window.PC_AUTH;
      const token = auth && auth.getAccessToken && auth.getAccessToken();
      const expiry = auth && auth.getAccessTokenExpiresAt && Number(auth.getAccessTokenExpiresAt());
      if (!token || !expiry || Date.now() >= expiry) {
        setError('');
        setStatus('Googleの保存済みアクセス許可を確認しています。自動接続できない場合はGoogleアカウント欄の「再接続」を押してください。');
        const requested = typeof window.__pcGoogleRequestAccess === 'function' && window.__pcGoogleRequestAccess(true);
        if (!requested && !(typeof window.__pcGoogleAccessIsPending === 'function' && window.__pcGoogleAccessIsPending())) setError('Google接続を開始できませんでした。Googleアカウント欄の「Googleへのアクセスを再接続」を押してください。');
        return;
      }
      accessToken = token;
      tokenExpiresAt = expiry;
      const record = await autoCreateScheduleSpreadsheet();
      try { await readAndCacheScheduleRows(record, token); } catch (readError) { console.warn('Schedule values could not be cached for export.', readError); }
      setStatus('明日の持ち物シートに接続しました。');
      renderScheduleSheetNotice(record, '明日の持ち物シートに接続しました。');
    } catch (error) {
      setError(error.message || 'Googleスプレッドシートに接続できませんでした。');
      setStatus('未接続');
      console.error('Schedule spreadsheet connection failed', error);
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = '明日の持ち物シートを確認';
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
    let record = activeScheduleRecord();
    const token = window.PC_AUTH && window.PC_AUTH.getAccessToken ? window.PC_AUTH.getAccessToken() : '';
    const expiry = window.PC_AUTH && window.PC_AUTH.getAccessTokenExpiresAt ? Number(window.PC_AUTH.getAccessTokenExpiresAt()) : 0;
    if (!token || !expiry || Date.now() >= expiry) {
      setError('');
      setStatus('Google接続を確認しています。接続後に、もう一度「持ち物テスト」を押してください。');
      const requested = typeof window.__pcGoogleRequestAccess === 'function' && window.__pcGoogleRequestAccess(true);
      if (!requested && !(typeof window.__pcGoogleAccessIsPending === 'function' && window.__pcGoogleAccessIsPending())) setError('Google接続を開始できませんでした。Googleアカウント欄の「Googleへのアクセスを再接続」を押してください。');
      return;
    }

    accessToken = token;
    tokenExpiresAt = expiry;
    try {
      record = await autoCreateScheduleSpreadsheet();
    } catch (error) {
      setError('明日の持ち物シートを自動作成できませんでした。' + (error.message || '不明なエラー'));
      setStatus('自動作成に失敗しました。下の入力欄から手動保存・音声発表できます。接続用テンプレートも書き出せます。');
      if (exportStatusNode) exportStatusNode.textContent = '自動作成に失敗しました。入力欄から手動保存・音声発表できます。CSV・Excelボタンは接続用テンプレートです。';
      console.error('Schedule spreadsheet auto-create failed', error);
      return;
    }
    const id = record && record.spreadsheetId;
    if (!id) {
      setError('明日の持ち物シートのIDを取得できませんでした。Google接続を確認してください。');
      return;
    }
    testButton.disabled = true;
    testButton.textContent = '明日の持ち物を読み取り中…';
    setStatus('明日の持ち物を読み取っています。');
    if (testOutput) testOutput.replaceChildren();

    try {
      await ensureScheduleSpreadsheetLayout(record, token);
      const range = escapeSheetName('予定') + '!A1:F2';
      const data = await apiRequest(SHEETS_API + encodeURIComponent(id) + '/values/' + encodeURIComponent(range));
      const values = Array.isArray(data.values) ? data.values : [];
      cacheScheduleRows([SCHEDULE_EXPORT_HEADERS.slice(), Array.isArray(values[1]) ? values[1] : ['', '', '', '', '', '']]);
      fillManualFields(getCachedScheduleRows());
      const visibleRows = values.filter(row => (row || []).some(cell => String(cell == null ? '' : cell).trim()));
      renderPackingTest([{ title: '明日の持ち物', values: visibleRows }]);

      const row = values[1] || [];
      if (!row.some(cell => String(cell == null ? '' : cell).trim())) {
        throw new Error('「予定」シートのA2で授業時間数、D2で明日の持ち物を入力してください。');
      }
      const items = String(row[3] == null ? '' : row[3]).trim();
      if (!items) throw new Error('「予定」シートのD2に明日の持ち物を入力してください。');
      const classes = Number(String(row[0] == null ? '' : row[0]).replace(/[^0-9]/g, ''));
      if (!Number.isInteger(classes) || classes < 1 || classes > 6) {
        throw new Error('「予定」シートのA2で、授業時間数を1〜6時間から選んでください。');
      }

      const buildText = window.PC_SCHEDULE_ANNOUNCEMENT_TEXT;
      const speak = window.PC_SCHEDULE_SPEAK;
      if (typeof buildText !== 'function' || typeof speak !== 'function') {
        throw new Error('音声発表機能がまだ準備できていません。ページを再読み込みして再試行してください。');
      }
      const announcement = buildText(row, classes);
      setStatus('明日の持ち物を音声で発表しています…');
      const played = await speak(announcement);
      if (!played) {
        throw new Error('予定は読み取れましたが、音声を再生できませんでした。ブラウザーの音量とネット接続を確認してください。');
      }
      setStatus('成功：明日の持ち物を音声で発表しました。');
    } catch (error) {
      setError('明日の持ち物の読み取り・発表に失敗しました。' + (error.message || '不明なエラー'));
      setStatus('テストに失敗しました');
      console.error('Today schedule announcement test failed', error);
    } finally {
      testButton.disabled = false;
      testButton.textContent = '持ち物テスト（明日の持ち物を発表）';
    }
  }

  const SCHEDULE_SPREADSHEET_TITLE = '6年4組便利タイマー - 明日の持ち物';

  const SCHEDULE_SHEET_STORAGE_KEY = 'pc-schedule-sheet-v1';
  let scheduleCreationPromise = null;

  const sessionScheduleRecords = Object.create(null);

  function scheduleSheetRecord(email) {
    try {
      const all = JSON.parse(localStorage.getItem(SCHEDULE_SHEET_STORAGE_KEY) || '{}');
      if (all[email]) return all[email];
    } catch (error) {}
    return sessionScheduleRecords[email] || null;
  }

  function saveScheduleSheetRecord(email, record) {
    sessionScheduleRecords[email] = record;
    let all = {};
    try { all = JSON.parse(localStorage.getItem(SCHEDULE_SHEET_STORAGE_KEY) || '{}'); } catch (error) {}
    all[email] = record;
    try {
      localStorage.setItem(SCHEDULE_SHEET_STORAGE_KEY, JSON.stringify(all));
      return true;
    } catch (error) {
      console.warn('Schedule sheet ID could not be cached in localStorage; it remains available for this tab.', error);
      return false;
    }
  }

  function currentTokyoDateKey() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function normalizeScheduleDate(value) {
    const raw = String(value == null ? '' : value).trim();
    let match = raw.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/);
    if (!match) match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (!match) return '';
    return match[1] + '-' + String(Number(match[2])).padStart(2, '0') + '-' + String(Number(match[3])).padStart(2, '0');
  }

  function rowValue(row, index) {
    return index >= 0 && row && row[index] != null ? String(row[index]) : '';
  }

  async function ensureScheduleSpreadsheetLayout(record, token) {
    const base = SHEETS_API + encodeURIComponent(record.spreadsheetId);
    const requestJson = (url, options = {}) => window.PC_SHEETS_API_JSON(url, token, options);
    const readMeta = () => requestJson(base + '?fields=sheets(properties(sheetId,title),tables(tableId,name,range))');
    let meta = await readMeta();
    let titles = new Set((meta.sheets || []).map(sheet => sheet.properties && sheet.properties.title).filter(Boolean));

    // 新しく作るのは「予定」シートだけ。既存の「記録」シートは削除も変更もしない。
    if (!titles.has('予定')) {
      await requestJson(base + ':batchUpdate', {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title: '予定' } } }] }
      });
      meta = await readMeta();
      titles = new Set((meta.sheets || []).map(sheet => sheet.properties && sheet.properties.title).filter(Boolean));
    }

    const scheduleSheet = (meta.sheets || []).find(sheet => sheet.properties && sheet.properties.title === '予定');
    const sheetId = scheduleSheet && scheduleSheet.properties && scheduleSheet.properties.sheetId;
    if (!Number.isInteger(sheetId)) throw new Error('明日の持ち物シートの「予定」タブを確認できませんでした。');

    const oldData = await requestJson(base + '/values/' + encodeURIComponent("'予定'!A1:Z200"));
    const oldValues = Array.isArray(oldData.values) ? oldData.values : [];
    const oldHeader = (oldValues[0] || []).map(value => String(value == null ? '' : value).trim());
    const newHeader = ['授業時間数', '区分（通常/特別）', '特別の記入', '明日の持ち物', '追加のお知らせ', '1〜4時間授業の発表時刻（HH:mm）'];
    const today = currentTokyoDateKey();
    let todayRow = ['', '', '', '', '', ''];

    const findHeader = (tests, fallback) => {
      const index = oldHeader.findIndex(value => tests.some(test => test(value)));
      return index >= 0 ? index : fallback;
    };
    const isDateColumn = value => value === '日付' || value === '実施日' || value === '予定日';
    const dateColumn = oldHeader.findIndex(isDateColumn);
    const classCol = findHeader([value => value === '授業時間数'], dateColumn >= 0 ? 1 : 0);
    const kindCol = findHeader([value => value === '区分（通常/特別）' || value === '区分' || value === '特別'], dateColumn >= 0 ? 2 : 1);
    const specialCol = findHeader([value => value === '特別の記入'], dateColumn >= 0 ? 3 : 2);
    const planCol = findHeader([value => value === '明日の持ち物' || value === '今日の予定・持ち物' || value === '予定' || value === '持ち物'], dateColumn >= 0 ? 4 : 3);
    const textCol = findHeader([value => value === '追加のお知らせ' || value === '発表文'], dateColumn >= 0 ? 5 : 4);
    const timeCol = findHeader([value => value === '1〜4時間授業の発表時刻（HH:mm）' || value === '発表時刻' || value === '自動発表時刻'], dateColumn >= 0 ? 6 : 5);

    if (dateColumn >= 0) {
      // 以前の日付別シートは「今日」に一致する行だけを引き継ぐ。
      const todayOldRow = oldValues.slice(1).find(row => normalizeScheduleDate(row[dateColumn]) === today);
      if (todayOldRow) {
        todayRow = [
          rowValue(todayOldRow, classCol), rowValue(todayOldRow, kindCol), rowValue(todayOldRow, specialCol),
          rowValue(todayOldRow, planCol), rowValue(todayOldRow, textCol), rowValue(todayOldRow, timeCol)
        ];
      }
    } else if (oldHeader.length) {
      const existingRow = oldValues[1] || [];
      todayRow = [
        rowValue(existingRow, classCol), rowValue(existingRow, kindCol), rowValue(existingRow, specialCol),
        rowValue(existingRow, planCol), rowValue(existingRow, textCol), rowValue(existingRow, timeCol)
      ];
    }

    const cell = value => ({ userEnteredValue: { stringValue: String(value == null ? '' : value) } });
    const listRule = values => ({
      condition: { type: 'ONE_OF_LIST', values: values.map(value => ({ userEnteredValue: value })) }
    });
    const columnProperties = [
      { columnIndex: 0, columnName: newHeader[0], columnType: 'DROPDOWN', dataValidationRule: listRule(['1', '2', '3', '4', '5', '6']) },
      { columnIndex: 1, columnName: newHeader[1], columnType: 'DROPDOWN', dataValidationRule: listRule(['通常', '特別']) },
      { columnIndex: 2, columnName: newHeader[2], columnType: 'TEXT' },
      { columnIndex: 3, columnName: newHeader[3], columnType: 'TEXT' },
      { columnIndex: 4, columnName: newHeader[4], columnType: 'TEXT' },
      { columnIndex: 5, columnName: newHeader[5], columnType: 'TEXT' }
    ];

    // まずセルを「見出し1行＋今日の入力1行」に揃える。
    // 古い日付列・過去の発表内容はこの「予定」シートから除き、別シートは触らない。
    const requests = [
      {
        updateCells: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 6 },
          rows: [{ values: newHeader.map(cell) }, { values: todayRow.map(cell) }],
          fields: 'userEnteredValue'
        }
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 26 },
          cell: { dataValidation: null },
          fields: 'dataValidation'
        }
      },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 1 },
          rule: {
            condition: { type: 'ONE_OF_LIST', values: ['1', '2', '3', '4', '5', '6'].map(value => ({ userEnteredValue: value })) },
            strict: true,
            showCustomUi: true
          }
        }
      },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 1, endColumnIndex: 2 },
          rule: {
            condition: { type: 'ONE_OF_LIST', values: ['通常', '特別'].map(value => ({ userEnteredValue: value })) },
            strict: true,
            showCustomUi: true
          }
        }
      }
    ];

    // 先に予定データと通常のセル設定を保存する。テーブルの失敗で予定の保存まで失敗扱いにしない。
    await requestJson(base + ':batchUpdate', { method: 'POST', body: { requests } });

    // Google Sheets の Table DROPDOWN はチップ型プルダウンを作る。
    const existingTables = Array.isArray(scheduleSheet.tables) ? scheduleSheet.tables : [];
    const overlappingTable = existingTables.find(table => {
      const range = table.range || {};
      return Number(range.startRowIndex || 0) < 2 &&
        Number(range.endRowIndex || 0) > 0 &&
        Number(range.startColumnIndex || 0) < 6 &&
        Number(range.endColumnIndex || 0) > 0;
    });
    const tableRequest = !overlappingTable
      ? { addTable: { table: {
          name: 'TodaySchedule',
          range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 },
          columnProperties
        } } }
      : { updateTable: { table: { tableId: overlappingTable.tableId, range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 }, columnProperties }, fields: 'range,columnProperties' } };
    try {
      await requestJson(base + ':batchUpdate', { method: 'POST', body: { requests: [tableRequest] } });
      return true;
    } catch (tableError) {
      console.warn('Chip-dropdown table setup failed; applying standard dropdown validation instead.', tableError);
      const validation = values => ({
        condition: { type: 'ONE_OF_LIST', values: values.map(value => ({ userEnteredValue: value })) },
        strict: true,
        showCustomUi: true
      });
      try {
        await requestJson(base + ':batchUpdate', { method: 'POST', body: { requests: [
          { setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 1 },
            rule: validation(['1', '2', '3', '4', '5', '6'])
          } },
          { setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 1, endColumnIndex: 2 },
            rule: validation(['通常', '特別'])
          } }
        ] } });
      } catch (fallbackError) {
        console.warn('Standard dropdown fallback failed.', fallbackError);
      }
      return false;
    }
  }


async function autoCreateScheduleSpreadsheet() {
    if (scheduleCreationPromise) return scheduleCreationPromise;
    scheduleCreationPromise = (async () => {
      const auth = window.PC_AUTH;
      const email = String(auth && auth.currentUser && auth.currentUser.email || '').trim().toLowerCase();
      const token = auth && auth.getAccessToken && auth.getAccessToken();
      const expiry = auth && auth.getAccessTokenExpiresAt && Number(auth.getAccessTokenExpiresAt());
      if (!email) throw new Error('Googleアカウントのメールアドレスを確認できません。ログインし直してください。');
      if (!token || !expiry || Date.now() >= expiry) throw new Error('Googleのアクセス許可が期限切れです。Googleアカウント連携ボタンを押してください。');
      accessToken = token;
      tokenExpiresAt = expiry;

      let record = scheduleSheetRecord(email);
      if (record && record.spreadsheetId) {
        try {
          const meta = await window.PC_SHEETS_API_JSON(SHEETS_API + encodeURIComponent(record.spreadsheetId) + '?fields=spreadsheetId,spreadsheetUrl', token);
          record.url = meta.spreadsheetUrl || record.url || ('https://docs.google.com/spreadsheets/d/' + record.spreadsheetId + '/edit');
          const chipDropdownApplied = await ensureScheduleSpreadsheetLayout(record, token);
          record.chipDropdownApplied = chipDropdownApplied;
          saveScheduleSheetRecord(email, record);
          renderScheduleSheetNotice(record, chipDropdownApplied
            ? '既存の明日の持ち物シートに接続しました。授業時間数のプルダウンを確認しました。'
            : '既存の持ち物シートに接続しました。授業時間数のプルダウンを設定しました。');
          return record;
        } catch (error) {
          if (error.status === 401 || error.status === 403) throw error;
          if (error.status && error.status !== 404) throw error;
          // Only a definite missing-file response allows replacement creation.
          // Temporary/network/API errors must not silently create duplicate spreadsheets.
          if (error.status !== 404) throw error;
          console.warn('Cached schedule spreadsheet was not found; creating a replacement.', error);
          record = null;
        }
      }

      const created = await window.PC_SHEETS_API_JSON(SHEETS_API, token, {
        method: 'POST',
        body: {
          properties: { title: SCHEDULE_SPREADSHEET_TITLE },
          sheets: [{ properties: { title: '予定', gridProperties: { rowCount: 200, columnCount: 26 } } }]
        }
      });
      if (!created.spreadsheetId) throw new Error('Googleから新しいスプレッドシートIDが返されませんでした。');
      record = {
        spreadsheetId: created.spreadsheetId,
        url: created.spreadsheetUrl || ('https://docs.google.com/spreadsheets/d/' + created.spreadsheetId + '/edit'),
        createdAt: Date.now()
      };
      // Save ID before formatting so a retry will reuse the same spreadsheet.
      saveScheduleSheetRecord(email, record);
      const chipDropdownApplied = await ensureScheduleSpreadsheetLayout(record, token);
      record.chipDropdownApplied = chipDropdownApplied;
      saveScheduleSheetRecord(email, record);
      renderScheduleSheetNotice(record, chipDropdownApplied
        ? '明日の持ち物シートを自動作成し、授業時間数のプルダウンを設定しました。'
        : '明日の持ち物シートを自動作成し、授業時間数のプルダウンを設定しました。');
      return record;
    })();
    try {
      return await scheduleCreationPromise;
    } finally {
      scheduleCreationPromise = null;
    }
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
      link.textContent = '明日の持ち物シートを開く';
      link.style.cssText = 'display:inline-block;margin-top:6px;color:inherit;text-decoration:underline;text-underline-offset:3px';
      node.appendChild(link);
      const detail = document.createElement('p');
      detail.textContent = '「予定」シートのA2で授業時間数、D2で明日の持ち物を指定します。日付入力は不要です。';
      detail.style.cssText = 'margin:6px 0 0;font-size:12px;opacity:.8';
      node.appendChild(detail);
    }
  }

  const SHARED_SCHEDULE_URL = 'https://docs.google.com/spreadsheets/d/1-NqPh0uK2b00Q16ipvkRgkZEOTNNN53CBKn8_kwXsPQ/edit?usp=sharing';
  const SHARED_SCHEDULE_ID = '1-NqPh0uK2b00Q16ipvkRgkZEOTNNN53CBKn8_kwXsPQ';
  const SHARED_PENDING_KEY = 'pc-shared-schedule-pending-v1';
  const SCHEDULE_EXPORT_CACHE_KEY = 'pc-schedule-export-rows-v1';
  const SCHEDULE_EXPORT_HEADERS = [
    '授業時間数', '区分（通常/特別）', '特別の記入',
    '明日の持ち物', '追加のお知らせ', '1〜4時間授業の発表時刻（HH:mm）'
  ];
  let sharedUrlInput = null;
  let sharedConnectButton = null;
  let csvExportButton = null;
  let xlsxExportButton = null;
  let exportStatusNode = null;
  let manualFields = {};

  function cacheScheduleRows(rows) {
    const row = Array.isArray(rows) ? rows[1] || [] : [];
    const normalized = [SCHEDULE_EXPORT_HEADERS.slice(), SCHEDULE_EXPORT_HEADERS.map((_, i) => String(row[i] == null ? '' : row[i]))];
    try { localStorage.setItem(SCHEDULE_EXPORT_CACHE_KEY, JSON.stringify(normalized)); } catch (error) {}
    return normalized;
  }

  function getCachedScheduleRows() {
    try {
      const cached = JSON.parse(localStorage.getItem(SCHEDULE_EXPORT_CACHE_KEY) || 'null');
      if (Array.isArray(cached)) {
        const row = Array.isArray(cached[1]) ? cached[1] : (Array.isArray(cached[0]) ? cached[0] : []);
        return [SCHEDULE_EXPORT_HEADERS.slice(), SCHEDULE_EXPORT_HEADERS.map((_, i) => String(row[i] == null ? '' : row[i]))];
      }
    } catch (error) {}
    return [SCHEDULE_EXPORT_HEADERS.slice(), ['', '', '', '', '', '']];
  }

  function currentScheduleRows() {
    if (manualFields.classes) {
      return [SCHEDULE_EXPORT_HEADERS.slice(), [
        manualFields.classes.value,
        manualFields.kind.value,
        manualFields.special.value,
        manualFields.items.value,
        manualFields.extra.value,
        manualFields.time.value
      ].map(value => String(value == null ? '' : value))];
    }
    return getCachedScheduleRows();
  }

  function storeCurrentScheduleRows(showMessage) {
    const rows = cacheScheduleRows(currentScheduleRows());
    if (exportStatusNode && showMessage) exportStatusNode.textContent = '入力内容をこの端末に保存しました。';
    return rows;
  }

  async function saveManualSchedule(showMessage = true) {
    const rows = storeCurrentScheduleRows(false);
    const row = rows[1] || ['', '通常', '', '', '', ''];
    const auth = window.PC_AUTH;
    const token = auth && auth.getAccessToken && auth.getAccessToken();
    const expiry = auth && auth.getAccessTokenExpiresAt && Number(auth.getAccessTokenExpiresAt());
    const record = activeScheduleRecord();
    if (record && record.spreadsheetId && token && expiry && Date.now() < expiry) {
      accessToken = token;
      tokenExpiresAt = expiry;
      try {
        await ensureScheduleSpreadsheetLayout(record, token);
        const range = encodeURIComponent("'予定'!A2:F2");
        await apiRequest(SHEETS_API + encodeURIComponent(record.spreadsheetId) + '/values/' + range + '?valueInputOption=USER_ENTERED', {
          method: 'PUT',
          body: { values: [row] }
        });
        if (exportStatusNode && showMessage) exportStatusNode.textContent = '入力内容をこの端末と接続済みGoogleスプレッドシートに保存しました。';
        setStatus('入力内容をGoogleスプレッドシートに保存しました。自動音声発表にも使われます。');
        return { rows, synced: true };
      } catch (error) {
        if (exportStatusNode && showMessage) exportStatusNode.textContent = '端末には保存しましたが、Googleシートへの同期に失敗しました。接続状態を確認してください。詳細: ' + String(error && error.message || error);
        setStatus('入力内容はこの端末に保存しました。Googleシートへの同期は未完了です。');
        return { rows, synced: false, error };
      }
    }
    if (exportStatusNode && showMessage) exportStatusNode.textContent = '入力内容をこの端末に保存しました。時刻に合わせた自動発表を使うにはGoogleシートへ接続してください。';
    setStatus('入力内容をこの端末に保存しました。');
    return { rows, synced: false };
  }

  async function announceManualSchedule() {
    const rows = storeCurrentScheduleRows(false);
    const row = rows[1] || [];
    const items = String(row[3] == null ? '' : row[3]).trim();
    if (!items) {
      if (exportStatusNode) exportStatusNode.textContent = '「明日の持ち物」を入力してから音声発表を押してください。';
      setError('明日の持ち物が入力されていません。');
      if (manualFields.items) manualFields.items.focus();
      return false;
    }
    setError('');
    if (manualAnnounceButton) { manualAnnounceButton.disabled = true; manualAnnounceButton.textContent = '音声発表中…'; }
    try {
      const maker = window.PC_SCHEDULE_ANNOUNCEMENT_TEXT;
      const message = typeof maker === 'function'
        ? maker(row)
        : '明日の持ち物は、' + items.replace(/[。．.!！?？]+$/, '') + 'です。' + (String(row[4] || '').trim() ? ' ' + String(row[4]).trim() : '');
      const speak = window.PC_SCHEDULE_SPEAK;
      if (typeof speak !== 'function') throw new Error('音声モジュールを読み込めませんでした。ページを再読み込みしてください。');
      storeCurrentScheduleRows(false);
      const syncPromise = saveManualSchedule(false);
      if (exportStatusNode) exportStatusNode.textContent = '入力内容を音声で発表しています。Google接続中なら共有シートにも保存します。';
      await speak(message);
      syncPromise.then(result => {
        if (exportStatusNode) exportStatusNode.textContent = result && result.synced
          ? '音声発表が完了し、共有シートにも保存しました。'
          : '音声発表が完了しました。入力内容はこの端末に保存されています。Googleシートへの同期状態は接続表示を確認してください。';
      }).catch(() => {});
      return true;
    } catch (error) {
      if (exportStatusNode) exportStatusNode.textContent = '音声を発表できませんでした。音量・ネット接続・音声APIを確認してください。詳細: ' + String(error && error.message || error);
      return false;
    } finally {
      if (manualAnnounceButton) { manualAnnounceButton.disabled = false; manualAnnounceButton.textContent = '今すぐ音声で発表'; }
    }
  }

  function fillManualFields(rows) {
    if (!manualFields.classes) return;
    const row = Array.isArray(rows) ? (Array.isArray(rows[1]) ? rows[1] : rows[0] || []) : [];
    manualFields.classes.value = String(row[0] == null ? '' : row[0]);
    manualFields.kind.value = String(row[1] == null ? '' : row[1]) || '通常';
    manualFields.special.value = String(row[2] == null ? '' : row[2]);
    manualFields.items.value = String(row[3] == null ? '' : row[3]);
    manualFields.extra.value = String(row[4] == null ? '' : row[4]);
    manualFields.time.value = String(row[5] == null ? '' : row[5]);
  }

  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[\t\r ]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function downloadScheduleFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function scheduleDateStamp() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const result = {};
    parts.forEach(part => { result[part.type] = part.value; });
    return result.year + result.month + result.day;
  }

  function exportScheduleCsv() {
    const rows = [SCHEDULE_EXPORT_HEADERS.slice(), ['', '通常', '', '', '', '']];
    const content = '\uFEFF' + rows.map(row => SCHEDULE_EXPORT_HEADERS.map((_, i) => csvCell(row[i])).join(',')).join('\r\n') + '\r\n';
    downloadScheduleFile(new Blob([content], { type: 'text/csv;charset=utf-8' }), '接続用スプレッドシートテンプレート-' + scheduleDateStamp() + '.csv');
    if (exportStatusNode) exportStatusNode.textContent = '接続用CSVテンプレートを保存しました。Googleスプレッドシートの「ファイル → インポート → アップロード」から見出しと入力行を取り込めます。';
  }

  function xmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function columnName(index) {
    let n = Number(index) + 1;
    let name = '';
    while (n > 0) {
      const remainder = (n - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  const zipCrcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function zipCrc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = zipCrcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Create a tiny valid XLSX container using Store-mode ZIP, with no external JS dependency.
  function buildStoredZip(files) {
    const encoder = new TextEncoder();
    const localParts = [], centralParts = [];
    let localOffset = 0, centralSize = 0;
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
    const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) |
      (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
    const u16 = (view, offset, value) => view.setUint16(offset, value, true);
    const u32 = (view, offset, value) => view.setUint32(offset, value >>> 0, true);
    files.forEach(file => {
      const name = encoder.encode(file.name);
      const data = encoder.encode(file.content);
      const crc = zipCrc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0); u16(lv, 8, 0);
      u16(lv, 10, dosTime); u16(lv, 12, dosDate); u32(lv, 14, crc);
      u32(lv, 18, data.length); u32(lv, 22, data.length); u16(lv, 26, name.length); u16(lv, 28, 0);
      local.set(name, 30);
      localParts.push(local, data);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0); u16(cv, 10, 0);
      u16(cv, 12, dosTime); u16(cv, 14, dosDate); u32(cv, 16, crc);
      u32(cv, 20, data.length); u32(cv, 24, data.length); u16(cv, 28, name.length);
      u16(cv, 30, 0); u16(cv, 32, 0); u16(cv, 34, 0); u16(cv, 36, 0);
      u32(cv, 38, 0); u32(cv, 42, localOffset);
      central.set(name, 46);
      centralParts.push(central);
      localOffset += local.length + data.length;
      centralSize += central.length;
    });
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0);
    u16(ev, 8, files.length); u16(ev, 10, files.length); u32(ev, 12, centralSize);
    u32(ev, 16, localOffset); u16(ev, 20, 0);
    const chunks = [...localParts, ...centralParts, end];
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    chunks.forEach(chunk => { output.set(chunk, offset); offset += chunk.length; });
    return output;
  }

  function exportScheduleXlsx() {
    const rows = [SCHEDULE_EXPORT_HEADERS.slice(), ['', '通常', '', '', '', '']];
    const widths = [18, 24, 28, 42, 42, 34];
    const sheetRows = rows.map((row, r) => {
      const cells = SCHEDULE_EXPORT_HEADERS.map((_, c) => {
        const ref = columnName(c) + (r + 1);
        const val = xmlEscape(row[c] == null ? '' : row[c]);
        return '<c r="' + ref + '" t="inlineStr"' + (r === 0 ? ' s="1"' : '') + '><is><t xml:space="preserve">' + val + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    const cols = widths.map((width, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>').join('');
    const files = [
      { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="予定" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Yu Gothic"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBFA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>' + cols + '</cols><sheetData>' + sheetRows + '</sheetData><autoFilter ref="A1:F2"/></worksheet>' }
    ];
    const bytes = buildStoredZip(files);
    downloadScheduleFile(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '明日の持ち物-' + scheduleDateStamp() + '.xlsx');
    if (exportStatusNode) exportStatusNode.textContent = 'Excelテンプレートを保存しました。Googleスプレッドシートの「ファイル → インポート → アップロード」から見出しと入力行を取り込めます。';
  }

  function sheetIdFromUrl(value) {
    const match = String(value || '').trim().match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : '';
  }

  async function readAndCacheScheduleRows(record, token) {
    const range = escapeSheetName('予定') + '!A1:F2';
    const data = await window.PC_SHEETS_API_JSON(SHEETS_API + encodeURIComponent(record.spreadsheetId) + '/values/' + encodeURIComponent(range), token);
    const values = Array.isArray(data.values) ? data.values : [];
    const result = [SCHEDULE_EXPORT_HEADERS.slice(), Array.isArray(values[1]) ? values[1] : ['', '', '', '', '', '']];
    const rows = cacheScheduleRows(result);
    fillManualFields(rows);
    return rows;
  }

  async function connectSharedSpreadsheet() {
    setError('');
    const url = String(sharedUrlInput && sharedUrlInput.value || SHARED_SCHEDULE_URL).trim();
    const id = sheetIdFromUrl(url);
    if (!id) {
      setError('Googleスプレッドシートの共有URLを正しく入力してください。');
      return;
    }
    const auth = window.PC_AUTH;
    const token = auth && auth.getAccessToken && auth.getAccessToken();
    const expiry = auth && auth.getAccessTokenExpiresAt && Number(auth.getAccessTokenExpiresAt());
    if (!token || !expiry || Date.now() >= expiry) {
      try { localStorage.setItem(SHARED_PENDING_KEY, url); } catch (error) {}
      setStatus('共有スプレッドシートへの接続にはGoogleのアクセス許可が必要です。ログイン画面で許可した後、もう一度押してください。');
      const requested = typeof window.__pcGoogleRequestAccess === 'function' && window.__pcGoogleRequestAccess(true);
      if (!requested && !(typeof window.__pcGoogleAccessIsPending === 'function' && window.__pcGoogleAccessIsPending())) {
        setError('Google接続を開始できませんでした。Googleアカウント欄の再接続を押してください。');
      }
      return;
    }
    accessToken = token;
    tokenExpiresAt = expiry;
    sharedConnectButton.disabled = true;
    sharedConnectButton.textContent = '共有シートを確認中…';
    try {
      const meta = await window.PC_SHEETS_API_JSON(SHEETS_API + encodeURIComponent(id) + '?fields=spreadsheetId,spreadsheetUrl,sheets(properties(sheetId,title),tables(tableId,name,range))', token);
      const record = {
        spreadsheetId: id,
        url: meta.spreadsheetUrl || url,
        shared: true,
        sharedUrl: url,
        createdAt: Date.now()
      };
      const email = String(auth && auth.currentUser && auth.currentUser.email || '').trim().toLowerCase();
      if (!email) throw new Error('Googleアカウント情報を取得できません。Googleログインを確認してください。');
      saveScheduleSheetRecord(email, record);
      await ensureScheduleSpreadsheetLayout(record, token);
      const saved = await readAndCacheScheduleRows(record, token);
      renderScheduleSheetNotice(record, '共有スプレッドシートに接続しました。ここから編集・音声発表を利用できます。');
      setStatus('共有スプレッドシートに接続しました。');
      if (exportStatusNode) exportStatusNode.textContent = '共有シートの予定を読み込みました。フォームで編集して保存するとA2:F2へ反映されます。CSV・Excelテンプレートも利用できます。';
      try { localStorage.removeItem(SHARED_PENDING_KEY); } catch (error) {}
    } catch (error) {
      setError('共有シートに接続できませんでした。リンクの共有権限とGoogleのアクセス許可を確認してください。' + (error.message ? ' 詳細: ' + error.message : ''));
      setStatus('共有シート未接続です。端末への手動保存と即時音声発表は使えます。CSV・Excelは接続用テンプレートです。');
    } finally {
      if (sharedConnectButton) {
        sharedConnectButton.disabled = false;
        sharedConnectButton.textContent = '共有スプレッドシートに接続';
      }
    }
  }

  window.addEventListener('pc-auth-changed', event => {
    if (event && event.detail && event.detail.signedIn) {
      const auth = window.PC_AUTH;
      if (auth && auth.getAccessToken && auth.getAccessToken()) {
        let pendingShared = '';
        try { pendingShared = localStorage.getItem(SHARED_PENDING_KEY) || ''; } catch (error) {}
        if (pendingShared) {
          if (sharedUrlInput) sharedUrlInput.value = pendingShared;
          connectSharedSpreadsheet().catch(error => console.error('Shared spreadsheet connection failed', error));
          return;
        }
        autoCreateScheduleSpreadsheet().then(async record => {
          try { await readAndCacheScheduleRows(record, auth.getAccessToken()); } catch (readError) {}
        }).catch(error => {
          renderScheduleSheetNotice(null, '明日の持ち物シートを自動作成できませんでした。' + (error.message || '不明なエラー'));
          if (exportStatusNode) exportStatusNode.textContent = '自動作成に失敗しました。下の入力欄から手動保存・音声発表できます。CSV・Excelは接続用テンプレートです。';
          console.error('Schedule spreadsheet auto-create failed', error);
        });
      }
    }
  });

  function installUI() {
    document.getElementById('pcSheetsLoadingNotice')?.remove();
    const panes = [...document.querySelectorAll('.clk-panel__pane')];
    const pane = document.getElementById('pcSheetsSettingsPane') || panes.find((item) => item.querySelector('[aria-label="フォントの太さ"]')) || panes[5];
    if (!pane || document.getElementById('pcGoogleSheetsGroup')) return;

    const group = document.createElement('section');
    group.id = 'pcGoogleSheetsGroup';
    group.className = 'clk-group';
    group.style.cssText = 'padding:14px;border:1px solid var(--clk-fg,#1e40af);border-radius:14px;margin-top:12px';
    const title = document.createElement('div');
    title.className = 'clk-group__label';
    title.textContent = 'Googleスプレッドシート連携';
    const note = document.createElement('p');
    note.className = 'clk-group__hint';
    note.textContent = 'ここで予定を自分で入力し、保存して音声発表できます。共有シートに接続すると同じ内容を同期します。CSV・Excelは入力内容ではなく、Googleスプレッドシートに取り込むための空テンプレートを書き出します。';
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:9px 0;font-size:12.5px;line-height:1.5';
    statusNode.textContent = '未接続';
    errorNode = document.createElement('p');
    errorNode.style.cssText = 'color:#b91c1c;margin:6px 0;font-size:12px;line-height:1.5';
    errorNode.hidden = true;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px';
    connectButton = makeButton('明日の持ち物シートを確認', true);
    testButton = makeButton('持ち物テスト（明日の持ち物を発表）', true);
    actions.append(connectButton, testButton);
    testOutput = document.createElement('div');
    testOutput.id = 'pcPackingTestOutput';
    testOutput.style.cssText = 'margin-top:12px;min-width:0';
    const sharedSection = document.createElement('section');
    sharedSection.id = 'pcSharedScheduleConnect';
    sharedSection.style.cssText = 'margin-top:14px;padding:12px;border:1px solid var(--clk-border,rgba(127,127,127,.25));border-radius:12px;min-width:0';
    const sharedLabel = document.createElement('label');
    sharedLabel.textContent = '共有スプレッドシートURL';
    sharedLabel.style.cssText = 'display:block;font-size:12px;font-weight:600';
    sharedUrlInput = document.createElement('input');
    sharedUrlInput.type = 'url';
    sharedUrlInput.value = SHARED_SCHEDULE_URL;
    sharedUrlInput.autocomplete = 'url';
    sharedUrlInput.spellcheck = false;
    sharedUrlInput.style.cssText = 'display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:5px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit;font-size:12px';
    sharedLabel.appendChild(sharedUrlInput);
    const sharedActions = document.createElement('div');
    sharedActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:9px';
    sharedConnectButton = makeButton('共有スプレッドシートに接続', true);
    const sharedOpenLink = document.createElement('a');
    sharedOpenLink.href = SHARED_SCHEDULE_URL;
    sharedOpenLink.target = '_blank';
    sharedOpenLink.rel = 'noopener noreferrer';
    sharedOpenLink.textContent = '共有シートを開く';
    sharedOpenLink.style.cssText = 'display:inline-flex;align-items:center;border:1px solid currentColor;border-radius:10px;padding:9px 13px;color:inherit;text-decoration:none;font-size:13px;font-weight:600';
    sharedActions.append(sharedConnectButton, sharedOpenLink);
    const sharedNote = document.createElement('p');
    sharedNote.className = 'clk-group__hint';
    sharedNote.style.cssText = 'margin:8px 0 0;overflow-wrap:anywhere';
    sharedNote.textContent = 'Googleにログインし、リンク先シートへの編集権限があるアカウントで接続してください。接続できなくても端末への保存と即時音声発表は使えます。CSV・Excelボタンは空の接続用テンプレートです。';
    sharedConnectButton.addEventListener('click', connectSharedSpreadsheet);
    sharedSection.append(sharedLabel, sharedActions, sharedNote);

    const guide = document.createElement('a');
    guide.href = 'https://github.com/harunobushishido-boop/stopwatch/blob/main/GOOGLE_LOGIN_SETUP.md';
    guide.target = '_blank';
    guide.rel = 'noopener noreferrer';
    guide.textContent = '連携の初期設定ガイド';
    guide.style.cssText = 'display:inline-block;margin-top:10px;font-size:12px;color:inherit;text-decoration:underline;text-underline-offset:3px';
    const foot = document.createElement('p');
    foot.className = 'clk-group__hint';
    foot.style.marginTop = '10px';
    foot.textContent = '「予定」シートは見出し1行＋入力1行です。A列=授業時間数、B列=区分、C列=特別の記入、D列=明日の持ち物、E列=追加のお知らせ、F列=1〜4時間授業の発表時刻（HH:mm）。5時間は14:25、6時間は15:15です。';
    const fallbackEditor = document.createElement('section');
    fallbackEditor.id = 'pcScheduleFallbackEditor';
    fallbackEditor.style.cssText = 'margin-top:14px;padding:12px;border:1px solid var(--clk-border,rgba(127,127,127,.25));border-radius:12px;min-width:0';
    fallbackEditor.innerHTML = '<h3 style="font-size:14px;font-weight:700;margin:0 0 6px">予定を入力して保存・音声発表</h3>' +
      '<p style="font-size:12px;line-height:1.65;opacity:.8;margin:0 0 10px">ここに入力した予定はこの端末に保存されます。Googleシートに接続済みなら保存時に共有シートのA2:F2へ反映します。「今すぐ音声で発表」から入力内容を読み上げられます。CSV・Excelは接続用の空テンプレートです。</p>' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-width:0">' +
      '<label style="min-width:0;font-size:12px">授業時間数<select id="pcScheduleManualClasses" style="display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit"><option value="">選択</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label>' +
      '<label style="min-width:0;font-size:12px">区分<select id="pcScheduleManualKind" style="display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit"><option>通常</option><option>特別</option></select></label>' +
      '<label style="min-width:0;font-size:12px;grid-column:1/-1">特別の記入<input id="pcScheduleManualSpecial" type="text" style="display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit"></label>' +
      '<label style="min-width:0;font-size:12px;grid-column:1/-1">明日の持ち物<textarea id="pcScheduleManualItems" rows="2" style="display:block;box-sizing:border-box;width:100%;min-width:0;resize:vertical;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit"></textarea></label>' +
      '<label style="min-width:0;font-size:12px;grid-column:1/-1">追加のお知らせ<textarea id="pcScheduleManualExtra" rows="2" style="display:block;box-sizing:border-box;width:100%;min-width:0;resize:vertical;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit"></textarea></label>' +
      '<label style="min-width:0;font-size:12px">1〜4時間授業の発表時刻<input id="pcScheduleManualTime" type="time" style="display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit"></label>' +
      '</div>';
    manualFields = {
      classes: fallbackEditor.querySelector('#pcScheduleManualClasses'),
      kind: fallbackEditor.querySelector('#pcScheduleManualKind'),
      special: fallbackEditor.querySelector('#pcScheduleManualSpecial'),
      items: fallbackEditor.querySelector('#pcScheduleManualItems'),
      extra: fallbackEditor.querySelector('#pcScheduleManualExtra'),
      time: fallbackEditor.querySelector('#pcScheduleManualTime')
    };
    Object.values(manualFields).forEach(field => { field.addEventListener('input', () => storeCurrentScheduleRows(false)); if (field.tagName === 'SELECT') field.addEventListener('change', () => storeCurrentScheduleRows(false)); });
    fillManualFields(getCachedScheduleRows());
    const manualActions = document.createElement('div');
    manualActions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
    manualSaveButton = makeButton('入力内容を保存', true);
    manualAnnounceButton = makeButton('今すぐ音声で発表', true);
    manualActions.append(manualSaveButton, manualAnnounceButton);
    manualSaveButton.addEventListener('click', () => saveManualSchedule(true));
    manualAnnounceButton.addEventListener('click', announceManualSchedule);
    const exportActions = document.createElement('div');
    exportActions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
    csvExportButton = makeButton('接続用CSVテンプレート');
    xlsxExportButton = makeButton('Excelテンプレート（.xlsx）');
    exportActions.append(csvExportButton, xlsxExportButton);
    csvExportButton.addEventListener('click', exportScheduleCsv);
    xlsxExportButton.addEventListener('click', exportScheduleXlsx);
    exportStatusNode = document.createElement('p');
    exportStatusNode.className = 'clk-group__hint';
    exportStatusNode.style.cssText = 'margin:8px 0 0;overflow-wrap:anywhere';
    exportStatusNode.textContent = '入力した予定はこの端末に保存され、接続済みシートがあれば「入力内容を保存」でA2:F2へ反映します。CSV・Excelボタンは空の接続用テンプレートです。';
    fallbackEditor.append(manualActions, exportActions, exportStatusNode);

    group.append(title, note, statusNode, errorNode, actions, testOutput, sharedSection, fallbackEditor, guide, foot);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);

    connectButton.addEventListener('click', connect);
    testButton.addEventListener('click', runPackingTest);
    if (activeScheduleRecord()) setStatus('保存済みの明日の持ち物シートを再利用します。見つからない場合だけ作成します。');
    window.PC_SHEETS = {
      connect,
      connectSharedSpreadsheet,
      exportScheduleCsv,
      exportScheduleXlsx,
      saveManualSchedule,
      announceManualSchedule,
      ensureScheduleSpreadsheet: autoCreateScheduleSpreadsheet,
      get connected() { return Boolean(accessToken && Date.now() < tokenExpiresAt); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUI, { once: true });
  else installUI();
})();