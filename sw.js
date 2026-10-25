// Service worker: l'app si apre anche offline. I dati passano sempre dalla rete.
const VERSION = 'pippilove-v3';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/config.js', 'js/motion.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase e Claude: mai in cache
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;

  const cdn = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (url.origin !== location.origin && !cdn) return;

  // rete prima (così gli aggiornamenti arrivano subito), cache se offline
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});
