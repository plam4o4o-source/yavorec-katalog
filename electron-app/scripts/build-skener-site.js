#!/usr/bin/env node
'use strict';
/* ПРИЛОЖЕНИЕТО ЗА СКАНИРАНЕ ПО HTTPS (v2.4.78).
   =====================================================================
   Сглобява от СЪЩИЯ шаблон (src/mobile-template.html), от който програмата
   записва страницата като файл, папка за публикуване:

     <изход>/skener/index.html            страницата (с манифест, без име на библиотека)
     <изход>/skener/zxing-reader.js       вграденият четец (за телефони без BarcodeDetector)
     <изход>/skener/zxing_reader.wasm
     <изход>/skener/manifest.webmanifest  „Добавяне към началния екран“ / инсталиране
     <изход>/skener/sw.js                 service worker — работа без интернет
     <изход>/skener/icon-192.png, icon-512.png   (от site/skener/)

   Публикува се от .github/workflows/skener-pages.yml в GitHub Pages:
   https://plam4o4o-source.github.io/yavorec-katalog/skener/

   ЗАЩО ИЗОБЩО. Страницата, отворена като файл, няма собствен адрес и Chrome не
   дава живата камера — човекът снима всяка книга поотделно. По https Chrome пита
   веднъж и помни; етикетите се четат един след друг.

   В страницата НЯМА нищо от базата: името на библиотеката идва след „#“ в
   адреса (QR кодът в програмата го носи; тази част не стига до сървъра), а
   списъкът на проверката се зарежда от файл на самия телефон.

   Употреба: node scripts/build-skener-site.js <изходна папка> */
const fs = require('fs');
const path = require('path');
const { buildScannerPage, zxingFiles } = require('../mobile-page');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const ICONS_DIR = path.join(__dirname, '..', '..', 'site', 'skener');
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'zxing-reader.js', 'zxing_reader.wasm', 'icon-192.png', 'icon-512.png'];

function manifest() {
  return {
    name: 'Инвентаризация — сканиране',
    short_name: 'Инвентаризация',
    description: 'Сканиране на баркодове при инвентаризация на библиотечния фонд (InvLib).',
    lang: 'bg',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#1A1208',
    theme_color: '#241809',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}

/* Service worker-ът: всичко се пази в кеш, именуван по версията — новото издание
   е нов кеш, старият се трие. Страницата се дава от кеша ВЕДНАГА (на рафта често
   няма обхват), а новата версия се тегли отзад и влиза при следващото отваряне. */
function serviceWorker(version) {
  return `'use strict';
/* InvLib — приложението за сканиране при инвентаризация (v${version}).
   Сглобено от electron-app/scripts/build-skener-site.js — не се пипа на ръка. */
const CACHE = 'skener-v${version}';
const FILES = ${JSON.stringify(FILES)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('skener-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then((c) => c.match('index.html').then((hit) => {
      const net = fetch(req).then((r) => { if (r.ok) c.put('index.html', r.clone()); return r; });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    })));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
`;
}

function build(outRoot) {
  const out = path.join(outRoot, 'skener');
  fs.mkdirSync(out, { recursive: true });
  const pwaHead = '<link rel="manifest" href="manifest.webmanifest">\n'
    + '<link rel="icon" href="icon-192.png">\n<link rel="apple-touch-icon" href="icon-192.png">';
  fs.writeFileSync(path.join(out, 'index.html'), buildScannerPage({ slug: '', target: 'site', pwaHead }), 'utf8');
  const z = zxingFiles();
  fs.copyFileSync(z.js, path.join(out, 'zxing-reader.js'));
  fs.copyFileSync(z.wasm, path.join(out, 'zxing_reader.wasm'));
  for (const f of ['icon-192.png', 'icon-512.png']) fs.copyFileSync(path.join(ICONS_DIR, f), path.join(out, f));
  fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest(), null, 2), 'utf8');
  fs.writeFileSync(path.join(out, 'sw.js'), serviceWorker(pkg.version), 'utf8');
  /* Коренът на сайта води към приложението; .nojekyll — файловете се дават както са. */
  fs.writeFileSync(path.join(outRoot, 'index.html'), '<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8">'
    + '<meta http-equiv="refresh" content="0; url=skener/"><title>InvLib</title></head>'
    + '<body><a href="skener/">Инвентаризация — сканиране</a></body></html>', 'utf8');
  fs.writeFileSync(path.join(outRoot, '.nojekyll'), '', 'utf8');
  return out;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('Употреба: node scripts/build-skener-site.js <изходна папка>'); process.exit(2); }
  const out = build(path.resolve(target));
  console.log('Приложението за сканиране е сглобено в ' + out);
}

module.exports = { build, manifest, serviceWorker, FILES };
