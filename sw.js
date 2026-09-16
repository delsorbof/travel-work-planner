const CACHE='twp-v26-cloud-first-1';
const ASSETS=[];

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('twp-v26-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req=event.request;
  const u=new URL(req.url);
  if(u.origin!==location.origin || u.pathname.startsWith('/api/') || req.method!=='GET') return;
  // Never cache the service worker itself: this guarantees that the browser can see a new version.
  if(u.pathname==='/sw.js') return;
  // Cloud-first: network first, cache only as an emergency fallback.
  event.respondWith(
    fetch(req, {cache:'no-store'})
      .then(res => {
        if(res.ok && ['document','script','style'].includes(req.destination)){
          const cp=res.clone();
          caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{});
        }
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || Response.error()))
  );
});
