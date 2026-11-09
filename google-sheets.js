(() => {
  'use strict';

  const NOTE_STORAGE_KEY = 'pc-shared-note-v1';
  const SHARED_NOTE_URL = 'https://docs.google.com/spreadsheets/d/1-NqPh0uK2b00Q16ipvkRgkZEOTNNN53CBKn8_kwXsPQ/edit?usp=sharing';
  const SCHEDULE_ROWS_KEY = 'pc-schedule-export-rows-v1';
  const HEADERS = [
    '授業時間数',
    '区分（通常/特別）',
    '特別の記入',
    '明日の持ち物',
    '追加のお知らせ',
    '1〜4時間授業の発表時刻（HH:mm）'
  ];
  const MAX_NOTE_LENGTH = 50000;
  const MAX_FIELD_LENGTH = 5000;

  let pane = null;
  let statusNode = null;
  let errorNode = null;
  let noteField = null;
  let fields = {};

  const button = (label, primary) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.cssText =
      'padding:9px 13px;border:1px solid ' + (primary ? '#15803d' : 'currentColor') +
      ';border-radius:10px;background:' + (primary ? '#15803d' : 'transparent') +
      ';color:' + (primary ? '#fff' : 'inherit') +
      ';font:inherit;font-size:13px;font-weight:600;cursor:pointer';
    return element;
  };

  const setStatus = (message) => {
    if (statusNode) statusNode.textContent = message || '';
  };
  const setError = (message) => {
    if (!errorNode) return;
    errorNode.textContent = message || '';
    errorNode.hidden = !message;
  };

  function safeText(value, maxLength) {
    return String(value == null ? '' : value).slice(0, maxLength);
  }

  function emptyRow() {
    return ['', '通常', '', '', '', ''];
  }

  function normalizeRow(row) {
    const source = Array.isArray(row) ? row : [];
    return HEADERS.map((_, index) => safeText(source[index], MAX_FIELD_LENGTH));
  }

  function readState() {
    try {
      const state = JSON.parse(localStorage.getItem(NOTE_STORAGE_KEY) || 'null');
      if (state && typeof state === 'object') {
        return {
          version: 1,
          title: safeText(state.title || '共有ノート', 100),
          note: safeText(state.note, MAX_NOTE_LENGTH),
          row: normalizeRow(state.row),
          updatedAt: Number(state.updatedAt) || 0
        };
      }
    } catch (error) {
      console.warn('共有ノートを読み込めませんでした。', error);
    }

    // 以前のスプレッドシート連携で端末内に保存した入力内容を引き継ぐ。
    try {
      const cached = JSON.parse(localStorage.getItem(SCHEDULE_ROWS_KEY) || 'null');
      if (Array.isArray(cached)) {
        return {
          version: 1,
          title: '共有ノート',
          note: '',
          row: normalizeRow(Array.isArray(cached[1]) ? cached[1] : cached[0]),
          updatedAt: 0
        };
      }
    } catch (error) {}
    return { version: 1, title: '共有ノート', note: '', row: emptyRow(), updatedAt: 0 };
  }

  function currentState() {
    const row = [
      fields.classes ? fields.classes.value : '',
      fields.kind ? fields.kind.value : '通常',
      fields.special ? fields.special.value : '',
      fields.items ? fields.items.value : '',
      fields.extra ? fields.extra.value : '',
      fields.time ? fields.time.value : ''
    ].map(value => safeText(value, MAX_FIELD_LENGTH));

    return {
      version: 1,
      title: '共有ノート',
      note: safeText(noteField ? noteField.value : '', MAX_NOTE_LENGTH),
      row,
      updatedAt: Date.now()
    };
  }

  function applyState(state) {
    const safe = {
      version: 1,
      title: '共有ノート',
      note: safeText(state && state.note, MAX_NOTE_LENGTH),
      row: normalizeRow(state && state.row),
      updatedAt: Number(state && state.updatedAt) || Date.now()
    };
    if (fields.classes) fields.classes.value = safe.row[0];
    if (fields.kind) fields.kind.value = safe.row[1] || '通常';
    if (fields.special) fields.special.value = safe.row[2];
    if (fields.items) fields.items.value = safe.row[3];
    if (fields.extra) fields.extra.value = safe.row[4];
    if (fields.time) fields.time.value = safe.row[5];
    if (noteField) noteField.value = safe.note;
    return safe;
  }

  function persist(showMessage) {
    const state = currentState();
    const rows = [HEADERS.slice(), state.row.slice()];
    try {
      localStorage.setItem(NOTE_STORAGE_KEY, JSON.stringify(state));
      // 自動音声発表機能との互換性を保つため、予定欄も従来の保存形式で保持する。
      localStorage.setItem(SCHEDULE_ROWS_KEY, JSON.stringify(rows));
      window.dispatchEvent(new CustomEvent('pc-shared-note-updated', { detail: state }));
      if (showMessage !== false) setStatus('共有ノートをこの端末に保存しました。');
      setError('');
      return { state, rows, saved: true };
    } catch (error) {
      setError('端末に保存できませんでした。ブラウザーの空き容量やサイトデータ設定を確認してください。');
      return { state, rows, saved: false, error };
    }
  }

  function downloadText() {
    const state = currentState();
    const lines = [
      '共有ノート',
      '更新日時: ' + new Date(state.updatedAt).toLocaleString('ja-JP'),
      '',
      '授業時間数: ' + state.row[0],
      '区分: ' + state.row[1],
      '特別の記入: ' + state.row[2],
      '明日の持ち物: ' + state.row[3],
      '追加のお知らせ: ' + state.row[4],
      '発表時刻: ' + state.row[5],
      '',
      'ノート本文',
      state.note
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = '共有ノート-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    setStatus('共有ノートをテキストファイルに保存しました。');
  }

  function announce() {
    const saved = persist(false);
    const items = String(saved.state.row[3] || '').trim();
    if (!items) {
      setError('音声発表するには「明日の持ち物」を入力してください。');
      if (fields.items) fields.items.focus();
      return;
    }
    const makeText = window.PC_SCHEDULE_ANNOUNCEMENT_TEXT;
    const speak = window.PC_SCHEDULE_SPEAK;
    if (typeof speak !== 'function') {
      setError('音声機能を読み込めませんでした。ページを再読み込みして再試行してください。');
      return;
    }
    const message = typeof makeText === 'function'
      ? makeText(saved.state.row)
      : '明日の持ち物は、' + items.replace(/[。．.!！?？]+$/, '') + 'です。';
    const showDisplay = window.PC_SCHEDULE_SHOW_ANNOUNCEMENT;
    if (typeof showDisplay === 'function') showDisplay(message, saved.state.row);
    setError('');
    setStatus('共有ノートの内容を音声で発表しています…');
    speak(message).then(played => {
      setStatus(played ? '音声発表が完了しました。' : '音声を再生できませんでした。ブラウザーの音量や通信状態を確認してください。');
    }).catch(error => {
      setError('音声発表に失敗しました。' + String(error && error.message || error));
    });
  }

  function makeField(label, element) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:block;min-width:0;font-size:12px';
    wrapper.appendChild(document.createTextNode(label));
    element.style.cssText = 'display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:4px;padding:9px;border:1px solid var(--clk-border,currentColor);border-radius:8px;background:var(--clk-bg);color:var(--clk-fg);font:inherit';
    wrapper.appendChild(element);
    return wrapper;
  }

  function installUI() {
    document.getElementById('pcSheetsLoadingNotice')?.remove();
    const panes = Array.from(document.querySelectorAll('.clk-panel__pane'));
    pane = document.getElementById('pcSheetsSettingsPane') ||
      panes.find(item => item.querySelector('[aria-label="フォントの太さ"]')) || panes[5];
    if (!pane || document.getElementById('pcSharedNoteGroup')) return;

    const group = document.createElement('section');
    group.id = 'pcSharedNoteGroup';
    group.className = 'clk-group';
    group.style.cssText = 'padding:14px;border:1px solid var(--clk-fg,#1e40af);border-radius:14px;margin-top:12px;min-width:0';

    const title = document.createElement('div');
    title.className = 'clk-group__label';
    title.textContent = '共有ノート';

    const description = document.createElement('p');
    description.className = 'clk-group__hint';
    description.style.cssText = 'margin:7px 0 10px;line-height:1.65';
    description.textContent = '以前から使っている固定の共有ノートを読み込みます。Googleログインは不要です。共有ノートの内容は1秒ごとに確認し、自動音声発表と大きな画面表示に使います。';

    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:8px 0;font-size:12.5px;line-height:1.5';
    statusNode.textContent = 'この端末に保存します。';

    errorNode = document.createElement('p');
    errorNode.style.cssText = 'color:#b91c1c;margin:6px 0;font-size:12px;line-height:1.5';
    errorNode.hidden = true;

    const scheduleGrid = document.createElement('div');
    scheduleGrid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-width:0';

    const classes = document.createElement('select');
    classes.innerHTML = '<option value="">選択</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option>';
    const kind = document.createElement('select');
    kind.innerHTML = '<option value="通常">通常</option><option value="特別">特別</option>';
    const special = document.createElement('input');
    special.type = 'text';
    const items = document.createElement('textarea');
    items.rows = 2;
    items.style.resize = 'vertical';
    const extra = document.createElement('textarea');
    extra.rows = 2;
    extra.style.resize = 'vertical';
    const time = document.createElement('input');
    time.type = 'time';

    fields = { classes, kind, special, items, extra, time };
    // The shared source is the pre-existing link; this panel displays its values.
    // Editing happens in that original note so local-only changes are not mistaken for shared writes.
    classes.disabled = true;
    kind.disabled = true;
    special.readOnly = true;
    items.readOnly = true;
    extra.readOnly = true;
    time.readOnly = true;
    scheduleGrid.append(
      makeField('授業時間数', classes),
      makeField('区分', kind),
      makeField('特別の記入', special),
      makeField('明日の持ち物', items),
      makeField('追加のお知らせ', extra),
      makeField('1〜4時間授業の発表時刻', time)
    );
    scheduleGrid.children[2].style.gridColumn = '1 / -1';
    scheduleGrid.children[3].style.gridColumn = '1 / -1';
    scheduleGrid.children[4].style.gridColumn = '1 / -1';

    const noteSection = document.createElement('div');
    noteSection.style.cssText = 'margin-top:12px';
    noteField = document.createElement('textarea');
    noteField.rows = 7;
    noteField.maxLength = MAX_NOTE_LENGTH;
    noteField.placeholder = '共有ノート本文は以前からの共有リンクで確認してください。';
    noteField.readOnly = true;
    noteField.style.cssText = 'display:block;box-sizing:border-box;width:100%;min-width:0;margin-top:5px;padding:10px;border:1px solid var(--clk-border,currentColor);border-radius:10px;background:var(--clk-bg);color:var(--clk-fg);font:inherit;line-height:1.6;resize:vertical';
    const noteLabel = document.createElement('label');
    noteLabel.textContent = '共有ノートの補足';
    noteLabel.style.cssText = 'display:block;font-size:12px;font-weight:600';
    noteLabel.appendChild(noteField);
    noteSection.appendChild(noteLabel);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
    const announceButton = button('音声で発表', true);
    const openSharedNoteButton = button('以前の共有ノートを開く');
    const downloadButton = button('テキスト保存');
    actions.append(announceButton, openSharedNoteButton, downloadButton);

    const shareHelp = document.createElement('p');
    shareHelp.className = 'clk-group__hint';
    shareHelp.style.cssText = 'margin:10px 0 5px;line-height:1.6';
    shareHelp.textContent = '共有ノートは以前からの固定リンクを使います。新しいリンクは作成しません。リンク先が「リンクを知っている全員が閲覧可」に設定されていれば、Googleログインなしで読み取りできます。';

    const linkNote = document.createElement('p');
    linkNote.style.cssText = 'margin:6px 0 0;font-size:12px;overflow-wrap:anywhere';
    linkNote.textContent = SHARED_NOTE_URL;

    announceButton.addEventListener('click', announce);
    openSharedNoteButton.addEventListener('click', () => window.open(SHARED_NOTE_URL, '_blank', 'noopener,noreferrer'));
    downloadButton.addEventListener('click', downloadText);

    const initial = readState();
    applyState(initial);

    const onEdit = () => persist(false);
    Object.values(fields).forEach(field => {
      field.addEventListener('input', onEdit);
      field.addEventListener('change', onEdit);
    });
    noteField.addEventListener('input', onEdit);

    const syncFromOtherTab = (event) => {
      if (event && event.key && event.key !== NOTE_STORAGE_KEY && event.key !== SCHEDULE_ROWS_KEY) return;
      if (event && event.key === NOTE_STORAGE_KEY && event.newValue) {
        try {
          const updated = JSON.parse(event.newValue);
          applyState(updated);
          setStatus('別のタブで更新された共有ノートを読み込みました。');
        } catch (error) {}
      } else if (event && event.key === SCHEDULE_ROWS_KEY && event.newValue) {
        const current = readState();
        applyState(current);
      }
    };
    window.addEventListener('storage', syncFromOtherTab);
    window.addEventListener('pc-shared-note-data-updated', event => {
      const row = event && event.detail && event.detail.row;
      if (!Array.isArray(row)) return;
      const state = currentState();
      applyState({ row, note: state.note, updatedAt: Date.now() });
      setStatus('以前からの共有ノートを読み込みました。');
    });


    const footnote = pane.querySelector('.clk-panel__footnote');
    group.append(title, description, statusNode, errorNode, scheduleGrid, noteSection, actions, shareHelp, linkNote);
    pane.insertBefore(group, footnote || null);
    setStatus('以前からの共有ノートを1秒ごとに確認しています…');

    window.PC_SHARED_NOTE = {
      getState: currentState,
      save: persist,
      sharedUrl: SHARED_NOTE_URL,
      announce
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installUI, { once: true });
  } else {
    installUI();
  }
})();