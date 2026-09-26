/* ============================================================================
   ГЛОБАЛНИТЕ СТОЙНОСТИ НА ЕКРАНА — за `tsc --checkJs` (tsconfig.renderer.json).
   ============================================================================
   Изгледите (src/views/*.js) са обикновени <script> файлове с общо глобално
   пространство: функциите и `const`-ите на един са видими в следващите, и
   TypeScript ги вижда сам. Тук се описва само това, което той НЕ може да види:
     • window.api — мостът от preload.js (описанието се генерира, виж
       types/api.generated.d.ts);
     • стойностите, които изгледите слагат на `window` за onclick="…" в
       сглобения HTML и за печата (списъкът на екрана, текущата справка…);
     • свойства на браузъра, които ги няма в стандартните описания.
   Нова стойност на `window` → ред тук; иначе CI (npm run typecheck) пада. */

interface Window {
  /** Мостът към главния процес — виж preload.js и types/api.generated.d.ts. */
  api: InvLibApi;

  /* Константи на ядрото, изложени за тестовете и за изгледите (src/views/core.js). */
  RENDER_PAGE_SIZE: number;
  RENDER_MAX_ROWS: number;
  MODAL_FADE_MS: number;

  /* Списъците на текущия екран — редовете, от които onclick="…" и печатът
     вземат записа по индекс. Формата им е редът, върнат от обработчика. */
  _BOOKS_LIST: any[];
  _READERS_LIST: any[];
  _INVBOOK_ROWS: any[];
  _MZS_ROWS: any[];
  _LOST_LIST: any[];
  _OVERDUE_LIST: any[];
  _ACQ_LIST: any[];
  _PRS_LIST: any[];
  _CHR_LIST: any[];
  _ANL_LIST: any[];
  _CATS: any[];
  _EMPLOYEES_ACTIVE: any[];
  _EMPLOYEES_ALL: any[];
  _REMINDERS: any[];
  _ACC_LINES: any[];
  _PER_KARDEX: any;
  _DNEVNIK: any;
  _REPORT: any;
  _KDBF_REPORT: any;
  _LOST_Q: any;
  _HOLD_READER: any;
  _ACC_READER: any;
  _ACC_BALANCE: any;
  /** Откъде е отворен прозорецът за връзки (летопис, персона, запис). */
  _LINK_CTX: { kind: string; id: any } | null;

  /* Таймерите на отложеното търсене (персоналии, летопис, аналитика). */
  _prsT: ReturnType<typeof setTimeout> | null;
  _chrT: ReturnType<typeof setTimeout> | null;
  _anlT: ReturnType<typeof setTimeout> | null;

  /** Сменя годината в списъка с актове (src/views/deaccession-acts.js). */
  setActsYear: (y: string) => void;

  /** Старото име на AudioContext в WebKit — резервният път за звука при сканиране. */
  webkitAudioContext?: typeof AudioContext;
}

interface File {
  /** До Electron 31 — пътят на влачения файл; сега през api.importData.pathOf (виж preload.js). */
  path?: string;
}
