/* Consolidated feature repairs v4 — one controller for media tabs, palettes and sleep playback. */
(function () {
  'use strict';
  const ready = function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  ready(function () {
    const q = function (selector, root) { return (root || document).querySelector(selector); };
    const all = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
    const safeRead = function (key, fallback) {
      try { const value = localStorage.getItem(key); return value == null ? fallback : value; } catch (_) { return fallback; }
    };
    const safeWrite = function (key, value) { try { localStorage.setItem(key, value); } catch (_) {} };
    const shell = q('.clk-shell');
    const api = window.__clkBgApi;
    const panes = all('.clk-panel__pane');
    if (!shell) return;

    /* Photo / video tab: remove the nested duplicate tabs and keep one working switch. */
    const bgPane = panes.find(function (pane) { return q('.clk-palette-mini-grid', pane) && q('#bgB', pane); });
    const photoPane = bgPane && q('#bgB', bgPane);
    let photoTabs = [];
    let setPhotoMode = function () {};
    if (bgPane && photoPane) {
      const nestedTabs = q('.clk-segments', photoPane);
      if (nestedTabs) {
        const nestedGroup = nestedTabs.closest('.clk-group');
        if (nestedGroup) nestedGroup.remove();
      }
      const tabGroup = Array.from(bgPane.children).find(function (child) {
        return child !== photoPane && q('.clk-segments', child);
      });
      photoTabs = tabGroup ? all('.clk-segment', tabGroup).filter(function (button) {
        const label = (button.textContent || '').replace(/\s/g, '');
        return label === '配色' || label === '写真・動画';
      }) : [];
      const footnotes = Array.from(bgPane.children).filter(function (child) {
        return child.classList && child.classList.contains('clk-panel__footnote');
      });
      const paletteParts = Array.from(bgPane.children).filter(function (child) {
        return child !== tabGroup && child !== photoPane && !footnotes.includes(child);
      });
      setPhotoMode = function (photo) {
        photoTabs.forEach(function (button) {
          const isPhoto = (button.textContent || '').replace(/\s/g, '') === '写真・動画';
          button.classList.toggle('clk-segment--active', isPhoto === photo);
          button.setAttribute('aria-pressed', String(isPhoto === photo));
        });
        paletteParts.forEach(function (part) {
          if (photo) part.style.setProperty('display', 'none', 'important');
          else part.style.removeProperty('display');
        });
        photoPane.style.setProperty('display', photo ? 'block' : 'none', 'important');
        photoPane.setAttribute('aria-hidden', String(!photo));
        bgPane.dataset.backgroundMode = photo ? 'photo' : 'palette';
      };

      const fileInput = (api && api.bgInput) || q('input[type="file"]', photoPane);
      if (fileInput) {
        fileInput.accept = 'image/*,video/mp4,video/webm,video/quicktime,.mov,.m4v';
        fileInput.style.cssText = 'position:fixed!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;display:block!important';
        fileInput.dataset.pcMediaInputV4 = '1';
        let addButton = q('#ghBgAddButton', photoPane) || q('.clk-bg-thumb--add', photoPane);
        if (addButton && addButton.tagName !== 'BUTTON') {
          const button = document.createElement('button');
          button.type = 'button';
          button.id = 'ghBgAddButton';
          button.className = addButton.className;
          button.setAttribute('aria-label', '背景を追加');
          button.title = '写真または動画を選択';
          button.innerHTML = addButton.innerHTML;
          addButton.replaceWith(button);
          addButton = button;
        }
        fileInput.addEventListener('change', function () {
          if (fileInput.files && fileInput.files.length) setPhotoMode(true);
        });
      }
      document.addEventListener('click', function (event) {
        const tab = event.target && event.target.closest && event.target.closest('.clk-segment');
        if (tab && photoTabs.includes(tab)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setPhotoMode((tab.textContent || '').replace(/\s/g, '') === '写真・動画');
          return;
        }
        const add = event.target && event.target.closest && event.target.closest('#ghBgAddButton,.clk-bg-thumb--add');
        if (add && photoPane.contains(add)) {
          const input = (api && api.bgInput) || q('input[type="file"]', photoPane);
          if (!input) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          setPhotoMode(true);
          try { input.value = ''; input.click(); } catch (error) { console.warn('背景ファイルを開けませんでした。', error); }
        }
      }, true);
      setPhotoMode(false);
    }

    /* Media stays fully opaque. Respect manual text colors; only refresh auto contrast when auto is enabled. */
    const mediaStyle = document.createElement('style');
    mediaStyle.id = 'pc-feature-fixes-v4-style';
    mediaStyle.textContent =
      '.clk-bg-image,.clk-bg-video{opacity:1!important;object-fit:cover!important;z-index:1!important}' +
      '.clk-bg-overlay{background:transparent!important;opacity:1!important;pointer-events:none!important}' +
      '.clk-bg{background:transparent!important}' +
      '.clk-shell--auto-media .clk-time,.clk-shell--auto-media .clk-time__seconds,.clk-shell--auto-media .clk-date,.clk-shell--auto-media .clk-timer-circle__center,.clk-shell--auto-media .clk-sw-stage__time,.clk-shell--auto-media .clk-row{text-shadow:0 1px 4px rgba(0,0,0,.72),0 0 8px rgba(0,0,0,.35)!important;-webkit-text-stroke:0!important}' +
      '#timeAnalysisRoot,#timeAnalysisRoot *{color:#000!important}' +
      '#timeAnalysisRoot .gh-ta-btn-primary,#timeAnalysisRoot .gh-ta-btn-primary *,#timeAnalysisRoot button[type="submit"],#timeAnalysisRoot button[type="submit"] *{color:#fff!important}';
    if (!q('#pc-feature-fixes-v4-style')) document.head.appendChild(mediaStyle);

    const refreshMediaContrast = function () {
      if (api && api.fgAuto === true && typeof api.applyAutoForeground === 'function') {
        try { api.applyAutoForeground(); } catch (_) {}
      }
    };
    const fixMedia = function (media) {
      if (!(media instanceof HTMLImageElement) && !(media instanceof HTMLVideoElement)) return;
      media.style.setProperty('opacity', '1', 'important');
      media.style.setProperty('z-index', '1', 'important');
      media.style.setProperty('object-fit', 'cover', 'important');
      media.style.setProperty('width', '100%', 'important');
      media.style.setProperty('height', '100%', 'important');
      if (media.dataset.pcMediaContrastV4) return;
      media.dataset.pcMediaContrastV4 = '1';
      ['load', 'loadeddata', 'canplay', 'seeked'].forEach(function (name) {
        media.addEventListener(name, function () { window.setTimeout(refreshMediaContrast, 50); });
      });
      window.setTimeout(refreshMediaContrast, 100);
    };
    const background = q('.clk-bg');
    if (background) {
      all('.clk-bg-image,.clk-bg-video', background).forEach(fixMedia);
      if ('MutationObserver' in window) {
        new MutationObserver(function (records) {
          records.forEach(function (record) {
            record.addedNodes.forEach(function (node) {
              if (node.nodeType !== 1) return;
              fixMedia(node);
              all('.clk-bg-image,.clk-bg-video', node).forEach(fixMedia);
            });
          });
        }).observe(background, { childList: true, subtree: true });
      }
    }

    /* Save only background/text/accent colors. Uploaded images and videos are never included. */
    const FAV_KEY = 'pc-bg-favs-v1';
    const PREV_KEY = 'pc-bg-prev-v1';
    const PRESET_KEY = 'pc-bg-preset-v1';
    const validColor = function (value) {
      if (typeof value !== 'string' || !value.trim()) return false;
      try { return CSS.supports('color', value); } catch (_) { return /^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\(/i.test(value); }
    };
    const colorValue = function (variable, fallback) {
      const value = getComputedStyle(shell).getPropertyValue(variable).trim();
      return validColor(value) ? value : fallback;
    };
    const colorSnapshot = function () {
      return {
        bg: colorValue('--clk-bg', '#F4EFE3'),
        fg: colorValue('--clk-fg', '#000000'),
        accent: colorValue('--clk-accent', '#F59E0B'),
        fgAuto: false
      };
    };
    const isLightColor = function (value) {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;color:' + value;
      document.body.appendChild(probe);
      const match = getComputedStyle(probe).color.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
      probe.remove();
      if (!match) return true;
      const channels = [Number(match[1]), Number(match[2]), Number(match[3])].map(function (channel) {
        channel /= 255;
        return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.5;
    };
    const readFavorites = function () {
      try {
        const list = JSON.parse(safeRead(FAV_KEY, '[]'));
        if (!Array.isArray(list)) return [];
        return list.filter(function (item) {
          return item && validColor(item.bg) && validColor(item.fg) && validColor(item.accent);
        }).slice(-12).map(function (item, index) {
          return {
            name: String(item.name || 'お気に入り ' + (index + 1)).slice(0, 40),
            bg: item.bg, fg: item.fg, accent: item.accent, fgAuto: false
          };
        });
      } catch (_) { return []; }
    };
    const writeFavorites = function (list) {
      const cleaned = list.filter(function (item) {
        return item && validColor(item.bg) && validColor(item.fg) && validColor(item.accent);
      }).slice(-12).map(function (item) {
        return {
          name: String(item.name || '').slice(0, 40),
          bg: item.bg, fg: item.fg, accent: item.accent, fgAuto: false
        };
      });
      safeWrite(FAV_KEY, JSON.stringify(cleaned));
      return cleaned;
    };
    const savePrevious = function () { safeWrite(PREV_KEY, JSON.stringify(colorSnapshot())); };
    const setStatus = function (message) {
      const group = q('#pcBgFavGroup', bgPane || document);
      if (!group) return;
      let status = q('#pcBgFavStatus', group);
      if (!status) {
        status = document.createElement('p');
        status.id = 'pcBgFavStatus';
        status.className = 'clk-group__hint';
        status.setAttribute('aria-live', 'polite');
        group.appendChild(status);
      }
      status.textContent = message;
    };
    const clearSavedBackground = function () {
      try {
        if (!('indexedDB' in window)) return;
        const request = indexedDB.open('concentrated-clock-v1', 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains('background')) request.result.createObjectStore('background');
        };
        request.onsuccess = function () {
          const db = request.result;
          if (!db.objectStoreNames.contains('background')) { db.close(); return; }
          try {
            const tx = db.transaction('background', 'readwrite');
            tx.objectStore('background').delete('current');
            tx.oncomplete = function () { db.close(); };
            tx.onerror = function () { db.close(); };
          } catch (_) { db.close(); }
        };
        request.onerror = function () {};
      } catch (_) {}
    };
    const applyColorSnapshot = function (snapshot) {
      if (!snapshot || !validColor(snapshot.bg) || !validColor(snapshot.fg) || !validColor(snapshot.accent)) return false;
      try { if (api && typeof api.clearMedia === 'function') api.clearMedia(); } catch (_) {}
      safeWrite(PRESET_KEY, '');
      clearSavedBackground();
      shell.style.setProperty('--clk-bg', snapshot.bg);
      shell.style.setProperty('--clk-bg-base', snapshot.bg);
      shell.style.setProperty('--clk-accent', snapshot.accent);
      shell.style.setProperty('--clk-accent-base', snapshot.accent);
      const surface = q('.clk-bg-palette', background || document);
      if (surface) surface.style.backgroundColor = snapshot.bg;
      if (api) {
        api.fgAuto = false;
        if (typeof api.setForeground === 'function') api.setForeground(snapshot.fg, false, null);
        else shell.style.setProperty('--clk-fg', snapshot.fg);
      } else {
        shell.style.setProperty('--clk-fg', snapshot.fg);
        shell.style.setProperty('--clk-fg-base', snapshot.fg);
      }
      shell.classList.remove('clk-shell--media', 'clk-shell--auto-media');
      shell.classList.toggle('clk-shell--light', isLightColor(snapshot.bg));
      if (bgPane) {
        all('.clk-palette-mini:not(.clk-palette-mini--special)', bgPane).forEach(function (button) {
          const chosen = button.style.backgroundColor && button.style.backgroundColor.toLowerCase() === snapshot.bg.toLowerCase();
          button.classList.toggle('clk-palette-mini--active', !!chosen);
          button.setAttribute('aria-pressed', String(!!chosen));
        });
      }
      try { if (window.__clkSaveTheme) window.__clkSaveTheme(); } catch (_) {}
      return true;
    };

    let favGroup = bgPane && q('#pcBgFavGroup', bgPane);
    const paletteGroup = bgPane && q('.clk-palette-mini-grid', bgPane) && q('.clk-palette-mini-grid', bgPane).closest('.clk-group');
    if (bgPane && paletteGroup && !favGroup) {
      favGroup = document.createElement('div');
      favGroup.id = 'pcBgFavGroup';
      favGroup.className = 'clk-group';
      favGroup.innerHTML = '<span class="clk-group__label">お気に入り</span><button id="pcBgFavSave" type="button" class="clk-todo-form__add">今の背景・文字色・アクセント色を保存</button><div class="pc-bg-fav-list"></div><div class="clk-group__hint">最大12件。保存するのは色の組み合わせで、アップロード画像そのものは含みません。</div>';
      paletteGroup.after(favGroup);
    }
    if (favGroup) {
      if (!q('#pcBgFavSave', favGroup)) {
        const saveButton = document.createElement('button');
        saveButton.id = 'pcBgFavSave'; saveButton.type = 'button'; saveButton.className = 'clk-todo-form__add';
        saveButton.textContent = '今の背景・文字色・アクセント色を保存';
        favGroup.appendChild(saveButton);
      }
      if (!q('.pc-bg-fav-list', favGroup)) {
        const list = document.createElement('div'); list.className = 'pc-bg-fav-list'; favGroup.appendChild(list);
      }
      if (!q('#pcBgPrevious', favGroup)) {
        const previous = document.createElement('button');
        previous.id = 'pcBgPrevious'; previous.type = 'button'; previous.className = 'clk-todo-form__add';
        previous.textContent = 'ひとつ前の配色に戻す'; previous.style.marginTop = '8px';
        favGroup.appendChild(previous);
      }
    }

    const renderFavorites = function () {
      if (!favGroup) return;
      const list = q('.pc-bg-fav-list', favGroup);
      if (!list) return;
      list.replaceChildren();
      readFavorites().forEach(function (favorite, index) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px;min-width:0';
        const apply = document.createElement('button');
        apply.type = 'button'; apply.className = 'clk-todo-form__add';
        apply.dataset.pcFavoriteApply = String(index);
        apply.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left';
        const chip = document.createElement('span');
        chip.style.cssText = 'width:18px;height:18px;border-radius:5px;flex:none;background:' + favorite.bg + ';border:1px solid #0002';
        chip.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = favorite.name;
        label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        apply.append(chip, label);
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'clk-todo-form__add';
        remove.textContent = '削除'; remove.dataset.pcFavoriteDelete = String(index);
        row.append(apply, remove);
        list.appendChild(row);
      });
    };
    writeFavorites(readFavorites());
    renderFavorites();

    /* Palette changes are recorded before the original app handler changes CSS variables. */
    document.addEventListener('click', function (event) {
      const target = event.target && event.target.closest && event.target.closest('.clk-palette-mini:not(.clk-palette-mini--special),.clk-color-swatch,.clk-bg-thumb[data-preset-name]');
      if (target && (bgPane ? bgPane.contains(target) : shell.contains(target))) {
        savePrevious();
        if (target.matches('.clk-palette-mini:not(.clk-palette-mini--special)')) safeWrite(PRESET_KEY, '');
      }

      const saveButton = event.target && event.target.closest && event.target.closest('#pcBgFavSave');
      if (saveButton && favGroup && favGroup.contains(saveButton)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const list = readFavorites();
        const snapshot = colorSnapshot();
        snapshot.name = 'お気に入り ' + (list.length + 1);
        list.push(snapshot);
        writeFavorites(list);
        renderFavorites();
        setStatus('現在の配色を保存しました。画像・動画ファイルは保存されません。');
        return;
      }

      const previousButton = event.target && event.target.closest && event.target.closest('#pcBgPrevious');
      if (previousButton && favGroup && favGroup.contains(previousButton)) {
        event.preventDefault(); event.stopImmediatePropagation();
        let previous = null;
        try { previous = JSON.parse(safeRead(PREV_KEY, 'null')); } catch (_) {}
        if (!previous || !validColor(previous.bg) || !validColor(previous.fg) || !validColor(previous.accent)) {
          setStatus('戻せる配色がまだありません。先に配色を変更してください。');
          return;
        }
        savePrevious();
        if (applyColorSnapshot(previous)) setStatus('ひとつ前の配色に戻しました。');
        return;
      }

      const applyButton = event.target && event.target.closest && event.target.closest('[data-pc-favorite-apply]');
      const deleteButton = event.target && event.target.closest && event.target.closest('[data-pc-favorite-delete]');
      if ((applyButton || deleteButton) && favGroup && favGroup.contains(applyButton || deleteButton)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const list = readFavorites();
        const index = Number(applyButton ? applyButton.dataset.pcFavoriteApply : deleteButton.dataset.pcFavoriteDelete);
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
        if (deleteButton) {
          list.splice(index, 1);
          writeFavorites(list); renderFavorites(); setStatus('お気に入りを削除しました。');
        } else {
          savePrevious();
          if (applyColorSnapshot(list[index])) setStatus(list[index].name + 'を適用しました。');
        }
      }
    }, true);

    document.addEventListener('input', function (event) {
      const target = event.target;
      if (target && target.matches && target.matches('.clk-color-swatch__input')) savePrevious();
    }, true);

    /* Sleep timer: one deadline controls the file player, ambient sounds and YouTube. */
    const SLEEP_KEY = 'pc-music-sleep-end';
    const musicPane = panes.find(function (pane) { return q('#ytf', pane) || q('[data-yt-play]', pane); }) || panes[3];
    let sleepGroup = musicPane && q('#pcMusicSleepGroup', musicPane);
    if (musicPane && !sleepGroup) {
      sleepGroup = document.createElement('div');
      sleepGroup.id = 'pcMusicSleepGroup'; sleepGroup.className = 'clk-group';
      sleepGroup.innerHTML = '<span class="clk-group__label">おやすみタイマー</span><div class="clk-group__hint">選んだ時間がたつと、音楽ファイル・環境音・YouTubeの再生を停止します。</div><div class="clk-segments" id="pcMusicSleepOptions" data-cols="6"></div><p id="pcMusicSleepStatus" class="clk-group__hint" aria-live="polite">オフ</p>';
      const choices = [['オフ', 0], ['15分', 15], ['30分', 30], ['45分', 45], ['60分', 60], ['90分', 90]];
      const optionBox = q('#pcMusicSleepOptions', sleepGroup);
      choices.forEach(function (choice, index) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'clk-segment' + (index === 0 ? ' clk-segment--active' : '');
        button.dataset.minutes = String(choice[1]); button.textContent = choice[0]; optionBox.appendChild(button);
      });
      const footnote = q('.clk-panel__footnote', musicPane);
      musicPane.insertBefore(sleepGroup, footnote || null);
    }
    const optionBox = sleepGroup && q('#pcMusicSleepOptions', sleepGroup);
    const status = sleepGroup && q('#pcMusicSleepStatus', sleepGroup);
    const stopPlaybackEverything = function () {
      try { window.__clkMusicApi && window.__clkMusicApi.stopPlayback && window.__clkMusicApi.stopPlayback(); } catch (_) {}
      try { window.__clkStopBuiltInSounds && window.__clkStopBuiltInSounds(); } catch (_) {}
      all('audio,video:not(.clk-bg-video)').forEach(function (media) {
        try { media.pause(); media.currentTime = 0; } catch (_) {}
      });
      all('iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"],#ytf iframe').forEach(function (frame) {
        try { frame.src = 'about:blank'; } catch (_) {}
      });
      const youtube = q('#ytf');
      if (youtube) { youtube.replaceChildren(); youtube.style.display = 'none'; }
      safeWrite(SLEEP_KEY, '');
      if (status) status.textContent = '再生を停止しました';
      if (optionBox) all('.clk-segment', optionBox).forEach(function (button) {
        button.classList.toggle('clk-segment--active', Number(button.dataset.minutes) === 0);
      });
    };
    const enforceSleep = function () {
      const end = Number(safeRead(SLEEP_KEY, '0'));
      if (end && Date.now() >= end) stopPlaybackEverything();
    };
    if (optionBox) {
      document.addEventListener('click', function (event) {
        const button = event.target && event.target.closest && event.target.closest('#pcMusicSleepOptions .clk-segment');
        if (!button || !optionBox.contains(button)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const minutes = Math.max(0, Number(button.dataset.minutes) || 0);
        all('.clk-segment', optionBox).forEach(function (item) {
          item.classList.toggle('clk-segment--active', item === button);
          item.setAttribute('aria-pressed', String(item === button));
        });
        if (!minutes) {
          safeWrite(SLEEP_KEY, '');
          if (status) status.textContent = 'オフ';
          return;
        }
        safeWrite(SLEEP_KEY, String(Date.now() + minutes * 60000));
        if (status) status.textContent = button.textContent + '後に停止';
      }, true);
    }
    const storedEnd = Number(safeRead(SLEEP_KEY, '0'));
    if (storedEnd > Date.now()) {
      if (status) status.textContent = '残り約' + Math.ceil((storedEnd - Date.now()) / 60000) + '分';
      if (optionBox) {
        const closest = all('.clk-segment', optionBox).filter(function (button) { return Number(button.dataset.minutes) > 0; })
          .sort(function (a, b) {
            return Math.abs(Number(a.dataset.minutes) * 60000 - (storedEnd - Date.now())) - Math.abs(Number(b.dataset.minutes) * 60000 - (storedEnd - Date.now()));
          })[0];
        if (closest) all('.clk-segment', optionBox).forEach(function (button) {
          button.classList.toggle('clk-segment--active', button === closest);
          button.setAttribute('aria-pressed', String(button === closest));
        });
      }
    } else if (storedEnd) safeWrite(SLEEP_KEY, '');
    window.setInterval(enforceSleep, 1000);
    window.addEventListener('pageshow', enforceSleep);
    window.addEventListener('focus', enforceSleep);
    document.addEventListener('visibilitychange', enforceSleep);
  });
})();