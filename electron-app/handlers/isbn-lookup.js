// Търсене по ISBN (Google Books и Open Library) + SRU (MARC внасяне) —
// извадени от main.js в отделен модул (Фаза 4, стъпка 10 от разбиването на
// монолита на модули по домейн). Изцяло самостоятелен: чисти функции +
// само две IPC handler-и, никой друг код в main.js не ги вика.
//
// Заявките се правят от главния процес, а не от интерфейса, защото
// Content-Security-Policy на страницата допуска само собствени ресурси.
// net.fetch минава през мрежовия стек на Chromium, тоест ползва системните
// настройки за прокси, за разлика от обикновения https модул на Node.
//
// За разлика от Google Books/Open Library (търговски метаданни), SRU носи
// истински библиотечни MARC записи. НБКМ и COBISS изискват подписано
// споразумение за достъп до техните SRU/Z39.50 сървъри, затова по
// подразбиране се ползва каталогът на Library of Congress — публичен,
// безплатен, без регистрация. Адресът е сменяем от Настройки.
module.exports = function registerIsbnLookupHandlers(ipcMain, deps) {
  const { net, getDb } = deps;

  function normalizeIsbn(raw) {
    const s = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    return (s.length === 10 || s.length === 13) ? s : '';
  }
  // Езиковите кодове на двете услуги са двубуквени (bg, en…), а програмата пази езика с
  // думи на български, както е в падащото меню.
  const ISBN_LANG = {
    bg: 'български', en: 'английски', ru: 'руски', de: 'немски', fr: 'френски',
    es: 'испански', it: 'италиански', tr: 'турски', el: 'гръцки', ro: 'румънски',
    sr: 'сръбски', mk: 'македонски', pl: 'полски', cs: 'чешки', uk: 'украински'
  };
  // Осем секунди таван на заявка: при недостъпна услуга бутонът в интерфейса не бива да
  // стои „зает“ неопределено дълго. Двете услуги се питат едновременно, така че общото
  // изчакване също е около осем секунди.
  async function fetchJson(url) {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'Inventar-Library-System' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      // 4xx/5xx е отговор на услугата, а не липса на връзка — двете се разграничават,
      // за да не се каже „няма интернет“, когато книгата просто я няма.
      const err = new Error('HTTP ' + res.status); err.httpStatus = res.status; throw err;
    }
    return await res.json();
  }
  async function lookupGoogleBooks(isbn) {
    const d = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = d && d.items && d.items[0] && d.items[0].volumeInfo;
    if (!v) return null;
    const img = v.imageLinks || {};
    return {
      source: 'Google Books',
      title: v.title || '',
      subtitle: v.subtitle || '',
      author: (v.authors || []).join(', '),
      publisher: v.publisher || '',
      year: (v.publishedDate || '').slice(0, 4),
      pages: v.pageCount ? String(v.pageCount) : '',
      language: ISBN_LANG[v.language] || '',
      annotation: v.description || '',
      keywords: (v.categories || []).join(', '),
      // Изображенията идват през http; https е нужно, за да се покажат в каталога на сайта.
      cover_url: (img.thumbnail || img.smallThumbnail || '').replace(/^http:/, 'https:'),
      city: ''
    };
  }
  async function lookupOpenLibrary(isbn) {
    const d = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const v = d && d['ISBN:' + isbn];
    if (!v) return null;
    const pub = (v.publish_places || [])[0];
    return {
      source: 'Open Library',
      title: v.title || '',
      subtitle: v.subtitle || '',
      author: (v.authors || []).map(a => a.name).join(', '),
      publisher: (v.publishers || []).map(p => p.name).join(', '),
      year: String(v.publish_date || '').match(/\d{4}/)?.[0] || '',
      pages: v.number_of_pages ? String(v.number_of_pages) : '',
      language: '',
      annotation: (v.notes && (v.notes.value || v.notes)) || '',
      keywords: (v.subjects || []).slice(0, 8).map(s => s.name).join(', '),
      cover_url: (v.cover && (v.cover.large || v.cover.medium || v.cover.small)) || '',
      city: pub ? pub.name : ''
    };
  }
  /* Одит v2.4.14: полето в настройките е свободен текст и се долепя до заявка,
   която програмата изпълнява сама — адрес от вида http://192.168.1.1/ превръщаше
   търсенето в опипване на локалната мрежа. Затова адресът вече се проверява
   (виж sru:lookup по-долу).

   Стойността по подразбиране НЕ се сменя на https: порт 210 е регистрираният
   порт за Z39.50 и шлюзът на Библиотеката на Конгреса там говори обикновен HTTP;
   мълчаливата смяна щеше да счупи търсенето по ISBN на всяка инсталация, а
   съобщението за грешка щеше да казва само „няма връзка със сървъра“. Рискът тук
   е чужд библиографски запис да влезе в каталога — неприятно, но поправимо от
   библиотекаря, за разлика от изгубена функция, която той не може да диагностицира. */
