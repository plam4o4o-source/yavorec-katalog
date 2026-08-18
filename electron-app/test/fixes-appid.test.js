/* v2.2.2 — вътрешният идентификатор на програмата за Windows (build.appId).

   До v2.2.1 той беше „org.chyavorec.inventar“ — зашит за домейна на една
   конкретна библиотека, макар програмата да е универсална. От v2.2.2 е
   неутрален, а инсталаторът премахва старата инсталация сам.

   Тези тестове пазят три неща, които е много лесно да се разминат мълчаливо:
   1) appId да не съдържа отново име/домейн на конкретна библиотека;
   2) GUID-ът в build/installer.nsh наистина да е този на СТАРИЯ appId — иначе
      почистването няма да намери нищо и всеки библиотекар ще остане с две
      програми, без никакво съобщение за грешка;
   3) деинсталирането да не пипа данните (deleteAppDataOnUninstall:false).

   GUID-ът се смята тук наново по алгоритъма на electron-builder (uuid v5 със
   собственото му пространство), само с вградения crypto — нарочно без да се
   заема от node_modules, за да е тестът независим от версията на
   electron-builder и да пази самия алгоритъм, а не текущата му реализация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const nsh = fs.readFileSync(path.join(APP_DIR, 'build', 'installer.nsh'), 'utf8');

// Пространството на electron-builder (NsisTarget.js: ELECTRON_BUILDER_NS_UUID).
const NS = '50e065bc-3134-11e6-9bab-38c9862bdaf3';
function uuidV5(name, namespaceUuid) {
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;        // версия 5
  b[8] = (b[8] & 0x3f) | 0x80;        // вариант RFC 4122
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

test('изчислението на GUID отговаря на това на electron-builder (проверено срещу стария appId)', () => {
  // Тази стойност е взета от самия electron-builder и е закотвяща точка за
  // алгоритъма по-горе; ако тя се разпадне, всичко останало тук е безсмислено.
  assert.equal(uuidV5('org.chyavorec.inventar', NS), '206e886b-e2ed-5520-b4f5-822cfc3c92d5');
});

test('appId не съдържа име или домейн на конкретна библиотека', () => {
  const id = pkg.build.appId;
  assert.ok(id, 'appId трябва да е зададен');
  for (const trace of ['chyavorec', 'yavorec', 'levski', 'vasil']) {
    assert.doesNotMatch(id.toLowerCase(), new RegExp(trace),
      `appId „${id}“ съдържа „${trace}“ — програмата е универсална и не бива да носи името на една библиотека`);
  }
});

test('installer.nsh премахва инсталацията точно на ПРЕДИШНИЯ appId', () => {
  const oldGuid = uuidV5('org.chyavorec.inventar', NS);
  assert.match(nsh, /!macro\s+customInit/, 'трябва да има customInit, иначе старата инсталация остава');
  assert.ok(nsh.includes(oldGuid),
    `installer.nsh трябва да съдържа GUID ${oldGuid} (на стария appId), иначе почистването няма да намери нищо`);
  assert.match(nsh, /QuietUninstallString/, 'премахването трябва да е тихо, без диалог към библиотекаря');
  assert.match(nsh, /HKCU[\s\S]{0,400}HKLM/,
    'ключът се търси и в двата кошера — perMachine е false, но инсталаторът позволява и „за всички потребители“');
});

test('GUID-ът на НОВИЯ appId се различава от стария (иначе смяната е безсмислена)', () => {
  assert.notEqual(uuidV5(pkg.build.appId, NS), uuidV5('org.chyavorec.inventar', NS));
});

test('деинсталирането не изтрива данните на библиотеката', () => {
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false,
    'тихото премахване на старата инсталация разчита точно на това — иначе би отнесло базата данни');
});

test('папката с данните се извежда от `name`, не от appId — затова смяната не мести базата', () => {
  /* Electron взима app.getName() от package.json: първо productName, после name.
     Тук няма ГОРНО НИВО productName (build.productName е друго поле, което
     electron-builder ползва само за инсталатора и името на изпълнимия файл),
     затова името е `name` и данните стоят в %APPDATA%\inventar-desktop.
     Ако някой добави productName на горно ниво, папката с данните на всички
     съществуващи инсталации ще се смени и базата ще „изчезне“ — този тест е
     точно срещу това. */
  assert.equal(pkg.productName, undefined,
    'добавянето на productName на горно ниво мести %APPDATA% папката и скрива базата на всички инсталации');
  assert.equal(pkg.name, 'inventar-desktop',
    'смяната на name мести %APPDATA% папката — прави се само със съзнателна миграция на данните');
});
