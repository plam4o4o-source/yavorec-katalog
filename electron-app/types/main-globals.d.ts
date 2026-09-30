/* ============================================================================
   ОПИСАНИЯ ЗА ГЛАВНИЯ ПРОЦЕС — за `tsc --checkJs` (tsconfig.json).
   ============================================================================
   Грешките, които носят допълнителни полета към съобщението си, за да може
   прозорецът да каже нещо по-точно от текста им. */

/** „Базата е от по-нова версия на програмата“ — main.js, при отваряне на базата. */
interface DbNewerSchemaError extends Error {
  code: 'DB_NEWER_SCHEMA';
  /** Установено СЛЕД сервизната част на стартирането (друга станция обнови базата междувременно). */
  late: boolean;
  isNetwork: boolean;
  configPath: string;
  dbPath: string;
}

/** Отговор 4xx/5xx от услуга за ISBN — различава „няма такава книга“ от „няма връзка“. */
interface HttpStatusError extends Error {
  httpStatus: number;
}

/** parseInt превръща аргумента в низ сам (ToString) — числото или Id от договора
    (number | string) се чете еднакво. Стандартното описание приема само string. */
// null/undefined → NaN (→ „|| подразбиране“ в кода) — точно на това се разчита при липсващо поле.
declare function parseInt(string: string | number | null | undefined, radix?: number): number;
