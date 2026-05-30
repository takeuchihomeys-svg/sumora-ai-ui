self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  // 古いキャッシュをすべて削除
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// JS/CSS/HTMLはネットワーク優先（キャッシュ使わない）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppShell =
    url.pathname === '/' ||
    url.pathname.startsWith('/_next/') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css');

  if (isAppShell) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
});

// Web Push イベント（バックグラウンド通知）
self.addEventListener('push', (event) => {
  let data = { title: 'AIX LINX', body: '新しいメッセージが届きました', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow(url);
      })
  );
});
