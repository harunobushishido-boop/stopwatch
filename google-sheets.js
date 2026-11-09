(() => {
  'use strict';

  // This app uses the original, preconfigured shared note.
  // No note creation, export, editing, or share-link generation is provided here.
  const SHARED_NOTE_CONFIGURED = true;
  let statusNode = null;
  let indicatorNode = null;
  let detailNode = null;

  function updateStatus(detail) {
    if (!statusNode) return;
    if (!detail || detail.ok !== false) {
      statusNode.textContent = '設定済み';
      statusNode.style.color = '#15803d';
      if (indicatorNode) indicatorNode.style.background = '#15803d';
      if (detailNode) {
        detailNode.textContent = detail && detail.checkedAt
          ? '既存の共有ノートを確認済みです。1秒ごとに自動確認しています。'
          : '既存の共有ノートを使用しています。1秒ごとに自動確認します。';
      }
      return;
    }

    statusNode.textContent = '設定済み';
    statusNode.style.color = '#b45309';
    if (indicatorNode) indicatorNode.style.background = '#b45309';
    if (detailNode) {
      detailNode.textContent = '登録済みの共有ノートに接続できていません。元の共有ノートの公開閲覧設定とネットワークを確認してください。';
    }
  }

  function installUI() {
    document.getElementById('pcSheetsLoadingNotice')?.remove();
    const panes = Array.from(document.querySelectorAll('.clk-panel__pane'));
    const pane = document.getElementById('pcSheetsSettingsPane') ||
      panes.find(item => item.querySelector('[aria-label="フォントの太さ"]')) || panes[5];
    if (!pane || document.getElementById('pcSharedNoteGroup')) return;

    const group = document.createElement('section');
    group.id = 'pcSharedNoteGroup';
    group.className = 'clk-group';
    group.style.cssText = 'padding:14px;border:1px solid var(--clk-border,rgba(127,127,127,.3));border-radius:14px;margin-top:12px;min-width:0';

    const title = document.createElement('div');
    title.className = 'clk-group__label';
    title.textContent = '共有ノート';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:9px;margin-top:9px';

    const indicator = document.createElement('span');
    indicatorNode = indicator;
    indicator.setAttribute('aria-hidden', 'true');
    indicator.style.cssText = 'display:inline-block;width:10px;height:10px;flex:0 0 10px;border-radius:50%;background:#15803d';

    statusNode = document.createElement('strong');
    statusNode.setAttribute('role', 'status');
    statusNode.style.cssText = 'font-size:14px;font-weight:700;color:#15803d';
    statusNode.textContent = '設定済み';

    row.append(indicator, statusNode);

    detailNode = document.createElement('p');
    detailNode.className = 'clk-group__hint';
    detailNode.style.cssText = 'margin:7px 0 0;line-height:1.6';
    detailNode.textContent = '以前から設定されている共有ノートを使用しています。1秒ごとに自動確認します。';

    group.append(title, row, detailNode);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);

    // Keep the configured-note indicator itself status-only; place the read test
    // in a separate panel and perform a real read against the original note.
    const testGroup = document.createElement('section');
    testGroup.id = 'pcSharedNoteReadTestGroup';
    testGroup.className = 'clk-group';
    testGroup.style.cssText = 'padding:14px;border:1px solid var(--clk-border,rgba(127,127,127,.3));border-radius:14px;margin-top:12px;min-width:0';

    const testTitle = document.createElement('div');
    testTitle.className = 'clk-group__label';
    testTitle.textContent = 'ステップ1：共有ノート読み取りテスト';

    const testDescription = document.createElement('p');
    testDescription.className = 'clk-group__hint';
    testDescription.style.cssText = 'margin:7px 0 0;line-height:1.6';
    testDescription.textContent = '設定済みの共有ノートへ実際に接続し、読み取れるかを確認します。内容の変更・保存は行いません。';

    const testButton = document.createElement('button');
    testButton.id = 'pcSharedNoteReadTestButton';
    testButton.type = 'button';
    testButton.textContent = '読み取りテストを実行';
    testButton.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;margin-top:10px;padding:8px 13px;border:1px solid #2563eb;border-radius:9px;background:#2563eb;color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer';

    const testResult = document.createElement('p');
    testResult.id = 'pcSharedNoteReadTestResult';
    testResult.setAttribute('role', 'status');
    testResult.setAttribute('aria-live', 'polite');
    testResult.style.cssText = 'margin:7px 0 0;font-size:12px;line-height:1.6;opacity:.85';
    testResult.textContent = 'まだテストしていません。';

    testButton.addEventListener('click', async () => {
      const readTest = window.PC_SHARED_NOTE_READ_TEST;
      if (typeof readTest !== 'function') {
        testResult.textContent = '読み取り機能の準備ができていません。ページを再読み込みしてお試しください。';
        return;
      }
      testButton.disabled = true;
      testButton.textContent = '読み取り確認中…';
      testResult.textContent = '以前から設定されている共有ノートへ接続しています…';
      try {
        const result = await readTest();
        const rowCount = Number(result && result.rowCount) || 0;
        const filledRows = Number(result && result.filledRows) || 0;
        testResult.textContent = rowCount
          ? '成功：共有ノートから' + rowCount + '行を読み取りました（入力済み' + filledRows + '行）。'
          : '接続成功：共有ノートを読み取れました。現在、読み取れるデータ行はありません。';
      } catch (error) {
        testResult.textContent = '失敗：共有ノートを読み取れませんでした。' +
          String(error && error.message || error) +
          ' 公開閲覧設定とネットワークを確認してください。';
      } finally {
        testButton.disabled = false;
        testButton.textContent = 'もう一度読み取りテスト';
      }
    });

    testGroup.append(testTitle, testDescription, testButton, testResult);
    pane.insertBefore(testGroup, footnote || null);

    window.addEventListener('pc-shared-note-status', event => {
      updateStatus(event && event.detail);
    });

    window.PC_SHARED_NOTE = Object.freeze({
      configured: SHARED_NOTE_CONFIGURED
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installUI, { once: true });
  } else {
    installUI();
  }
})();