const SRU_ENDPOINT_DEFAULT = 'http://lx2.loc.gov:210/lcdb';
  const MARC_LANG = {
    bul: 'български', eng: 'английски', rus: 'руски', ger: 'немски', deu: 'немски',
    gre: 'гръцки', ell: 'гръцки', fre: 'френски', fra: 'френски', spa: 'испански',
    ita: 'италиански', tur: 'турски', rum: 'румънски', ron: 'румънски',
    scr: 'сръбски', srp: 'сръбски', mac: 'македонски', mkd: 'македонски',
    pol: 'полски', cze: 'чешки', ces: 'чешки', ukr: 'украински'
  };
  function xmlUnescape(str) {
    return String(str || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
      .replace(/&amp;/g, '&');
  }
  // Целенасочен парсер само за MARCXML структурата (leader/controlfield/datafield/subfield),
  // не общ XML парсер — MARCXML е достатъчно регулярен формат за това. Записите се
  // разпознават по <leader>, който е уникален за всеки MARC запис в отговора.
  function parseMarcXml(xml) {
    const records = [];
    const parts = String(xml || '').split(/<leader>/i).slice(1);
    for (const part of parts) {
      const endIdx = part.search(/<\/record>/i);
      const chunk = endIdx >= 0 ? part.slice(0, endIdx) : part;
      const fields = {};
      const dfRe = /<datafield\s+tag="(\d{3})"[^>]*>([\s\S]*?)<\/datafield>/gi;
      let m;
      while ((m = dfRe.exec(chunk))) {
        const subs = [];
        const sfRe = /<subfield\s+code="([^"]*)"\s*>([\s\S]*?)<\/subfield>/gi;
        let sm;
        while ((sm = sfRe.exec(m[2]))) subs.push({ code: sm[1], text: xmlUnescape(sm[2]).trim() });
        (fields[m[1]] = fields[m[1]] || []).push(subs);
      }
      records.push(fields);
    }
    return records;
  }
  function subVal(subs, code) {
    const s = (subs || []).find(x => x.code === code);
    return s ? s.text : '';
  }
  // MARC подполетата свършват с ISBD пунктуация (" /", " :", " ,"...), която тук не ни
  // трябва — маха се последната пунктуационна group заедно с празнините около нея.
  const trimMarcPunct = (s) => String(s || '').replace(/\s*[:;,./]+\s*$/, '').trim();
  function marcToBook(fields) {
    const f245 = (fields['245'] || [])[0] || [];
    const title = trimMarcPunct(subVal(f245, 'a'));
    const subtitle = trimMarcPunct(subVal(f245, 'b'));
    const authorSubs = (fields['100'] || [])[0] || (fields['700'] || [])[0] || [];
    const author = trimMarcPunct(subVal(authorSubs, 'a'));
    const fPub = (fields['264'] || [])[0] || (fields['260'] || [])[0] || [];
    const city = trimMarcPunct(subVal(fPub, 'a'));
    const publisher = trimMarcPunct(subVal(fPub, 'b'));
    const year = (subVal(fPub, 'c').match(/\d{4}/) || [])[0] || '';
    const f300 = (fields['300'] || [])[0] || [];
    const pages = (subVal(f300, 'a').match(/\d+/) || [])[0] || '';
    const langCode = subVal((fields['041'] || [])[0] || [], 'a').toLowerCase();
    const keywords = (fields['650'] || [])
      .map(s => trimMarcPunct(subVal(s, 'a'))).filter(Boolean).join(', ');
    const isbn = subVal((fields['020'] || [])[0] || [], 'a').replace(/\s*\(.*\)\s*$/, '').trim();
    return {
      source: 'SRU (MARC)', title, subtitle, author, publisher, city, year, pages,
      language: MARC_LANG[langCode] || '', keywords, annotation: '', cover_url: '', isbn
    };
  }
  async function sruLookupIsbn(isbn, endpoint) {
    const url = `${endpoint}?version=1.1&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1` +
      `&query=${encodeURIComponent('bath.isbn=' + isbn)}`;
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'Inventar-Library-System' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) { const err = new Error('HTTP ' + res.status); err.httpStatus = res.status; throw err; }
    const xml = await res.text();
    if (/<numberOfRecords>0<\/numberOfRecords>/i.test(xml)) return null;
    const records = parseMarcXml(xml);
    if (!records.length) return null;
    const book = marcToBook(records[0]);
    return book.title ? book : null;
  }

  ipcMain.handle('sru:lookup', async (e, raw) => {
    const isbn = normalizeIsbn(raw);
    if (!isbn) return { ok: false, error: 'Невалиден ISBN — очакват се 10 или 13 цифри.' };
    const s = getDb().prepare('SELECT sru_endpoint FROM settings WHERE id = 1').get() || {};
    const endpoint = (s.sru_endpoint || '').trim() || SRU_ENDPOINT_DEFAULT;
    /* Адресът идва от свободно поле в настройките и се долепя до заявка, която
       програмата изпълнява сама. Приемат се само http/https и само истински
       адрес — иначе file:, а на Windows и други схеми, стават достъпни оттук. */
    let parsed;
    try { parsed = new URL(endpoint); } catch (e) { parsed = null; }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new Error('Адресът на библиографския сървър (SRU) в „Настройки“ не е валиден http(s) адрес: ' + endpoint);
    }
    try {
      const data = await sruLookupIsbn(isbn, endpoint);
      if (!data) return { ok: false, error: 'Няма намерен MARC запис с този ISBN в „' + endpoint + '“.' };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: 'Няма връзка със SRU сървъра (' + endpoint + ') или той не отговаря.' };
    }
  });

  ipcMain.handle('isbn:lookup', async (e, raw) => {
    const isbn = normalizeIsbn(raw);
    if (!isbn) return { ok: false, error: 'Невалиден ISBN — очакват се 10 или 13 цифри.' };
    // Двете услуги се питат заедно и се допълват: Google Books обикновено дава език и
    // анотация, Open Library — място на издаване и предметни рубрики.
    const [rg, ro] = await Promise.allSettled([lookupGoogleBooks(isbn), lookupOpenLibrary(isbn)]);
    const g = rg.status === 'fulfilled' ? rg.value : null;
    const o = ro.status === 'fulfilled' ? ro.value : null;
    if (!g && !o) {
      // Ако и двете услуги са се провалили с изключение, проблемът е във връзката, а не в
      // това, че книгата липсва — съобщението трябва да казва правилното нещо.
      const bothFailed = rg.status === 'rejected' && ro.status === 'rejected';
      return {
        ok: false,
        error: bothFailed
          ? 'Няма връзка с Google Books и Open Library. Проверете интернет връзката и опитайте пак.'
          : 'Няма намерено заглавие с този ISBN в Google Books и Open Library.'
      };
    }
    const pick = (k) => (g && g[k]) || (o && o[k]) || '';
    const sources = [g && g.source, o && o.source].filter(Boolean);
    return {
      ok: true, data: {
        isbn,
        title: pick('title'), subtitle: pick('subtitle'), author: pick('author'),
        publisher: pick('publisher'), city: pick('city'), year: pick('year'),
        pages: pick('pages'), language: pick('language'), keywords: pick('keywords'),
        annotation: pick('annotation'), cover_url: pick('cover_url'),
        sources: sources.join(' и ')
      }
    };
  });
};
