/* ============================================================================
   ДОГОВОРЪТ ЕКРАН ↔ ОБРАБОТЧИК (v2.4.72) — за `tsc --checkJs`.
   ============================================================================
   Едно описание за двете страни на един канал:
     • изгледите виждат аргументите и отговора през window.api
       (types/api.generated.d.ts се генерира от preload.js и оттук);
     • обработчикът описва параметъра си със СЪЩИЯ тип —
       `@param {IpcArg<'loans:checkout'>} arg` — тоест поле, което екранът не
       праща, или поле, което обработчикът чака под друго име, е грешка при
       проверката, а не находка при следващия пълен тест.
   test/typecheck-v2472.test.js пази връзката: всеки описан канал съществува в
   preload.js и обработчикът му носи IpcArg за същия канал.

   Как се чете: `args` — позиционните аргументи след събитието `e`; `result` —
   `data` на отговора (обработчиците връщат { ok, data } или { ok:false, error }
   през run()). Идентификатор от базата идва от формите често като низ, затова
   е Id = number | string. Полетата в отговора са точно тези, които
   обработчикът връща; ред от SQL носи колоните на заявката си.
   Описват се модул по модул; неописаните канали остават InvLibInvoke. */

/** Идентификатор от базата; от HTML формите и data-* идва като низ. */
type Id = number | string;
/** Дата по ISO — „ГГГГ-ММ-ДД“. */
type IsoDate = string;

/** Отговорът на всеки канал през run() (handlers → main.js). Някои канали
    връщат и допълнителни полета до `data` (напр. books:create — catalogWarning). */
interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  [extra: string]: any;
}

/** Типът на метод от window.api за описан канал. */
type IpcMethod<C extends keyof IpcContract> =
  (...args: IpcContract[C]['args']) => Promise<IpcResult<IpcContract[C]['result']>>;
/** Аргументът на обработчика (по подразбиране първият след `e`). */
type IpcArg<C extends keyof IpcContract, I extends number = 0> = IpcContract[C]['args'][I];
/** Данните в отговора на канала. */
type IpcData<C extends keyof IpcContract> = IpcContract[C]['result'];

/* ---------------- Общи редове ---------------- */

/** Покритие на начисление с плащания (chargeCoverage, handlers/account.js). */
interface Coverage { charged: number; covered: number; outstanding: number }
/** Резервацията, заделена при връщане — кого да повика библиотекарката. */
interface HoldBrief { reader_name: string; card_no: string | null; phone: string | null }

/** Ред от loans (l.*). */
interface LoanColumns {
  id: number; reader_id: number; book_id: number;
  date_out: IsoDate; date_due: IsoDate | null; date_in: IsoDate | null;
  fine: number | null; renewals: number | null; anon_category: string | null;
  deaccession_act_id: number | null;
  lost: number | null; lost_date: IsoDate | null; lost_resolution: string | null; lost_amount: number | null;
  lost_account_line_id: number | null; lost_replacement_book_id: number | null;
  lost_replacement_note: string | null; lost_note: string | null;
  deaccession_fine: number | null; deaccession_fine_line_id: number | null;
}
/** LOAN_SELECT в handlers/loans.js — заемането с документа и читателя. */
interface LoanRow extends LoanColumns {
  title: string; author: string | null; inv_number: number | null;
  reader_name: string; card_no: string | null;
}
/** Просрочено заемане с разбивката на забавата (loans:overdue). `fine` е ОСТАТЪКЪТ
    за плащане; начисленото по заемането е `fineCharged`. */
