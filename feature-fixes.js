(function () {
  'use strict';
  const ready = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  ready(function () {
    const q = (s, r = document) => r.querySelector(s);
    const qa = (s, r = document) => Array.from(r.querySelectorAll(s));
    const shell = q('.clk-shell');
    const bgApi = window.__clkBgApi;
    const paneList = qa('.clk-panel__pane');
    const bgPane = paneList.find(p => q('.clk-palette-mini-grid', p) && q('#bgB', p));
    const photoPane = q('#bgB', bgPane || document);
    if (!shell) return;

    // Find the actual background pane by content, not its fragile index.
    if (bgPane && photoPane) {
      const topGroup = Array.from(bgPane.children).find(x => q('.clk-segments', x));
      const segments = topGroup ? qa('.clk-segment', topGroup) : [];
      const foot = Array.from(bgPane.children).find(x => x.classList && x.classList.contains('clk-panel__footnote'));
      const paletteParts = Array.from(bgPane.children).filter(x => x !== topGroup && x !== photoPane && x !== foot);
      const setMode = (photo) => {
        if (segments.length >= 2) {
          segments[0].classList.toggle('clk-segment--active', !photo);
          segments[0].setAttribute('aria-pressed', String(!photo));
          segments[1].classList.toggle('clk-segment--active', photo);
          segments[1].setAttribute('aria-pressed', String(photo));
        }
        paletteParts.forEach(x => { x.style.display = photo ? 'none' : ''; });
        photoPane.style.display = photo ? '' : 'none';
        photoPane.setAttribute('aria-hidden', String(!photo));
      };
      document.addEventListener('click', function (e) {
        const b = e.target && e.target.closest ? e.target.closest('.clk-segment') : null;
        if (!b || !bgPane.contains(b) || !topGroup || !topGroup.contains(b)) return;
        const label = (b.textContent || '').replace(/\s/g, '');
        if (label !== '写真・動画' && label !== '配色') return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        setMode(label === '写真・動画');
      }, true);
      setMode(false);
      const input = bgApi && bgApi.bgInput;
      if (input) {
        input.accept = 'image/*,video/mp4,video/webm,video/quicktime,.mov,.m4v';
        input.style.display = 'none'; input.style.position = 'fixed';
        input.style.width = '1px'; input.style.height = '1px';
        input.style.opacity = '0'; input.style.pointerEvents = 'none';
        let add = q('#ghBgAddButton') || q('.clk-bg-thumb--add', photoPane);
        if (add && add.tagName !== 'BUTTON') {
          const btn = document.createElement('button');
          btn.id = 'ghBgAddButton'; btn.type = 'button'; btn.className = add.className;
          btn.setAttribute('aria-label', '背景を追加'); btn.title = '写真または動画を選択';
          btn.innerHTML = add.innerHTML; add.replaceWith(btn); add = btn;
        }
        if (add && !add.dataset.fixClickBound) {
          add.dataset.fixClickBound = '1';
          add.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            try { input.value = ''; input.click(); } catch (_) {}
          });
        }
      }
    }

    // Sample the selected local image/video to choose readable black or white text.
    // Media remains fully opaque (100%).
    const contrastForMedia = () => {
      const media = q('.clk-bg-image') || q('.clk-bg-video');
      if (!media || !bgApi) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 24; canvas.height = 24;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx || (media.tagName === 'IMG' && !media.complete) || (media.tagName === 'VIDEO' && media.readyState < 2)) return;
        ctx.drawImage(media, 0, 0, 24, 24);
        const pixels = ctx.getImageData(0, 0, 24, 24).data;
        let total = 0, count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          total += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
          count++;
        }
        const luminance = total / Math.max(1, count);
        const color = luminance > 145 ? '#000000' : '#FFFFFF';
        bgApi.fgAuto = true;
        if (typeof bgApi.setForeground === 'function') bgApi.setForeground(color, true, null);
        else if (typeof bgApi.applyAutoForeground === 'function') bgApi.applyAutoForeground();
        shell.classList.toggle('clk-shell--light', luminance > 145);
        shell.classList.add('clk-shell--auto-media');
      } catch (_) {
        try { bgApi.fgAuto = true; bgApi.applyAutoForeground(); } catch (_) {}
      }
    };
    const bindMedia = () => {
      const media = q('.clk-bg-image') || q('.clk-bg-video');
      if (!media || media.dataset.contrastFixBound) return;
      media.dataset.contrastFixBound = '1';
      ['load', 'loadeddata', 'canplay', 'seeked'].forEach(ev => media.addEventListener(ev, () => setTimeout(contrastForMedia, 80)));
      setTimeout(contrastForMedia, 120);
    };
    bindMedia();
    const bgRoot = q('.clk-bg');
    if (bgRoot && 'MutationObserver' in window) {
      new MutationObserver(() => { bindMedia(); setTimeout(contrastForMedia, 100); })
        .observe(bgRoot, { childList: true, subtree: true });
    }

    // Cleaning analysis is black by default, independent of the theme.
    const style = document.createElement('style');
    style.id = 'pc-cleaning-analysis-default-black';
    style.textContent = '#timeAnalysisRoot,#timeAnalysisRoot *{color:#000!important}.clk-bg-image,.clk-bg-video{opacity:1!important}';
    document.head.appendChild(style);

    // Stop audio files, environmental sounds and YouTube when the sleep deadline passes.
    const stopEverything = () => {
      try { if (window.__clkMusicApi && typeof window.__clkMusicApi.stopPlayback === 'function') window.__clkMusicApi.stopPlayback(); } catch (_) {}
      qa('audio').forEach(el => { try { el.pause(); el.currentTime = 0; } catch (_) {} });
      qa('video:not(.clk-bg-video)').forEach(el => { try { el.pause(); el.currentTime = 0; } catch (_) {} });
      qa('iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"]').forEach(el => { try { el.src = 'about:blank'; } catch (_) {} });
      const yt = q('#ytf');
      if (yt) { yt.replaceChildren(); yt.style.display = 'none'; }
      const status = q('#pcMusicSleepStatus');
      if (status) status.textContent = '再生を停止しました';
    };
    const checkSleepDeadline = () => {
      let end = 0;
      try { end = Number(localStorage.getItem('pc-music-sleep-end') || 0); } catch (_) {}
      if (end && Date.now() >= end) {
        stopEverything();
        try { localStorage.removeItem('pc-music-sleep-end'); } catch (_) {}
      }
    };
    window.addEventListener('pageshow', checkSleepDeadline);
    document.addEventListener('visibilitychange', checkSleepDeadline);
    window.addEventListener('focus', checkSleepDeadline);
    setInterval(checkSleepDeadline, 5000);

    const prev = q('#pcBgPrevious');
    if (prev) {
      prev.className = 'clk-todo-form__add';
      prev.style.cssText = 'margin-top:8px;max-width:100%;white-space:normal';
    }
    // Enforce the 12-item limit without ever storing image/video bytes.
    try {
      const key = 'pc-bg-favs-v1';
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(list)) localStorage.setItem(key, JSON.stringify(list.filter(x => x && typeof x.bg === 'string' && typeof x.fg === 'string' && typeof x.accent === 'string').slice(-12)));
    } catch (_) {}
  });
})();