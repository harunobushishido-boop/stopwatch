'use strict';
const CACHE_NAME = 'benri-timer-v76';;
const APP_SHELL = ['./', './index.html', './privacy.html', './terms.html', './weather-fallback.js', './google-login-config.js', './google-auth.js', './google-sheets.js', './schedule-announcement.js', './schedule-voice-test.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request;
  const url = new URL(r.url);
  if (r.method !== 'GET' || url.origin !== self.location.origin) return;
  // Video files must bypass Cache Storage so HTTP Range playback stays fast and correct.
  if (/\.(mp4|webm|mov|m4v)$/i.test(url.pathname)) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE_NAME).then(x => x.put('./index.html', c)).catch(() => {}); } return res; })
      .catch(async () => (await caches.match(r)) || (await caches.match('./index.html'))));
    return;
  }
  // Keep the weather fallback script current after GitHub Pages deployments.
  if (/\/weather-fallback\.js$/i.test(url.pathname)) {
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(r, copy)).catch(() => {}); }
      return res;
    }).catch(async () => (await caches.match(r)) || Response.error()));
    return;
  }
  e.respondWith(caches.match(r).then(c => c || fetch(r).then(res => { if (res.ok) { const k = res.clone(); caches.open(CACHE_NAME).then(x => x.put(r, k)).catch(() => {}); } return res; })));
});
