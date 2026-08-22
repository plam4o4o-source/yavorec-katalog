/* v2.4.11 — build.productName минава от "Инвентар" на "InvLib" (заедно с
   legalTrademarks и nsis.artifactName). До v2.4.2 renaming-ът на видимия текст
   в приложението остана без productName нарочно (потребителят избра "само
   видимия текст, НЕ productName" — вижте историята на v2.4.3), от предпазливост
   заради (тогава невярно предположение) риск за папката с данните.

   Емпирично проследена е РЕАЛНАТА логика на electron-builder/NSIS
   (node_modules/app-builder-lib/{appInfo.js,targets/targetUtil.js,
   templates/nsis/{multiUser,include/installer}.nsh}), преди да се пипне
   productName, за да се потвърди, че смяната е безопасна за ВЕЧЕ инсталирани
   библиотеки:

   1) Папката с ПОТРЕБИТЕЛСКИТЕ ДАННИ (%APPDATA%) се определя от `name`
      (горно ниво в package.json), НЕ от `build.productName` — вижте
      fixes-appid.test.js. productName не я засяга изобщо.

   2) Папката с ПРОГРАМАТА (Program Files/Local Programs) за НОВА инсталация
      се определя от productName САМО ако той минава ASCII-only регекса на
      electron-builder (getWindowsInstallationDirName в targetUtil.js:
      /^[-_+0-9a-zA-Z .]+$/) — "Инвентар" (кирилица) НЕ минаваше и до v2.4.10
      реалната папка на ВСЯКА фактическа инсталация вече беше `inventar-desktop`
      (fallback към `name`), а не "Инвентар", каквото документацията твърдеше.
      "InvLib" минава регекса — нови инсталации ще ползват `...\Programs\InvLib`.

   3) За ВЕЧЕ инсталирана библиотека (ъпдейт), инсталаторът НЕ пресмята
      папката наново от productName — чете съществуващия `InstallLocation` от
      регистъра (ключ `Software\${APP_GUID}`, GUID изведен от `appId`, който
      тук НЕ се пипа) и го преизползва directno (multiUser.nsh:
      "ReadRegStr $perUserInstallationFolder ... InstallLocation; if != ""
      StrCpy $INSTDIR $perUserInstallationFolder"). Т.е. вече монтирана
      библиотека продължава на СЪЩИЯ път (какъвто и да е бил) — не се мести.

   4) Преките пътища (Старт меню/Работен плот) се ПРЕИМЕНУВАТ на място при
      разминаване на старото/новото име (installer.nsh: addStartMenuLink/
      addDesktopLink — "Rename $oldStartMenuLink $newStartMenuLink"), не се
      дублират — механизъм, вграден точно за смяна на продуктовото име.

   Единственото, от което зависи цялата тази безопасност, е appId (и оттам
   GUID-ът) да НЕ се пипа заедно с productName — тестовете тук замразяват
   точно това, плюс самите нови стойности. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

// Регексът на electron-builder (targets/targetUtil.js:
// getWindowsInstallationDirName) — независимо пресъздаден тук, а не наследен
// от node_modules, по същата логика като fixes-appid.test.js: тестът пази
// самия алгоритъм, не текущата инсталирана версия на electron-builder.
const WINDOWS_INSTALL_DIR_NAME_RE = /^[-_+0-9a-zA-Z .]+$/;

test('build.productName е "InvLib"', () => {
  assert.equal(pkg.build.productName, 'InvLib');
});

test('build.win.legalTrademarks споменава InvLib, не старото име', () => {
  assert.match(pkg.build.win.legalTrademarks, /^InvLib/);
  assert.doesNotMatch(pkg.build.win.legalTrademarks, /Инвентар/);
});

test('build.nsis.artifactName е на латиница и споменава InvLib (не "Инвентар")', () => {
  assert.equal(pkg.build.nsis.artifactName, 'InvLib-Setup-${version}.${ext}');
});

test('"InvLib" минава ASCII-only регекса на electron-builder — нови инсталации ще ползват productName за папката, не fallback към `name`', () => {
  assert.match(pkg.build.productName, WINDOWS_INSTALL_DIR_NAME_RE);
});

test('appId НЕ се пипа заедно с productName — иначе GUID-ът се сменя и вече монтирани библиотеки получават ДУБЛИРАНА икона вместо преименувана', () => {
  assert.equal(pkg.build.appId, 'bg.inventar.app',
    'appId трябва да остане същият — цялата безопасност на productName рефакторинга (виж коментара най-отгоре) разчита на НЕПРОМЕНЕН GUID в регистъра');
});

test('папката с потребителските данни продължава да идва от `name`, не от productName (виж fixes-appid.test.js за пълната проверка)', () => {
  assert.equal(pkg.name, 'inventar-desktop');
  assert.equal(pkg.productName, undefined, 'горно ниво productName би преместил %APPDATA% папката на всички инсталации');
});
