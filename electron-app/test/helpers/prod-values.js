/* ЕДИНСТВЕН източник на продукционните константи за тестовете.
   =====================================================================
   ЗАЩО СЪЩЕСТВУВА: мутационен одит на v2.2.2 показа цял КЛАС дефекти —
   тестовете преписваха продукционни константи (BOOK_SELECT, LOAN_SELECT,
   BOOK_FIELDS, csvCell, diffFields, pctRequired, naturalLoss) вместо да ги
   взимат. Осем от девет копия вече се бяха разминали с оригинала, тоест
   поредицата тестваше нещо, което приложението не изпълнява:
     • копията на BOOK_SELECT бяха без quantity/available (а в теста на
       каталога дори със закована константа `1 AS available`);
     • копията на csvCell не неутрализираха =/+/-/@, затова мутацията
       „readers:exportCsv спира да вика csvCell" оцеляваше;
     • мокът на diffFields връщаше ОБЕКТ {поле:[преди,след]}, а продукцията
       връща МАСИВ [{field,before,after}] — заради което единствената
       гаранция, че ЕГН не влиза в одитната следа
       (`assert.equal(auditLog[0].diff.egn, undefined)`), проверяваше
       фалшификата и беше винаги вярна.

   ОТСЕГА всеки тест взима стойността ОТТУК, а тук тя идва от продукцията. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN_PATH = path.join(__dirname, '..', '..', 'main.js');
const MAIN_SRC = fs.readFileSync(MAIN_PATH, 'utf8');

/* --- Част 1: стойности, които се взимат направо от модулите --- */

// csvCell е обикновен експорт — просто го препращаме, за да има ЕДНО място,
// от което тестовете го взимат.
const { csvCell, isValidEmail, normalizeScanCode } = require('../../security-utils');

function fakeIpc() {
  const handlers = new Map();
  return { handle: (c, f) => handlers.set(c, f), _handlers: handlers };
}
const noop = () => {};

/* BOOK_SELECT/BOOK_FIELDS идват от истинската регистрация на handlers/books.js
   (същият модел, който вече ползва catalog-export-roundtrip.test.js). */
const { BOOK_SELECT, BOOK_FIELDS } = require('../../handlers/books')(fakeIpc(), {
  getDb: () => { throw new Error('BOOK_SELECT се взима без база'); },
  run: (fn) => ({ ok: true, data: fn() }),
  logAudit: noop, today: () => '2026-08-02', ftsQuery: noop,
  cnSortKey: () => '', diffFields: () => [], scheduleCatalogWrite: noop,
  normalizeScanCode
});

/* LOAN_SELECT идва от истинската регистрация на handlers/loans.js. */
const { LOAN_SELECT } = require('../../handlers/loans')(fakeIpc(), {
  getDb: () => { throw new Error('LOAN_SELECT се взима без база'); },
  run: (fn) => ({ ok: true, data: fn() }),
  logAudit: noop, today: () => '2026-08-02', logEvent: noop,
  BOOK_SELECT, scheduleCatalogWrite: noop,
  circRule: () => ({}), readerCategory: () => 'възрастен',
  nextWorkDay: (d) => d, closedDaysBetween: () => 0,
  firstActiveHold: () => null, consumeHoldOnCheckout: noop,
  activateHoldOnReturn: () => null, normalizeScanCode
});

/* --- Част 2: стойности от main.js ---
   main.js не изнася нищо (няма module.exports) и не се зарежда без Electron.
   За ЧИСТИТЕ помощни функции (без затваряне върху db/CURRENT_USER) взимаме
   самия им изходен текст от main.js и го изпълняваме в изолиран контекст.
   Така тестът ползва БУКВАЛНО кода на продукцията: смяна на формулата в
   main.js веднага се вижда тук, а преименуване/премахване хвърля явна
   грешка вместо мълчаливо да върне остаряло копие.
   (Функциите, които ползват `db` — logAudit, buildCatalogPayload и т.н. —
   НЕ се извличат така: те се тестват през истинските IPC канали чрез
   test/helpers/main-app.js.) */
function extractDeclaration(name) {
  // `function name(...) { ... }` на нулево ниво на отстъп
  const fnStart = MAIN_SRC.search(new RegExp('^function\\s+' + name + '\\s*\\(', 'm'));
  if (fnStart >= 0) {
    const open = MAIN_SRC.indexOf('{', fnStart);
    let depth = 0;
    for (let i = open; i < MAIN_SRC.length; i++) {
      if (MAIN_SRC[i] === '{') depth++;
      else if (MAIN_SRC[i] === '}') { depth--; if (depth === 0) return MAIN_SRC.slice(fnStart, i + 1); }
    }
    throw new Error('Незатворено тяло на функция ' + name + ' в main.js');
  }
  // `const name = ...;` на един ред
  const constMatch = MAIN_SRC.match(new RegExp('^const\\s+' + name + '\\s*=\\s*.*;\\s*$', 'm'));
  if (constMatch) return constMatch[0];
  throw new Error('main.js вече не съдържа декларация на „' + name
    + '". Ако е преименувана или преместена, поправете test/helpers/prod-values.js — '
    + 'мълчаливо остаряло копие в тестовете е точно дефектът, който този файл предотвратява.');
}

const MAIN_HELPERS = ['today', 'yearOf', 'value', 'pctRequired', 'naturalLoss', 'diffFields'];
const sandbox = vm.createContext({});
vm.runInContext(
  MAIN_HELPERS.map(extractDeclaration).join('\n') +
  '\n;({ ' + MAIN_HELPERS.join(', ') + ' })',
  sandbox,
  { filename: 'main.js (извлечени помощни функции)' }
);
const mainHelpers = vm.runInContext('({ ' + MAIN_HELPERS.join(', ') + ' })', sandbox);
for (const n of MAIN_HELPERS) {
  if (typeof mainHelpers[n] !== 'function') throw new Error('Извличането на ' + n + ' от main.js се провали');
}
const { today, yearOf, value, pctRequired, naturalLoss, diffFields } = mainHelpers;

/* Одитната следа: продукционният logAudit е `(action, detail, diff)` и записва
   diff в отделна колона. Тестовите двойници изхвърляха третия аргумент, с което
   изчезваше и всяка проверка върху него. Този събирач пази и трите. */
function makeAuditCollector() {
  const entries = [];
  const logAudit = (action, detail, diff) => entries.push({ action, detail, diff });
  return { entries, logAudit };
}

module.exports = {
  BOOK_SELECT, BOOK_FIELDS, LOAN_SELECT,
  csvCell, isValidEmail, normalizeScanCode,
  today, yearOf, value, pctRequired, naturalLoss, diffFields,
  makeAuditCollector,
  MAIN_SRC, MAIN_PATH, extractDeclaration
};