interface OverdueRow extends LoanRow {
  daysLate: number; fineCharged: number; fineNew: number; finePaid: number; fineAccrued: number;
  fineCredit?: number;
}
/** Ред от books (b.*). */
interface BookColumns {
  id: number; inv_number: number | null; barcode: string | null; register_date: string | null;
  title: string; subtitle: string | null; author: string | null; category_id: number | null;
  year: string | null; volume: string | null; isbn: string | null; pages: string | null; language: string | null;
  udk: string | null; call_number: string | null; author_mark: string | null; city: string | null;
  publisher: string | null; series: string | null; series_no: string | null; keywords: string | null;
  annotation: string | null; cover_url: string | null; department: string | null; status: string | null;
  status_date: string | null; datelastseen: string | null; permanent_location: string | null; cn_sort: string | null;
  price: number | null; description: string | null; acquisition_id: number | null;
  deaccession_act_id: number | null; deaccession_date: string | null; created_at: string | null;
}
/** BOOK_SELECT в handlers/books.js — документът с вида и бройките. */
interface BookSelectRow extends BookColumns { category_name: string | null; quantity: number; available: number }
/** Ред от читателската сметка. */
interface AccountLine {
  id: number; reader_id: number; date: IsoDate; kind: 'начисление' | 'плащане';
  type: string | null; amount: number; note: string | null; created_at: string | null;
}
/** Правилото за обезщетение за изгубен документ (loans:lostPolicy). */
interface LostPolicy {
  multiplier: number; fallback: number; multiplierSet: boolean; fallbackSet: boolean;
  defaults: { multiplier: number; fallback: number }; resolutions: string[];
}
/** Акт за отчисляване (deaccession_acts.*). */
interface ActRow {
  id: number; no: number; year: string; date: IsoDate; order_no: string | null;
  reason_code: number | null; reason_text: string | null; disposal: string | null; attach: string | null;
  committee1: string | null; committee2: string | null; committee3: string | null;
  revoked_at: string | null; revoke_reason: string | null; revoked_by: string | null;
  note: string | null; created_at: string | null; created_by: string | null; director: string | null;
}
/** Отчислен екземпляр в акта — снимката по чл. 35, ал. 2. */
interface ActItemRow {
  id: number; act_id: number; book_id: number | null; inv_number: number | null;
  author: string | null; title: string | null; volume: string | null; year: string | null;
  price: number | null; udk: string | null; category: string | null; language: string | null;
  quantity: number | null; status_before: string | null; shelves_before: string | null;
}
/** Проект за акт (deaccession_drafts.*). */
interface DraftRow {
  id: number; date: string | null; order_no: string | null; reason_code: number | null;
  reason_text: string | null; disposal: string | null; attach: string | null;
  committee1: string | null; committee2: string | null; committee3: string | null;
  note: string | null; created_at: string; updated_at: string;
}
/** Сесия за инвентаризация (inventory_sessions.*). */
interface SessionRow {
  id: number; date: IsoDate; scope: string | null; department: string | null;
  committee1: string | null; committee2: string | null; committee3: string | null;
  pool_size: number; closed: number; mode: 'full' | 'representative' | null;
  no: number | null; year: string | null; order_no: string | null;
  pool_final: number | null; on_loan: number | null; at_binder: number | null; scanned_final: number | null;
  free_access_pct: number | null; last_book_id: number | null; added_late: number | null; mzs_away: number | null;
  director: string | null;
}

