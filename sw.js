const CACHE_NAME="bodygym-pt-v3";
const APP_ASSETS=["./","./index.html","./style.css","./app.js","./manifest.json","./data/torso-a.json","./data/pierna-a.json","./data/torso-b.json","./data/pierna-b.json","./assets/dominadas.jpg","./assets/press_inclinado.jpg","./assets/poleas.jpg","./assets/contractor.jpg","./assets/pierna_maquinas.jpg","./assets/hiperextensiones.jpg","./assets/zona_azul.jpg"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(APP_ASSETS)).catch(()=>{})));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE_NAME).map(x=>caches.delete(x))))));
self.addEventListener("fetch",e=>e.respondWith(caches.match(e.request).then(x=>x||fetch(e.request).catch(()=>caches.match("./index.html")))));