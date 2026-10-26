'use strict';

const CACHE_NAME = 'benri-timer-v102';;
const CACHE_PREFIX = 'benri-timer-';
const APP_SHELL = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './weather-fallback.js',
  './google-login-config.js',
  './google-auth.js',
  './google-sheets.js',
  './schedule-announcement.js',
  './schedule-voice-test.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(APP_SHELL.map(async function (path) {
    const url = new URL(path, self.location.href).href;
    try {
      const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
      if (response.ok) await cache.put(url, response);
    } catch (error) {
      // A single missing/offline asset must not prevent the new worker installing.
      console.warn('App-shell precache skipped:', path, error);
    }
  }));
}

self.addEventListener('install', function (event) {
  event.waitUntil(cacheAppShell().then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (key) {
      return key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME;
    }).map(function (key) {
      return caches.delete(key);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const scopePath = new URL('./', self.location.href).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  // Videos bypass Cache Storage so Range requests keep working.
  if (/\.(mp4|webm|mov|m4v)$/i.test(url.pathname)) return;

  const indexUrl = new URL('./index.html', self.location.href).href;
  const isWeatherScript = /\/weather-fallback\.js$/i.test(url.pathname);

  if (request.mode === 'navigate') {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) {
          cache.put(indexUrl, response.clone()).catch(function () {});
        }
        return response;
      } catch (error) {
        return (await cache.match(request)) ||
          (await cache.match(indexUrl)) ||
          Response.error();
      }
    })());
    return;
  }

  if (isWeatherScript) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) cache.put(request, response.clone()).catch(function () {});
        return response;
      } catch (error) {
        return (await cache.match(request)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async function () {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(request);
    if (saved) return saved;

    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(function () {});
    return response;
  })());
});