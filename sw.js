// Offline support: keep the app's files cached so it opens without internet.
// Bump VERSION whenever any of these files change, so phones pick up the update.
var VERSION = 'break-timer-v24';
var FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) { return cache.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  // Drop caches from older versions.
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Page: try the network first so updates show up, fall back to the cached copy offline.
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (cache) { cache.put('./index.html', copy); });
        return res;
      }).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // Icons and manifest: cached copy first.
  event.respondWith(
    caches.match(req).then(function (hit) { return hit || fetch(req); })
  );
});

// Break notifications sent by the push server (see push-server/): the warning reminders, then the
// final "Break's over". Together with the app's "On break until …" they keep one notification in the
// shade for the whole break: each replaces the previous one (same tag), stays until the break ends
// (requireInteraction) and buzzes even if the app is closed; the warnings and the end buzz harder.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil(self.registration.showNotification(data.title || "⏰ You're late!", {
    body: data.body || '',
    tag: 'break',
    renotify: true,
    requireInteraction: true,
    vibrate: data.urgent ? [300, 150, 300, 150, 600] : [200],
    icon: 'icons/icon-192.png',
    data: { final: !!data.final }
  }));
});

// Tapping a notification brings the app to the front (or opens it). During the break it stays in
// the shade; the final "Break's over" one is dismissed by the tap.
self.addEventListener('notificationclick', function (event) {
  if (event.notification.data && event.notification.data.final) event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
