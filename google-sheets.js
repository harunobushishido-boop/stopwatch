(() => {
  'use strict';

  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  let accessToken = '';
  let tokenExpiresAt = 0;
  let statusNode, errorNode, connectButton, testButton, testOutput;

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
        const requested = typeof window.__pcGoogleRequestAccess === 'function' && window.__pcGoogleRequestAccess(false);
        if (!requested && !(typeof window.__pcGoogleAccessIsPending === 'function' && window.__pcGoogleAccessIsPending())) setError('Google接続を開始できませんでした。Googleアカウント欄の「Googleへのアクセスを再接続」を押してください。');
        return;
      }
      accessToken = token;
      tokenExpiresAt = expiry;
      const record = await autoCreateScheduleSpreadsheet();
      setStatus('明日の持ち物シートに接続しました。');
      renderScheduleSheetNotice(record, '明日の持ち物シートに接続しました。');
    } catch (error) {
      setError(error.message || 'Googleスプレッドシートに接続できませんでした。');
      setStatus('未接続');
      console.error('Schedule spreadsheet connection failed', error);
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = '今日の予定シートを確認';
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
      const requested = typeof window.__pcGoogleRequestAccess === 'function' && window.__pcGoogleRequestAccess(false);
      if (!requested && !(typeof window.__pcGoogleAccessIsPending === 'function' && window.__pcGoogleAccessIsPending())) setError('Google接続を開始できませんでした。Googleアカウント欄の「Googleへのアクセスを再接続」を押してください。');
      return;
    }

    accessToken = token;
    tokenExpiresAt = expiry;
    try {
      if (!record || !record.spreadsheetId) record = await autoCreateScheduleSpreadsheet();
    } catch (error) {
      setError('明日の持ち物シートを自動作成できませんでした。' + (error.message || '不明なエラー'));
      setStatus('作成に失敗しました');
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
      const range = escapeSheetName('予定') + '!A1:E2';
      const data = await apiRequest(SHEETS_API + encodeURIComponent(id) + '/values/' + encodeURIComponent(range));
      const values = Array.isArray(data.values) ? data.values : [];
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
    const requestJson = async (url, options = {}) => {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: Object.assign({ Authorization: 'Bearer ' + token }, options.body ? { 'Content-Type': 'application/json' } : {}),
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error && data.error.message || 'Googleスプレッドシートを更新できませんでした。');
      return data;
    };
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
    if (!Number.isInteger(sheetId)) throw new Error('今日の予定シートのIDを取得できませんでした。');

    const oldData = await requestJson(base + '/values/' + encodeURIComponent("'予定'!A1:Z200"));
    const oldValues = Array.isArray(oldData.values) ? oldData.values : [];
    const oldHeader = (oldValues[0] || []).map(value => String(value == null ? '' : value).trim());
    const newHeader = ['授業時間数', '区分（通常/特別）', '特別の記入', '明日の持ち物', '追加のお知らせ'];
    const today = currentTokyoDateKey();
    let todayRow = ['', '', '', '', ''];

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

    if (dateColumn >= 0) {
      // 以前の日付別シートは「今日」に一致する行だけを引き継ぐ。
      const todayOldRow = oldValues.slice(1).find(row => normalizeScheduleDate(row[dateColumn]) === today);
      if (todayOldRow) {
        todayRow = [
          rowValue(todayOldRow, classCol), rowValue(todayOldRow, kindCol), rowValue(todayOldRow, specialCol),
          rowValue(todayOldRow, planCol), rowValue(todayOldRow, textCol)
        ];
      }
    } else if (oldHeader.length) {
      const existingRow = oldValues[1] || [];
      todayRow = [
        rowValue(existingRow, classCol), rowValue(existingRow, kindCol), rowValue(existingRow, specialCol),
        rowValue(existingRow, planCol), rowValue(existingRow, textCol)
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
      { columnIndex: 4, columnName: newHeader[4], columnType: 'TEXT' }
    ];

    // まずセルを「見出し1行＋今日の入力1行」に揃える。
    // 古い日付列・過去の発表内容はこの「予定」シートから除き、別シートは触らない。
    const requests = [
      {
        updateCells: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 26 },
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
        Number(range.startColumnIndex || 0) < 5 &&
        Number(range.endColumnIndex || 0) > 0;
    });
    const tableRequest = !overlappingTable
      ? { addTable: { table: {
          name: 'TodaySchedule',
          range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 5 },
          columnProperties
        } } }
      : { updateTable: { table: { tableId: overlappingTable.tableId, columnProperties }, fields: 'columnProperties' } };
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

  const SCHEDULE_SPREADSHEET_TITLE = '6年4組便利タイマー - 明日の持ち物';

  async function scheduleApiJson(url, token, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token }, options.body ? { 'Content-Type': 'application/json' } : {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data && data.error && data.error.message || ('Google APIエラー（HTTP ' + response.status + '）'));
      error.status = response.status;
      throw error;
    }
    return data;
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
          const meta = await scheduleApiJson(SHEETS_API + encodeURIComponent(record.spreadsheetId) + '?fields=spreadsheetId,spreadsheetUrl', token);
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

      const created = await scheduleApiJson(SHEETS_API, token, {
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

  window.addEventListener('pc-auth-changed', event => {
    if (event && event.detail && event.detail.signedIn) {
      const auth = window.PC_AUTH;
      if (auth && auth.getAccessToken && auth.getAccessToken()) {
        autoCreateScheduleSpreadsheet().catch(error => {
          renderScheduleSheetNotice(null, '今日の予定スプレッドシートを自動作成できませんでした。' + (error.message || '不明なエラー'));
          console.error('Schedule spreadsheet auto-create failed', error);
        });
      }
    }
  });

  function installUI() {
    const panes = [...document.querySelectorAll('.clk-panel__pane')];
    const pane = panes.find((item) => item.querySelector('[aria-label="フォントの太さ"]')) || panes[5];
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
    note.textContent = 'Google接続後に明日の持ち物シートを自動作成します。スプレッドシートが削除されていた場合も再作成し、授業時間数のプルダウンを設定します。';
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:9px 0;font-size:12.5px;line-height:1.5';
    statusNode.textContent = '未接続';
    errorNode = document.createElement('p');
    errorNode.style.cssText = 'color:#b91c1c;margin:6px 0;font-size:12px;line-height:1.5';
    errorNode.hidden = true;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px';
    connectButton = makeButton('今日の予定シートを確認', true);
    testButton = makeButton('持ち物テスト（明日の持ち物を発表）', true);
    actions.append(connectButton, testButton);
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
    foot.textContent = '「予定」シートは見出し1行＋入力1行です。A列=授業時間数（1〜6のプルダウン）、B列=区分、C列=特別の記入、D列=明日の持ち物、E列=追加のお知らせ。';
    group.append(title, note, statusNode, errorNode, actions, testOutput, guide, foot);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);

    connectButton.addEventListener('click', connect);
    testButton.addEventListener('click', runPackingTest);
    if (activeScheduleRecord()) setStatus('明日の持ち物シートを使用します。存在しない場合は自動で再作成します。');
    window.PC_SHEETS = {
      connect,
      ensureScheduleSpreadsheet: autoCreateScheduleSpreadsheet,
      get connected() { return Boolean(accessToken && Date.now() < tokenExpiresAt); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUI, { once: true });
  else installUI();
})();