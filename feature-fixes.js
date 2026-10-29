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
      // A consolidated tab handler is bound after this legacy setup.
      setMode(false);
      const input = bgApi && bgApi.bgInput;
      if (input) {
        input.accept = 'image/*,video/mp4,video/webm,video/quicktime,.mov,.m4v';
        input.style.cssText = 'position:fixed!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;display:block!important';
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

    // The unified media contrast handler below uses the app's own sampler.
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

/* Consolidated repairs v2. */
(function () {
  'use strict';
  const ready = fn => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn, {once:true}) : fn();
  ready(function () {
    const q=(s,r=document)=>r.querySelector(s), all=(s,r=document)=>Array.from(r.querySelectorAll(s));
    const shell=q('.clk-shell'), api=window.__clkBgApi, bg=q('.clk-bg');
    const pane=all('.clk-panel__pane').find(p=>q('.clk-palette-mini-grid',p)&&q('#bgB',p));
    const photoPane=pane&&q('#bgB',pane), PREV='pc-bg-prev-v1', FAV='pc-bg-favs-v1';

    function validColor(v){try{return typeof v==='string'&&!!CSS.supports('color',v)}catch(_){return /^#[0-9a-f]{3,8}$/i.test(v||'')||/^rgba?\(/i.test(v||'')}}
    function rgb(v){const el=document.createElement('span');el.style.color=v||'#000';el.style.position='fixed';el.style.visibility='hidden';document.body.appendChild(el);const m=getComputedStyle(el).color.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);el.remove();return m?[+m[1],+m[2],+m[3]]:[244,239,227]}
    function lum(v){return rgb(v).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0)}
    function theme(){const s=getComputedStyle(shell);return {bg:s.getPropertyValue('--clk-bg').trim()||'#F4EFE3',fg:s.getPropertyValue('--clk-fg').trim()||'#000000',accent:s.getPropertyValue('--clk-accent').trim()||'#F59E0B',fgAuto:!!(api&&api.fgAuto)}}
    function savePrevious(){try{localStorage.setItem(PREV,JSON.stringify(theme()))}catch(_){}}
    function applyTheme(t){if(!shell||!t)return;const b=validColor(t.bg)?t.bg:'#F4EFE3',a=validColor(t.accent)?t.accent:'#F59E0B',f=validColor(t.fg)?t.fg:'#000000';try{api&&api.clearMedia&&api.clearMedia()}catch(_){}shell.style.setProperty('--clk-bg',b);shell.style.setProperty('--clk-bg-base',b);shell.style.setProperty('--clk-accent',a);shell.style.setProperty('--clk-accent-base',a);const surf=q('.clk-bg-palette',bg);if(surf)surf.style.backgroundColor=b;const automatic=false;if(api){api.fgAuto=false;if(api.setForeground)api.setForeground(f,false,null)}else shell.style.setProperty('--clk-fg',f);shell.classList.remove('clk-shell--media','clk-shell--auto-media');shell.classList.toggle('clk-shell--light',lum(b)>.5);if(pane)all('.clk-palette-mini:not(.clk-palette-mini--special)',pane).forEach(x=>{const on=rgb(x.style.backgroundColor).join(',')===rgb(b).join(',');x.classList.toggle('clk-palette-mini--active',on);x.setAttribute('aria-pressed',String(on))});try{window.__clkSaveTheme&&window.__clkSaveTheme()}catch(_){}}
    function readFavs(){try{const v=JSON.parse(localStorage.getItem(FAV)||'[]');return Array.isArray(v)?v.filter(x=>x&&validColor(x.bg)&&validColor(x.accent)).map((x,i)=>({name:String(x.name||'お気に入り '+(i+1)).slice(0,40),bg:x.bg,fg:validColor(x.fg)?x.fg:'#000000',accent:x.accent,fgAuto:x.fgAuto===true})).slice(-12):[]}catch(_){return []}}
    function writeFavs(v){const out=v.filter(x=>x&&validColor(x.bg)&&validColor(x.fg)&&validColor(x.accent)).slice(-12).map(x=>({name:String(x.name||''),bg:x.bg,fg:x.fg,accent:x.accent,fgAuto:x.fgAuto===true}));try{localStorage.setItem(FAV,JSON.stringify(out))}catch(_){}return out}
    function status(msg){const g=q('#pcBgFavGroup');if(!g)return;let p=q('#pcBgFavStatus',g);if(!p){p=document.createElement('p');p.id='pcBgFavStatus';p.className='clk-group__hint';p.setAttribute('aria-live','polite');g.appendChild(p)}p.textContent=msg}
    function renderFavs(){const l=q('#pcBgFavGroup .pc-bg-fav-list');if(!l)return;l.replaceChildren();writeFavs(readFavs()).forEach((f,i)=>{const row=document.createElement('div');row.style.cssText='display:flex;gap:6px;align-items:center;margin-top:6px;min-width:0';const apply=document.createElement('button');apply.type='button';apply.className='clk-todo-form__add';apply.dataset.favoriteIndex=String(i);apply.style.cssText='display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left';const chip=document.createElement('span');chip.style.cssText='width:18px;height:18px;border-radius:5px;flex:none;background:'+f.bg+';border:1px solid #0002';chip.setAttribute('aria-hidden','true');const label=document.createElement('span');label.textContent=f.name;label.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';apply.append(chip,label);const del=document.createElement('button');del.type='button';del.className='clk-todo-form__add';del.dataset.favoriteDelete=String(i);del.textContent='削除';row.append(apply,del);l.appendChild(row)})}

    // Remove duplicate tab buttons inside the initially hidden media pane; capture clicks only once.
    if(pane&&photoPane){
      all('.clk-segments',photoPane).forEach(g=>{const names=all('.clk-segment',g).map(b=>(b.textContent||'').replace(/\s/g,''));if(names.includes('配色')&&names.includes('写真・動画'))g.closest('.clk-group')?.remove()});
      const tabsGroup=all('.clk-segments',pane).find(g=>{if(photoPane.contains(g))return false;const names=all('.clk-segment',g).map(b=>(b.textContent||'').replace(/\s/g,''));return names.includes('配色')&&names.includes('写真・動画')});
      const tabBox=tabsGroup&&(tabsGroup.closest('.clk-group')||tabsGroup),tabs=tabsGroup?all('.clk-segment',tabsGroup).filter(b=>['配色','写真・動画'].includes((b.textContent||'').replace(/\s/g,''))):[];
      const parts=Array.from(pane.children).filter(x=>x!==tabBox&&x!==photoPane&&!(x.classList&&x.classList.contains('clk-panel__footnote'))),displays=new Map(parts.map(x=>[x,x.style.display]));
      function setMode(photo){tabs.forEach(b=>{const yes=(b.textContent||'').replace(/\s/g,'')==='写真・動画';b.classList.toggle('clk-segment--active',yes===photo);b.setAttribute('aria-pressed',String(yes===photo))});parts.forEach(x=>{if(photo)x.style.setProperty('display','none','important');else if(displays.get(x))x.style.setProperty('display',displays.get(x));else x.style.removeProperty('display')});if(photo)photoPane.style.setProperty('display','block','important');else photoPane.style.setProperty('display','none','important');photoPane.setAttribute('aria-hidden',String(!photo));pane.dataset.backgroundMode=photo?'photo':'palette'}
      document.addEventListener('click',e=>{const b=e.target&&e.target.closest&&e.target.closest('.clk-segment');if(b&&tabs.includes(b)){e.preventDefault();e.stopImmediatePropagation();setMode((b.textContent||'').replace(/\s/g,'')==='写真・動画');return}const add=e.target&&e.target.closest&&e.target.closest('#ghBgAddButton,.clk-bg-thumb--add');if(add&&photoPane.contains(add)){const input=(api&&api.bgInput)||q('input[type=file]',photoPane);if(!input)return;e.preventDefault();e.stopImmediatePropagation();setMode(true);try{input.value='';input.click()}catch(err){console.warn(err)}}},true);
      setMode(false);
      const input=(api&&api.bgInput)||q('input[type=file]',photoPane);
      if(input){input.accept='image/*,video/mp4,video/webm,video/quicktime,.mov,.m4v';input.style.cssText='position:fixed!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;display:block!important';const add=q('#ghBgAddButton',photoPane)||q('.clk-bg-thumb--add',photoPane);if(add&&add.tagName!=='BUTTON'){const b=document.createElement('button');b.type='button';b.id='ghBgAddButton';b.className=add.className;b.setAttribute('aria-label','背景を追加');b.title='写真または動画を選択';b.innerHTML=add.innerHTML;add.replaceWith(b)}input.addEventListener('change',()=>setMode(true))}
    }

    const css=document.createElement('style');css.id='pc-feature-fixes-style-v2';css.textContent='.clk-bg-image,.clk-bg-video{opacity:1!important;object-fit:cover!important}.clk-bg-overlay{background:transparent!important;opacity:1!important;pointer-events:none!important}.clk-bg{background:transparent!important}.clk-shell--auto-media .clk-time,.clk-shell--auto-media .clk-time__seconds,.clk-shell--auto-media .clk-date,.clk-shell--auto-media .clk-timer-circle__center,.clk-shell--auto-media .clk-sw-stage__time,.clk-shell--auto-media .clk-row{text-shadow:0 1px 4px rgba(0,0,0,.72),0 0 8px rgba(0,0,0,.35)!important;-webkit-text-stroke:0!important}#timeAnalysisRoot,#timeAnalysisRoot *{color:#000!important}#timeAnalysisRoot .gh-ta-btn-primary,#timeAnalysisRoot .gh-ta-btn-primary *,#timeAnalysisRoot button[type=submit],#timeAnalysisRoot button[type=submit] *{color:#fff!important}';document.head.appendChild(css);
    function mediaFix(m){if(!(m instanceof HTMLImageElement||m instanceof HTMLVideoElement))return;m.style.setProperty('opacity','1','important');m.style.setProperty('object-fit','cover','important');if(m.dataset.pcFeatureV2)return;m.dataset.pcFeatureV2='1';const refresh=()=>{if(!m.isConnected||!api)return;api.fgAuto=true;try{api.applyAutoForeground&&api.applyAutoForeground()}catch(_){}};['load','loadeddata','canplay','seeked'].forEach(name=>m.addEventListener(name,()=>setTimeout(refresh,50)));setTimeout(refresh,100)}
    if(bg){all('.clk-bg-image,.clk-bg-video',bg).forEach(mediaFix);if('MutationObserver'in window)new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(n=>{if(n.nodeType!==1)return;mediaFix(n);all('.clk-bg-image,.clk-bg-video',n).forEach(mediaFix)}))).observe(bg,{childList:true,subtree:true})}

    document.addEventListener('click',e=>{const target=e.target&&e.target.closest&&e.target.closest('.clk-palette-mini:not(.clk-palette-mini--special),.clk-color-swatch');if(target&&pane&&pane.contains(target))savePrevious()},true);
    document.addEventListener('click',e=>{
      const save=e.target&&e.target.closest&&e.target.closest('#pcBgFavSave');
      if(save){e.preventDefault();e.stopImmediatePropagation();const favs=readFavs(),v=theme();v.name='お気に入り '+(favs.length+1);favs.push(v);writeFavs(favs);renderFavs();status('現在の配色を保存しました。画像・動画ファイルは保存されません。');return}
      const prev=e.target&&e.target.closest&&e.target.closest('#pcBgPrevious');
      if(prev){e.preventDefault();e.stopImmediatePropagation();let old=null;try{old=JSON.parse(localStorage.getItem(PREV)||'null')}catch(_){}if(!old||!validColor(old.bg)||!validColor(old.accent)){status('戻せる配色がまだありません。先に配色を変更してください。');return}savePrevious();applyTheme(old);status('ひとつ前の配色に戻しました。');return}
      const apply=e.target&&e.target.closest&&e.target.closest('#pcBgFavGroup [data-favorite-index]'),del=e.target&&e.target.closest&&e.target.closest('#pcBgFavGroup [data-favorite-delete]');
      if(apply||del){e.preventDefault();e.stopImmediatePropagation();const favs=readFavs(),i=Number(apply?apply.dataset.favoriteIndex:del.dataset.favoriteDelete);if(!Number.isInteger(i)||i<0||i>=favs.length)return;if(del){favs.splice(i,1);writeFavs(favs);renderFavs();status('お気に入りを削除しました。')}else{savePrevious();applyTheme(favs[i]);status(favs[i].name+'を適用しました。')}}
    },true);
    renderFavs();

    const sleepKey='pc-music-sleep-end';
    function enforceSleep(){let end=0;try{end=Number(localStorage.getItem(sleepKey)||0)}catch(_){}if(!end||Date.now()<end)return;try{window.__clkMusicApi&&window.__clkMusicApi.stopPlayback&&window.__clkMusicApi.stopPlayback()}catch(_){}try{window.__clkStopBuiltInSounds&&window.__clkStopBuiltInSounds()}catch(_){}all('audio,video:not(.clk-bg-video)').forEach(m=>{try{m.pause();m.currentTime=0}catch(_){}});all('iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"],#ytf iframe').forEach(f=>{try{f.src='about:blank'}catch(_){}});const yt=q('#ytf');if(yt){yt.replaceChildren();yt.style.display='none'}try{localStorage.removeItem(sleepKey)}catch(_){}const s=q('#pcMusicSleepStatus');if(s)s.textContent='再生を停止しました';const o=q('#pcMusicSleepOptions');if(o)all('.clk-segment',o).forEach(b=>b.classList.toggle('clk-segment--active',Number(b.dataset.minutes)===0))}
    window.addEventListener('pageshow',enforceSleep);window.addEventListener('focus',enforceSleep);document.addEventListener('visibilitychange',enforceSleep);window.addEventListener('storage',e=>{if(e.key===sleepKey)enforceSleep()});setInterval(enforceSleep,1000);
  });
})();
