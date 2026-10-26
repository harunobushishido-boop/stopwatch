(() => {
  'use strict';
  const BUTTON_ID = 'pcScheduleVoiceTestButton';
  const TEXT = '明日の持ち物は家庭学習カードです。';
  function install() {
    const host = document.getElementById('pcScheduleAnnouncementStatus');
    if (!host || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '音声テスト';
    button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;margin-top:9px;padding:8px 13px;border:1px solid #15803d;border-radius:9px;background:#15803d;color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer';
    const message = document.createElement('p');
    message.style.cssText = 'margin:6px 0 0;font-size:12px;opacity:.8';
    message.setAttribute('aria-live', 'polite');
    button.addEventListener('click', async () => {
      const speak = window.PC_SCHEDULE_SPEAK;
      if (typeof speak !== 'function') {
        message.textContent = '音声APIの準備ができていません。ページを再読み込みして、もう一度お試しください。';
        return;
      }
      button.disabled = true;
      button.textContent = '再生中…';
      let hasFastKey = false;
      try { hasFastKey = Boolean(String(localStorage.getItem('pc-voicevox-fast-api-key-v1') || '').trim()); } catch (error) {}
      message.textContent = hasFastKey
        ? 'WEB版VOICEVOX 高速API（四国めたん）を準備しています…'
        : 'WEB版VOICEVOX API（低速・四国めたん）を準備しています…';
      try {
        await speak(TEXT);
        const status = document.getElementById('pcScheduleAnnouncementStatus');
        const detail = status ? status.innerText.replace(/^授業時間数に合わせた音声発表\s*/, '').trim() : '';
        message.textContent = '音声テストが終わりました。' + (detail ? ' ' + detail : '');
      } catch (error) {
        message.textContent = '音声を再生できませんでした。API接続と音量を確認してください。';
        console.error('Schedule voice test failed', error);
      } finally {
        button.disabled = false;
        button.textContent = 'もう一度テスト';
      }
    });
    host.append(button, message);
  }
  const observer = new MutationObserver(install);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
