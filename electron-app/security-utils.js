// Малки, чисти помощни функции за сигурност — извадени в отделен non-Electron
// модул (както backup-crypto.js/pii-crypto.js/search-fts.js/debounce.js), за
// да са тестваеми с node:test без main.js. Фаза 3 от плана (Electron/security
// hardening): CSV formula-injection защита и валидация на mailto адрес.

// Защита срещу CSV/formula injection (OWASP): ако клетка започва с '=', '+',
// '-', '@' или таб/CR, Excel/LibreOffice могат да я изпълнят като формула (или
// дори системна команда) при отваряне на файла — напр. заглавие на книга
// "=cmd|'/c calc'!A1", въведено случайно или нарочно от каталогизатора. Водещ
// апостроф преди опасния символ неутрализира изпълнението, без видимо да
// променя показаната стойност в повечето програми за таблици.
function csvCell(x) {
  let s = String(x ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Груба, но достатъчна проверка на формата на имейл — не техническа коректност
// на самия адрес е целта (mailto: схемата и без това е фиксирана буквално в
// main.js, не идва от полето), а да не подадем съвсем несвързан низ от
// читателската картотека към shell.openExternal.
const EMAIL_RE = /^[^\s@"]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return EMAIL_RE.test(String(email == null ? '' : email).trim());
}

module.exports = { csvCell, isValidEmail };
