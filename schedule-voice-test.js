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
    button.addEventListener('click', () => {
      if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
        message.textContent = 'このブラウザーは音声読み上げに対応していません。';
        return;
      }
      window.speechSynthesis.cancel();
      const voices = window.speechSynthesis.getVoices();
      const metan = voices.find(v => /四国めたん|四国メタン|Shikoku Metan/i.test(v.name));
      const utterance = new SpeechSynthesisUtterance(TEXT);
      utterance.lang = 'ja-JP';
      utterance.rate = 1;
      if (metan) utterance.voice = metan;
      button.disabled = true;
      button.textContent = '再生中…';
      message.textContent = metan
        ? '四国めたんのブラウザー音声をテストしています。'
        : '四国めたん音声が端末に見つからないため、標準の日本語音声でテストします。';
      utterance.onend = () => {
        button.disabled = false;
        button.textContent = 'もう一度テスト';
        message.textContent = metan
          ? '音声テストが終わりました。'
          : '標準音声のテストが終わりました。端末に四国めたん音声がない場合、API音声とは異なります。';
      };
      utterance.onerror = () => {
        button.disabled = false;
        button.textContent = 'もう一度テスト';
        message.textContent = '音声を再生できませんでした。端末の音量とブラウザー設定を確認してください。';
      };
      window.speechSynthesis.speak(utterance);
    });
    host.append(button, message);
  }
  const observer = new MutationObserver(install);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
