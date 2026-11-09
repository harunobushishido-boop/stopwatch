(() => {
  'use strict';
  const BUTTON_ID = 'pcScheduleVoiceTestButton';

  function install() {
    const host = document.getElementById('pcScheduleAnnouncementStatus');
    if (!host || document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'ステップ2：現在の内容で発表テスト';
    button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;margin-top:9px;padding:8px 13px;border:1px solid #15803d;border-radius:9px;background:#15803d;color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer';

    const message = document.createElement('p');
    message.style.cssText = 'margin:6px 0 0;font-size:12px;line-height:1.6;opacity:.85';
    message.setAttribute('aria-live', 'polite');
    message.textContent = '最新のスプレッドシート情報を読み取り、自動発表と同じ文章を全画面表示・音声で発表します。テストでは発表済み記録は変更しません。';

    button.addEventListener('click', async () => {
      const readAnnouncement = window.PC_SHARED_NOTE_ANNOUNCEMENT_TEST;
      const speak = window.PC_SCHEDULE_SPEAK;
      const showAnnouncement = window.PC_SCHEDULE_SHOW_ANNOUNCEMENT;

      if (typeof readAnnouncement !== 'function' ||
          typeof speak !== 'function' ||
          typeof showAnnouncement !== 'function') {
        message.textContent = 'テスト機能の準備ができていません。ページを再読み込みして、もう一度お試しください。';
        return;
      }

      button.disabled = true;
      button.textContent = '最新情報を読み取り中…';
      message.textContent = '設定済みの共有ノートに接続し、現在入力されている情報を取得しています…';

      try {
        const result = await readAnnouncement();
        const announcement = String(result && result.message || '').trim();
        const row = result && Array.isArray(result.row) ? result.row : null;

        if (!announcement || !row) {
          throw new Error('発表する情報を取得できませんでした。スプレッドシートの入力内容を確認してください。');
        }

        message.textContent = '読み取り成功：現在の入力内容を発表します。画面表示と音声を確認してください。';
        showAnnouncement(announcement, row);

        button.textContent = '音声で発表中…';
        const played = await speak(announcement);
        if (played === false) {
          throw new Error('発表文は取得できましたが、音声を再生できませんでした。ネット接続・API設定・端末の音量を確認してください。');
        }

        message.textContent = '成功：最新のスプレッドシート情報を読み取り、全画面表示と音声で発表しました。テストのため発表済み記録は変更していません。';
      } catch (error) {
        message.textContent = '失敗：' + String(error && error.message || error);
        console.error('Schedule live spreadsheet voice test failed', error);
      } finally {
        button.disabled = false;
        button.textContent = 'もう一度、現在の内容で発表テスト';
      }
    });

    host.append(button, message);
  }

  const observer = new MutationObserver(install);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
