/* Service Worker لمسابقة سراج الثقافية
 * - يدمج Service Worker الخاص بـ OneSignal لاستقبال الإشعارات
 * - يخزّن ملفات الموقع الثابتة ليفتح بسرعة ويعمل كتطبيق (PWA)
 * - لا يتدخل أبداً في طلبات Google Apps Script (الحالة والإجابات تأتي دائماً من الخادم مباشرة)
 */
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
} catch (e) {
  // بدون اتصال أو OneSignal غير مفعّل: يستمر الموقع بالعمل
}

const CACHE = 'siraj-quiz-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/siraj-logo-blue.png',
  './assets/siraj-logo.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/fonts/thmanyahsans-Light.woff2',
  './assets/fonts/thmanyahsans-Regular.woff2',
  './assets/fonts/thmanyahsans-Medium.woff2',
  './assets/fonts/thmanyahsans-Bold.woff2',
  './assets/fonts/thmanyahserifdisplay-Medium.woff2',
  './assets/fonts/thmanyahserifdisplay-Bold.woff2',
  './assets/fonts/thmanyahserifdisplay-Black.woff2'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(ASSETS.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('siraj-quiz-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Apps Script و OneSignal و YouTube تمر مباشرة

  // الصفحة نفسها: الشبكة أولاً (لتصل التحديثات فوراً)، والنسخة المخزنة عند انقطاع الاتصال
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // الملفات الثابتة: من المخزن مع تحديث في الخلفية
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
