const CACHE='twp-v26-static-2';
const ASSETS=['/Home.html','/Travel_Planner.html','/Travel_Report.html','/Cerca_Voli_Desktop.html','/Cerca_Hotel_Desktop.html','/Cerca_Autonoleggio_Desktop.html','/travel-work-planner_v25.js','/pdf-lib.min.js','/cloud-access.js','/manifest.webmanifest','/home-hero.jpg','/home-flight.jpg','/home-hotel.jpg','/home-car.jpg','/home-planner.jpg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url); if(u.origin!==location.origin||u.pathname.startsWith('/api/')) return; e.respondWith(caches.match(e.request).then(x=>x||fetch(e.request).then(r=>{const cp=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); return r;})));});