/* ---------------- Договорът ---------------- */
interface IpcContract {
  /* ---- Заемане и връщане (handlers/loans.js) ---- */
  'events:localuse': { args: [{ date?: IsoDate }?]; result: true };
  'loans:list': { args: [{ onlyOpen?: boolean }?]; result: LoanRow[] };
  'loans:overdue': { args: []; result: OverdueRow[] };
  'loans:byReader': { args: [Id]; result: LoanRow[] };
  'loans:byBook': { args: [Id]; result: LoanRow[] };
  'loans:overdueByReader': {
    args: [];
    result: Array<{
      reader_id: number; name: string; address: string | null; address2: string | null;
      /** При дете с поръчител — телефонът на поръчителя. */
      phone: string | null; email: string | null; category: string | null;
      guarantor_name: string | null; guarantor_relation: string | null; guarantor_phone: string | null;
      /** Без daysLate — обработчикът не го смята тук (само loans:overdue). */
      n: number; loans: Array<Omit<OverdueRow, 'daysLate'>>; fine: number; fineAccrued: number; finePaid: number;
      notice_to: string; notice_via_guarantor: string | null;
    }>;
  };
  /** reader_id е ЧИСЛО: резервацията на същия читател се познава със === (handlers/holds.js). */
  'loans:checkout': {
    args: [{ reader_id: number; book_id: Id; date_out: IsoDate; date_due?: IsoDate | null; found?: boolean }];
    result: number;
  };
  'loans:return': {
    args: [{ id: Id; date_in?: IsoDate }];
    result: { hold: HoldBrief | null; suspendedUntil: IsoDate | null; daysLate: number; fine: number; fineNow: number; fineBefore: number };
  };
  'loans:extend': {
    args: [{ id: Id }];
    /** `max` = 0 — без ограничение на продълженията; `fine` — начисленото сега. */
    result: { date_due: IsoDate; renewals: number; max: number; daysLate: number; fine: number; suspendedUntil: IsoDate | null };
  };
  'loans:lostPolicy': { args: []; result: LostPolicy };
  'loans:lostPolicySave': { args: [{ multiplier: number | string; fallback: number | string }]; result: LostPolicy };
  'loans:lostQuote': {
    args: [{ id: Id; date?: IsoDate }];
    result: {
      loan_id: number; book_id: number; reader_id: number; title: string; author: string | null;
      inv_number: number | null; reader_name: string; card_no: string | null;
      date_out: IsoDate; date_due: IsoDate | null; price: number; basis: 'цена' | 'без цена';
      suggested: number; policy: LostPolicy; daysLate: number; fineAccrued: number; fineToAdd: number;
    };
  };
  'loans:markLost': {
    args: [{ id: Id; resolution: string; amount?: number | string; replacement_code?: string;
      replacement_note?: string; note?: string; date?: IsoDate }];
    result: {
      title: string; inv_number: number | null; reader_name: string; resolution: string; amount: number;
      account_line_id: number | null; replacement: { id: number; inv_number: number | null; title: string } | null;
      replacement_note: string | null; daysLate: number; fineAdded: number; suspendedUntil: IsoDate | null;
    };
  };
  'loans:lost': {
    args: [{ includeActed?: boolean }?];
    result: Array<{
      id: number; book_id: number; reader_id: number; date_out: IsoDate; date_due: IsoDate | null;
      lost_date: IsoDate | null; lost_resolution: string | null; lost_amount: number | null;
      lost_account_line_id: number | null; lost_replacement_book_id: number | null;
      lost_replacement_note: string | null; lost_note: string | null; fine: number | null;
      title: string; author: string | null; inv_number: number | null; price: number | null; status: string | null;
      deaccession_act_id: number | null; deaccession_date: string | null; reader_name: string; card_no: string | null;
      replacement_inv_number: number | null; replacement_title: string | null;
      acted: boolean; charge: Coverage | null; chargeMissing: boolean; chargeType: string;
    }>;
  };
  'loans:found': {
    args: [{ id: Id; reverseCharge?: boolean; date?: IsoDate; note?: string }];
    result: {
      inv_number: number | null; title: string; reader_name: string; statusBack: 'наличен' | null;
      chargeAction: string; droppedEvents: number; reversed: number; keptCharge: Coverage | null;
      fineLeft: number; hold: HoldBrief | null;
    };
  };
  'loans:checkoutByCode': {
    args: [{ reader_id: number; code: string; date_out?: IsoDate; found?: boolean }];
    result: { id: number; title: string; inv_number: number | null; date_due: IsoDate; foundBack: boolean; warning: string | null };
  };
  'loans:returnByCode': {
    args: [{ code: string; date_in?: IsoDate }];
    result: {
      title: string; inv_number: number | null; reader_name: string; daysLate: number; fine: number;
      fineNow: number; fineBefore: number; suspendedUntil: IsoDate | null; hold: HoldBrief | null;
    };
  };

  /* ---- Читателска сметка (handlers/account.js) ---- */
  'account:get': { args: [Id]; result: { lines: AccountLine[]; balance: number } };
  'account:charge': {
    args: [{ reader_id: Id; type?: string; amount: number | string; note?: string | null; date?: IsoDate }];
    result: number;
  };
  'account:pay': { args: [{ reader_id: Id; amount: number | string; note?: string | null; date?: IsoDate }]; result: number };
  'account:deleteLine': {
    args: [Id | { id: Id; reason?: string }];
    result: {
      receipt: number | null;
      loan: { loan_id: number; inv_number: number | null; title: string; before: number; after: number } | null;
      warning: string | null;
    };
  };

