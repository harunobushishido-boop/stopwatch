(() => {
  'use strict';

  // This app uses the original, preconfigured shared note.
  // No note creation, export, editing, or share-link generation is provided here.
  const SHARED_NOTE_CONFIGURED = true;
  let statusNode = null;
  let detailNode = null;

  function updateStatus(detail) {
    if (!statusNode) return;
    if (!detail || detail.ok !== false) {
      statusNode.textContent = '設定済み';
      statusNode.style.color = '#15803d';
      if (detailNode) {
        detailNode.textContent = detail && detail.checkedAt
          ? '既存の共有ノートを確認済みです。1秒ごとに自動確認しています。'
          : '既存の共有ノートを使用しています。1秒ごとに自動確認します。';
      }
      return;
    }

    statusNode.textContent = '設定済み・接続確認中';
    statusNode.style.color = '#b45309';
    if (detailNode) {
      detailNode.textContent = '共有ノートの読み取りを確認できません。元の共有ノートの公開閲覧設定とネットワークを確認してください。';
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