  /* ---- Отчисляване (handlers/deaccession-acts.js) ---- */
  'deaccessionActs:list': { args: []; result: Array<ActRow & { item_count: number; item_value: number }> };
  'deaccessionActs:get': {
    args: [Id];
    result: (ActRow & {
      items: ActItemRow[];
      holds: Array<{ id: number; status: string; status_before: string | null; placed_at: string | null;
        resolved_at: string | null; inv_number: number | null; title: string | null; author: string | null;
        reader_id: number | null; reader_name: string | null; card_no: string | null; phone: string | null }>;
      loans: Array<{ id: number; date_out: IsoDate; date_due: IsoDate | null; date_in: IsoDate | null;
        fine: number | null; deaccession_fine: number | null; lost_amount: number | null; lost_resolution: string | null;
        lost_account_line_id: number | null; inv_number: number | null; title: string | null; author: string | null;
        reader_id: number | null; reader_name: string | null; card_no: string | null; phone: string | null;
        charge?: Coverage | null }>;
    }) | null;
  };
  'deaccessionActs:nextNo': { args: [(string | number)?]; result: number };
  'deaccessionActs:findBook': {
    args: [string];
    result: (BookSelectRow & {
      fund_qty: number | null;
      lost: { lost_date: IsoDate | null; lost_resolution: string | null; lost_amount: number | null;
        lost_account_line_id: number | null; lost_replacement_note: string | null; reader_name: string | null;
        charge?: Coverage | null } | null;
    }) | undefined;
  };
  'deaccessionActs:create': {
    args: [{
      act: { date: IsoDate; no: number | string; reason_code: number | string; reason_text: string;
        committee1: string; committee3: string; order_no?: string | null; disposal?: string | null;
        attach?: string | null; committee2?: string | null; note?: string | null; created_by?: string | null };
      bookIds: Id[];
    }];
    result: number;
  };
  'deaccessionActs:drafts': { args: []; result: Array<DraftRow & { title_count: number }> };
  'deaccessionActs:getDraft': { args: [Id]; result: (DraftRow & { items: BookSelectRow[] }) | null };
  'deaccessionActs:saveDraft': {
    args: [{
      id?: Id | null;
      draft?: { date?: string | null; order_no?: string | null; reason_code?: number | string | null;
        reason_text?: string | null; disposal?: string | null; attach?: string | null;
        committee1?: string | null; committee2?: string | null; committee3?: string | null; note?: string | null };
      bookIds?: Id[];
    }];
    result: Id;
  };
  'deaccessionActs:deleteDraft': { args: [Id]; result: true };
  'deaccessionActs:approveDraft': { args: [{ id: Id; no?: number | string | null }]; result: number };
  'deaccessionActs:revoke': {
    args: [Id, { reason: string; by?: string; confirmClosedYear?: boolean }];
    result: {
      droppedHolds: number;
      shelvesToRestore: Array<{ inv_number: number | null; shelves: string }>;
      reopenedLoans: Array<{ reader_name: string | null; inv_number: number | null; charged: number }>;
      closedYear: string | null;
      keptCharges: Array<{ reader_name: string | null; inv_number: number | null; charged: number; covered: number; kind?: 'забава' }>;
      dueMoved: Array<{ reader_name: string | null; inv_number: number | null; from: IsoDate | null; to: IsoDate; fine: number }>;
    };
  };

  /* ---- Инвентаризация (handlers/inventory-sessions.js) ---- */
  'inventorySessions:list': { args: []; result: Array<SessionRow & { scanned: number; missing: number; missing_rows: number }> };
  'inventorySessions:requirement': {
    args: [];
    result: { active: number; activeDocs: number; pct: 10 | 5 | 2; target: number; scannedYear: number; naturalLoss: number };
  };
  /** Трите членове на комисията трябва да ги има като ключове (дори null) — именувани параметри на SQL. */
  'inventorySessions:start': {
    args: [{ date: IsoDate; no?: number | string | null; scope?: string | null; department?: string | null;
      order_no?: string | null; committee1: string | null; committee2: string | null; committee3: string | null }];
    result: number;
  };
  'inventorySessions:get': {
    args: [Id, { preview?: boolean }?];
    result: (SessionRow & {
      scans: Array<{ id: number; session_id: number; book_id: number; scanned_at: string; inv_number: number | null;
        title: string; quantity: number }>;
      missing: Array<{ id: number; session_id: number; book_id: number | null; inv_number: number | null; title: string | null;
        author: string | null; price: number | null; quantity: number; on_loan_now: number; live_qty: number | null }>;
      missingDocs: number; allowedLoss: number; mzsAway: number | null; addedLate: number | null; lostBefore: number | null;
      preview?: { pool: number; scanned: number; outOfScope: number; onLoan: number; mzsAway: number; atBinder: number;
        lostBefore: number; addedLate: number; missingIfFull: number; lateTracked: boolean };
    }) | null;
  };
  'inventorySessions:scan': {
    args: [{ sessionId: Id; code: string }];
    result: { inv_number: number | null; title: string; quantity: number;
      lost: { loan_id: number | null; reader_name: string | null; card_no: string | null; lost_date: IsoDate | null;
        lost_amount: number | null; message: string } | null };
  };
  'inventorySessions:close': {
    args: [Id | { sessionId: Id; mode?: 'full' | 'representative' }];
    result: { mode: 'full' | 'representative'; scanned: number; missing: number; missingRows: number; pool: number;
      poolRows: number; outOfScope: number; unchecked: number; onLoan: number; atBinder: number; lostBefore: number;
      lostBeforeRows: number; mzsAway: number; addedLate: number; allowedLoss: number };
  };
}
