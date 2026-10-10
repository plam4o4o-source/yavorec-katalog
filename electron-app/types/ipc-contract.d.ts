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
type IpcResult<T> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; error: string; data?: undefined };
/** Полетата ДО `data` (v2.4.77) — канал, който ги има, ги описва в записа си
    като `extra`. Отговорът няма „свободни“ полета: непознато поле е грешка и
    на екрана, и в обработчика. */
type IpcExtra<C extends keyof IpcContract> = IpcContract[C] extends { extra: infer X } ? Partial<X> : {};

/** Типът на метод от window.api за описан канал. Канал, чийто отговор зависи от
    аргументите (прозорец или целият списък, етикети…), описва и `call` — отделен
    подпис за всеки режим; тогава екранът получава точния отговор за своя режим,
    а обработчикът пак вижда `args` (всички режими наведнъж). */
type IpcMethod<C extends keyof IpcContract> =
  IpcContract[C] extends { call: infer F } ? F
    : (...args: IpcContract[C]['args']) => Promise<IpcResult<IpcContract[C]['result']> & IpcExtra<C>>;
/** Аргументът на обработчика (по подразбиране първият след `e`). */
type IpcArg<C extends keyof IpcContract, I extends number = 0> = IpcContract[C]['args'][I];
/** Данните в отговора на канала. */
type IpcData<C extends keyof IpcContract> = IpcContract[C]['result'];
/** Какво връща обработчикът на канала (v2.4.77): отговорът през run() с данните
    от договора — обработчик, който връща друго, е грешка при проверката. */
type IpcReply<C extends keyof IpcContract> = (IpcResult<IpcData<C>> & IpcExtra<C>) | Promise<IpcResult<IpcData<C>> & IpcExtra<C>>;
/** Същото за асинхронен обработчик. */
type IpcAsyncReply<C extends keyof IpcContract> = Promise<IpcResult<IpcData<C>> & IpcExtra<C>>;
/** Зависимостите, които main.js подава на всеки handlers/*.js. Описан е run() —
    той носи типа на данните до отговора; останалите са различни за всеки модул. */
interface HandlerDeps {
  run<T>(fn: () => T): IpcResult<T>;
  [dep: string]: any;
}

/* ---------------- Общи редове ---------------- */

/** Покритие на начисление с плащания (chargeCoverage, handlers/account.js). */
interface Coverage { charged: number; covered: number; outstanding: number }
/** Резервацията, заделена при връщане — кого да повика библиотекарката. */
interface HoldBrief { reader_name: string; card_no: string | null; phone: string | null }

/** Ред от loans (l.*). */
interface LoanColumns extends DbLoans {}
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
interface BookColumns extends DbBooks {}
/** BOOK_SELECT в handlers/books.js — документът с вида и бройките. */
interface BookSelectRow extends BookColumns { category_name: string | null; quantity: number; available: number }
/** Ред от читателската сметка. */
interface AccountLine extends DbAccountLines {
  kind: 'начисление' | 'плащане';
}
/** Правилото за обезщетение за изгубен документ (loans:lostPolicy). */
interface LostPolicy {
  multiplier: number; fallback: number; multiplierSet: boolean; fallbackSet: boolean;
  defaults: { multiplier: number; fallback: number }; resolutions: string[];
}
/** Акт за отчисляване (deaccession_acts.*). */
interface ActRow extends DbDeaccessionActs {}
/** Отчислен екземпляр в акта — снимката по чл. 35, ал. 2. */
interface ActItemRow extends DbDeaccessionItems {}
/** Проект за акт (deaccession_drafts.*). */
interface DraftRow extends DbDeaccessionDrafts {}
/** Сесия за инвентаризация (inventory_sessions.*). */
interface SessionRow extends DbInventorySessions {
  mode: 'full' | 'representative' | null;
}

/* ---------------- Общи редове (група A) ---------------- */

/** Ред от авторската таблица за показване на човек („ВАЗОВ, И“ → „В-14“). */
interface AuthorMarkRef { prefix: string; mark: string }
/** Предложение за авторски знак, когато таблицата дава ред (suggestFor в handlers/author-mark.js). */
interface AuthorMarkHit {
  ok: true; mark: string; basis: string; from: 'author' | 'title';
  /** false — името е без запетая и фамилията е предположение (последната дума). */
  exact: boolean;
  prefix: string; num: string; letter: string;
  /** Буквата на реда, когато е различна от буквата на фамилията (Й се търси от И). */
  fromLetter: string | null;
  refine: AuthorMarkRef[];
  /** Няма го при успех — стои, за да се чете `s.reason` от обединението (без strictNullChecks `!s.ok` не стеснява). */
  reason?: undefined;
}
/** Отказ от предложение — причината е изречение за екрана (suggestFor). */
interface AuthorMarkMiss { ok: false; reason: string }

/** Полетата под контрол на авторитетните данни (AUTHORITY_FIELDS в handlers/authorities.js). */
type AuthorityField = 'author' | 'publisher' | 'city' | 'language' | 'udk' | 'keywords' | 'department' | 'series';
/** Стойност на поле с броя документи: `n` — всички описани, `avail` — от тях в наличност. */
interface AuthorityValueRow { value: string; n: number; avail: number }

/** Картонът на документа, какъвто го праща формата (formData('#bookF')) към books:create/update.
    Липсващо поле се записва като NULL (записът е пълна подмяна на реда); status_date и cn_sort
    не се четат — обработчикът ги смята сам (bookPayload). */
interface BookInput {
  title: string;
  inv_number?: Id | null; barcode?: string | null; register_date?: IsoDate | null;
  subtitle?: string | null; author?: string | null; category_id?: Id | null;
  year?: string | number | null; volume?: string | null; isbn?: string | null; pages?: string | number | null;
  language?: string | null; udk?: string | null; call_number?: string | null; author_mark?: string | null;
  city?: string | null; publisher?: string | null; series?: string | null; series_no?: string | null;
  keywords?: string | null; annotation?: string | null; cover_url?: string | null; department?: string | null;
  permanent_location?: string | null; status?: string | null; description?: string | null;
  /** Сума в евро — число или текст със запетая/точка; отрицателна или нечислова се отказва. */
  price?: number | string | null;
  acquisition_id?: Id | null;
  /** Бройката — само 1 (празно: 1 при вписване, текущата при редакция); 0 и >1 се отказват. */
  quantity?: number | string | null;
}
/** Прескочените инвентарни номера при ръчно въведен по-голям номер (invGapNotice). */
interface BookInvGapNotice { inv_number: number; from: number; to: number; skipped: number; message: string }
/** Кой вече носи същия ISBN (sameIsbn в handlers/books.js). */
interface BookIsbnMatch { id: number; inv_number: number | null; title: string; count: number; message: string }
/** BOOK_LIST_SELECT — леката проекция на списъка „Книги“. */
interface BookListRow extends Pick<BookColumns, 'id' | 'inv_number' | 'barcode' | 'title' | 'author' | 'category_id'
  | 'year' | 'udk' | 'call_number' | 'author_mark' | 'department' | 'status' | 'series' | 'series_no'> {
  category_name: string | null; quantity: number; available: number;
}
/** LABEL_SELECT — шестте полета, които се печатат на етикет. */
interface BookLabelRow extends Pick<BookColumns, 'inv_number' | 'barcode' | 'call_number' | 'author_mark' | 'udk' | 'status'> {}
/** Третият аргумент на books:list: labels → етикети; idsOnly → само id; иначе прозорец. */
interface BooksListPage {
  /** Прозорец: по подразбиране 300, таван 3 000. */
  offset?: number | string; limit?: number | string;
  dept?: string; cat?: Id | null;
  idsOnly?: boolean;
  /** Етикети: границите на инвентарния номер (празно — без граница); query и sort се пренебрегват. */
  labels?: boolean; from?: number | string | null; to?: number | string | null;
}
/** Отговорът на books:list с прозорец. */
interface BooksListWindow { rows: BookListRow[]; total: number; depts: string[]; offset: number; limit: number }
/** Празно място в поредицата на инвентарната книга и обяснението му от дневника (books:invGaps). */
interface BookInvGap {
  from: number; to: number; why: 'изтрит' | 'прескочен' | 'без следа';
  /** Денят от дневника (местно време) — null при „без следа“. */
  ts: string | null;
  /** Заглавието на изтрития документ; null иначе. */
  title: string | null;
}
/** Резултат от разделянето на запис с няколко бройки (splitOneCopy/detachMissingCopies). */
interface BookSplitResult { created: number[]; createdIds: number[]; inv_number: number | null; title: string }

/** Вид документ (categories.*). `code` имат само началните видове. */
interface CategoryRow { id: number; name: string; code: string | null }

/** Витрина в онлайн каталога (catalog_shelves.*). */
interface ShelfRow { id: number; name: string; sort: number | null }
/** Документ във витрина (shelves:items) — `published` казва дали стига до сайта. */
interface ShelfItemRow {
  id: number; inv_number: number | null; title: string; author: string | null; status: string | null;
  department: string | null; published: 0 | 1; act_no: number | null; act_year: string | null;
}

/** Последният опит за запис на katalog.json (CATALOG_LAST_WRITE в main.js). */
interface CatalogWriteState {
  at: string; ok: boolean; blocked: boolean; error: string | null;
  published: number | null; now: number | null; message: string | null; folder: string | null;
}
/** Накъде сочи origin на свързаната папка (gitRemoteSlug) — user/repo са празни за адрес извън GitHub. */
interface CatalogRemoteSlug { user: string; repo: string; url: string }

/* ---------------- Общи редове (група B) ---------------- */

/** Ред от readers (r.*). */
interface ReaderColumns extends DbReaders {}
/** Читател след maskReaderRow (handlers/pdp.js) — ЕГН/№ ЛК може да са заменени с надпис. */
interface ReaderRow extends ReaderColumns {
  pii_masked?: true; pii_masked_fields?: string[]; pii_masked_reason?: 'unreadable' | 'stale' | 'locked';
}
/** Ред от readers:list — читателят с броя отворени и просрочени заемания. */
interface ReaderListRow extends ReaderRow { open_loans: number; overdue_loans: number }
/** Прозорецът на readers:list (третият аргумент `page`) — порция и броячи. */
interface ReaderListPage {
  offset?: number; limit?: number; cat?: string | null; status?: string | null;
  consent?: 'yes' | 'no' | ''; rereg?: 'due' | '';
}
/** Отговорът на readers:list, когато е подаден `page`. */
interface ReaderListWindow {
  rows: ReaderListRow[]; total: number; offset: number; limit: number; noConsent: number; reregDue: number;
}
/** Полетата на картона, които readers:create/update записват (READER_FIELDS). Празен низ = NULL. */
interface ReaderInput {
  name: string; phone?: string | null; address?: string | null; address2?: string | null;
  email?: string | null; card_no?: string | null; egn?: string | null; id_card_no?: string | null;
  id_card_date?: string | null; id_card_issuer?: string | null; birth_date?: string | null;
  category?: string | null; registered_at?: string | null; re_registered_at?: string | null;
  status?: string | null; gdpr_consent?: boolean | number | null; gdpr_consent_date?: string | null;
  parent_consent?: boolean | number | null; parent_consent_date?: string | null;
  guarantor_name?: string | null; guarantor_relation?: string | null; guarantor_phone?: string | null;
  note?: string | null; alert_note?: string | null;
}
/** Повикан за заделена книга читател (readers:delete, gdpr:forgetReader). */
interface HoldActivated { name: string; phone: string | null; title: string; inv_number: number | null }

/** Ред от holds (h.*) — с колоните, които отчисляването добавя (deaccession_act_id, status_before). */
interface HoldColumns extends DbHolds {
  status: 'чака' | 'заделена' | 'изпълнена' | 'отказана' | null;
}
/** HOLD_SELECT в handlers/holds.js — резервацията с документа и читателя. */
interface HoldRow extends HoldColumns {
  title: string; author: string | null; inv_number: number | null; barcode: string | null;
  reader_name: string; card_no: string | null; phone: string | null;
}

/** Профил за обслужване по домовете (housebound_profiles.*). */
interface HouseboundProfileRow extends DbHouseboundProfiles {}
/** Посещение по домовете (housebound_visits.*). */
interface HouseboundVisitRow extends DbHouseboundVisits {}

/** Правило за обслужване по категория (circulation_rules.*); NULL = общата настройка. */
interface CircRuleRow extends DbCirculationRules {}
/** Ефективното правило (circRule в handlers/circ-rules.js) — сроковете винаги са число. */
interface CircRuleEffective {
  loan_days: number; extension_days: number; max_books: number | null; extensions_count: number | null;
  suspend_per_day: number | null; suspend_max: number | null;
}

/** Затворен ден от календара (calendar_closed.*). */
interface CalendarClosedRow { date: IsoDate; reason: string | null }
/** Отговорът при промяна на календара — колко падежа са преместени и изречението за тях. */
interface CalendarShift { moved: number; message: string | null }

/** Служител (employees.*). */
interface EmployeeRow extends DbEmployees {}

/** Заявка за МЗС (mzs_requests.*). */
interface MzsRow extends DbMzsRequests {}
/** Полетата, които mzs:create/update четат. Читателят — по карта (reader_card) или id;
    нашият документ — по инв. №/баркод (book_code) или id. */
interface MzsInput {
  no?: number | string | null; date?: IsoDate; direction?: string; partner?: string; title?: string;
  author?: string | null; isbn?: string | null; requester?: string | null; status?: string;
  due_date?: IsoDate | '' | null; note?: string | null;
  reader_card?: string | null; reader_id?: Id | null; book_code?: string | null; book_id?: Id | null;
}

/** Предложение за покупка (suggestions.*). */
interface SuggestionRow extends DbSuggestions {}
/** Състоянията на предложението (SUGGESTION_STATUSES в handlers/suggestions.js). */
type SuggestionStatus = 'заявено' | 'одобрено' | 'поръчано' | 'получено' | 'отказано';

/** Изгубен документ, намерен при проверка (lostCaseOf в handlers/inventory-sessions.js). */
interface MobileLostCase {
  loan_id: number | null; reader_name: string | null; card_no: string | null;
  lost_date: IsoDate | null; lost_amount: number | null; message: string;
}

/** Читател с просрочени документи и готовите текстове на напомнянето (loans:reminders). */
interface ReminderRow {
  reader_id: number; name: string;
  /** При дете с гарант — телефонът на гаранта; телефонът от картона е в reader_phone. */
  phone: string | null;
  /** При дете — имейлът на гаранта (засега винаги null); имейлът от картона е в reader_email. */
  email: string | null;
  category: string | null; guarantor_name: string | null; guarantor_relation: string | null;
  guarantor_phone: string | null; n: number; oldest_due: IsoDate;
  loans: Array<Omit<OverdueRow, 'daysLate'>>;
  fine: number; fineAccrued: number; finePaid: number;
  notice_to: string; notice_via_guarantor: string | null;
  reader_phone: string | null; reader_email: string | null; email_note: string | null;
  level: 1 | 2 | 3;
  lastNotice: { level: number | null; ts: string | null } | null;
  subject: string; body: string; sms: string;
}

/* ---------------- Общи редове (група C) ---------------- */

/** Ред от acquisitions (a.*) — партида в КДБФ Част № 1. */
interface AcqColumns extends DbAcquisitions {
  /** NULL = стойност не е обявена в първичния документ; 0 = обявена нула. */
  sum: number | null;
}
/** Полетата на партидата от формата (acquisitions:create / :update) — стойностите идват като низове. */
interface AcqInput {
  date: IsoDate; how?: string | null; from_source?: string | null; doc_type?: string | null;
  doc_no?: string | null; doc_date?: IsoDate | null; total_count?: number | string | null;
  sum?: number | string | null; donor_address?: string | null; note?: string | null;
  committee1?: string | null; committee2?: string | null; committee3?: string | null;
}

/** Ред от periodicals (p.*) — картон на периодично издание. */
interface PeriodicalColumns extends DbPeriodicals {}
/** Полетата на картона на изданието от формата (periodicals:create / :update). */
interface PeriodicalInput {
  title: string; freq?: string | null; publisher?: string | null; issn?: string | null;
  department?: string | null; note?: string | null;
  /** Липсващ (undefined) при редакция значи „не пипай“; празен — „български“. */
  language?: string | null;
}
/** Ред от periodical_issues (i.*) — постъпил брой в кардекса. */
interface PeriodicalIssueRow extends DbPeriodicalIssues {}
/** Година в картона на изданието (volumeRows в handlers/periodicals.js) — броеве и инвентиран комплект. */
interface PeriodicalVolumeRow {
  year: string; issue_count: number; issue_sum: number;
  volume_id: number | null; book_id: number | null; registered_issue_count: number | null;
  inv_number: number | null; register_date: string | null; volume_price: number | null; status: string | null;
  deaccession_date: string | null; acq_no: number | null; acq_year: string | null;
}
/** Прескочени инвентарни номера при ръчно въведен номер (като invGap на books:create). */
interface PeriodicalInvGap { inv_number: number; from: number; to: number; skipped: number; message: string }

/** Ред от analytics (a.*) — аналитично описание. */
interface AnalyticColumns extends DbAnalytics {}
/** ANALYTIC_SELECT в handlers/analytics.js — описанието с източника му във фонда. */
interface AnalyticRow extends AnalyticColumns {
  periodical_title: string | null;
  /** Заглавието на книгата-носител; при отчислена — с белег „(отчислен с акт № N/год.)“. */
  book_title: string | null; book_author: string | null; book_inv: number | null; book_status: string | null;
}
/** Полетата на описанието от формата (analytics:create / :update); id-тата идват като низове. */
interface AnalyticInput {
  title: string; subtitle?: string | null; author?: string | null;
  source_kind?: 'периодика' | 'книга' | 'друго' | null;
  periodical_id?: Id | null; book_id?: Id | null; source_text?: string | null;
  year?: string | null; issue?: string | null; issue_date?: IsoDate | null; pages?: string | null;
  udk?: string | null; keywords?: string | null; annotation?: string | null;
  is_local?: boolean | number; note?: string | null;
}

/** Ред от persons без снимката (LIST_COLS в handlers/persons.js). */
interface PersonColumns extends Omit<DbPersons, 'photo'> {
  /** Точна дата (ISO) или година като текст — „1890“, „ок. 1890“. */
  birth_date: string | null;
}
/** Персоналия в списъка (persons:list) — без снимката, с броя на връзките в двете посоки. */
interface PersonListRow extends PersonColumns { has_photo: number; links: number; backlinks: number }
/** Картон със същия ключ на името (persons:list с { sameAs }). */
interface PersonNamesakeRow {
  id: number; name: string; birth_date: string | null; death_date: string | null; activity: string | null;
}
/** Полетата на персоналията от формата (persons:create / :update). */
interface PersonInput {
  name: string; alt_names?: string | null; birth_date?: string | null; birth_place?: string | null;
  death_date?: string | null; death_place?: string | null; activity?: string | null; bio?: string | null;
  awards?: string | null; sources?: string | null; note?: string | null;
}

/** Ред от chronicle без снимката — запис в летописа. */
interface ChronicleColumns extends Omit<DbChronicle, 'photo'> {}
/** Полетата на летописния запис от формата (chronicle:create / :update). */
interface ChronicleInput {
  /** Може да липсва само при точна дата — тогава се взема от нея. */
  year?: string | null; date?: IsoDate | null; title: string; body?: string | null; category?: string | null;
  participants?: string | null; sources?: string | null; note?: string | null;
}

/** Откъде тръгва краеведска връзка (LINK_FROM в handlers/links.js). */
type LinkFromKind = 'персона' | 'летопис';
/** Към какво сочи краеведска връзка (LINK_TO в handlers/links.js). */
type LinkToKind = 'книга' | 'статия' | 'летопис' | 'персона' | 'периодика';
/** Ред от links (l.*) — видовете са текст от базата. */
interface LinkColumns extends DbLinks {}
/** Връзка навън с етикета на целта (links:list). */
interface LinkRow extends LinkColumns { label: string }
/** Обратна връзка (links:backlinks): ред от links ИЛИ статия с този документ за източник (source: true, id: null). */
interface LinkBacklinkRow {
  id: number | null; source?: true; from_kind: string; from_id: number; to_kind: string; to_id: number;
  note?: string | null; created_at?: string | null;
  /** Етикетът на ИЗТОЧНИКА (персоналия, летопис, статия). */
  label: string;
  /** Етикетът на ЦЕЛТА — за книга с белега за отчисляване. */
  to_label: string;
}

/** Ключ на номенклатура (AV_CATEGORIES в handlers/av.js). */
type AvCategory = 'department' | 'language' | 'location';
/** Стойност от номенклатура (authorised_values) с публичния ѝ надпис. */
interface AvOption { value: string; opac_label: string | null }

/** Статус на защитата на ЕГН/№ ЛК (pdp:status). */
interface PdpStatus { configured: boolean; unlocked: boolean; stale: boolean; unreadable: number }

/** Онлайн достъп за читатели (handlers/online-access.js, v2.4.76). Без код за
    активация status връща само { activated: false } — екраните не показват нищо. */
type OnlineStatus =
  | { activated: false }
  | {
    activated: true; lib: string; name: string; exp: IsoDate; bridgeUrl: string; hasUploadKey: boolean;
    lastSync: string | null; lastError: string | null; consentingReaders: number; pending: boolean;
  };

/** Отговор към моста за заявка на читател от мобилното приложение (v2.4.81,
    processRequests в handlers/online-access.js): „удължи“ е изпълнено или отказано
    с кратка причина на български. Пази се в online_request_results, за да е
    отговорът същият при повторно получена заявка. */
type OnlineRequestResult =
  | { id: string; status: 'done' }
  | { id: string; status: 'rejected'; reason: string };
/** Отворено заемане в снимката за моста (buildSnapshot в online-access.js). */
interface OnlineSnapshotLoan {
  loanId: string; inv: number | null; title: string; author: string;
  dateOut: IsoDate; dateDue: IsoDate | null; renewals: number;
  /** Може ли читателят да го удължи от приложението — renewGate в handlers/loans.js. */
  canRenew: boolean;
}
/** Приключено заемане от историята на читателя в снимката (до 200, най-новите първи). */
interface OnlineSnapshotHistoryItem {
  loanId: string; inv: number | null; title: string; author: string; dateOut: IsoDate; dateIn: IsoDate;
}

/** Лично съобщение от библиотеката до читател (reader_messages, v2.4.82). */
interface ReaderMessage extends DbReaderMessages {}
/** Лично съобщение в снимката за моста (buildSnapshot; договорът, раздел 1). */
interface OnlineSnapshotMessage {
  messageId: string; title: string; text: string; at: string; readAt: string | null;
}

/** Колона от Дневника (DNEVNIK_FIELDS в handlers/dnevnik.js) — 30 в Раздел А и 36 в Раздел Б. */
type DnevnikField =
  | 'a_hours' | 'a_age_u14' | 'a_age_15_18' | 'a_age_19_28' | 'a_age_o28'
  | 'a_sex_boys' | 'a_sex_men' | 'a_sex_girls' | 'a_sex_women'
  | 'a_edu_basic' | 'a_edu_sec' | 'a_edu_high'
  | 'a_prof_industry' | 'a_prof_agri' | 'a_prof_eng' | 'a_prof_agrospec' | 'a_prof_med' | 'a_prof_sci'
  | 'a_prof_hum' | 'a_prof_creative' | 'a_prof_teach' | 'a_prof_other'
  | 'a_stud_uni' | 'a_stud_high' | 'a_stud_sec' | 'a_stud_elem'
  | 'a_visit_home' | 'a_visit_child' | 'a_visit_reading' | 'a_visit_internet'
  | 'b_hours'
  | 'b_type_books' | 'b_type_period' | 'b_type_graphic' | 'b_type_carto' | 'b_type_music'
  | 'b_type_audio' | 'b_type_video' | 'b_type_electronic' | 'b_type_dvd' | 'b_type_talking'
  | 'b_lang_bg' | 'b_lang_ru' | 'b_lang_slavic' | 'b_lang_en' | 'b_lang_de' | 'b_lang_fr' | 'b_lang_other'
  | 'b_cat_0' | 'b_cat_1' | 'b_cat_2' | 'b_cat_3' | 'b_cat_5' | 'b_cat_61' | 'b_cat_62' | 'b_cat_63'
  | 'b_cat_7' | 'b_cat_793' | 'b_cat_80' | 'b_cat_82' | 'b_cat_9' | 'b_cat_91'
  | 'b_cat_fiction' | 'b_cat_child_nf' | 'b_cat_child_f' | 'b_cat_reading_used';
/** Изчислените „Всичко“ на реда от Дневника (dnevnikTotals). */
interface DnevnikTotals {
  a_total_age: number; a_total_sex: number; a_total_edu: number; a_total_prof: number;
  b_total_type: number; b_total_lang: number; b_total_content: number;
}
/** Ден от месеца (dnevnik:getMonth → days). Колоните липсват, ако за деня няма ред в dnevnik_days. */
interface DnevnikMonthDay extends Partial<Record<DnevnikField, number | null>>, DnevnikTotals {
  day: number; date: IsoDate; id?: number; note?: string | null;
  closed: boolean; closedReason: string | null;
  /** Поне една ненулева колона или бележка. */
  filled: boolean;
}
/** Сбор за месеца или от началото на годината (dnevnikSumRow). */
interface DnevnikSumRow extends Record<DnevnikField, number>, DnevnikTotals {}
/** Записът на ден (dnevnik:saveDay): САМО подадените колони се пишат; числата идват и като низове. */
interface DnevnikSaveInput extends Partial<Record<DnevnikField, number | string | null>> {
  date: IsoDate; note?: string | null;
}

/** Обединеният резултат от Google Books и Open Library (isbn:lookup); липсващо поле е ''. */
interface IsbnLookupData {
  isbn: string; title: string; subtitle: string; author: string; publisher: string; city: string;
  year: string; pages: string; language: string; keywords: string; annotation: string; cover_url: string;
  /** „Google Books и Open Library“ — откъдето е дошло. */
  sources: string;
}
/** MARC запис от SRU сървъра (marcToBook в handlers/isbn-lookup.js); липсващо поле е ''. */
interface SruRecord {
  source: 'SRU (MARC)'; title: string; subtitle: string; author: string; publisher: string; city: string;
  year: string; pages: string; language: string; keywords: string; annotation: string; cover_url: string;
  isbn: string;
}

/* ---------------- Общи редове (група D) ---------------- */

/** Ред от settings (SELECT * FROM settings WHERE id = 1) — db/schema.sql + ensureColumns/миграции 2 и 6 в main.js. */
interface SettingsRow extends DbSettings {
  /** Логото като data URI. */
  logo: string | null;
  /** Без DEFAULT: NULL = „по подразбиране“ (3 × цената, 10 €). */
  lost_price_multiplier: number | null;
  /** Миграция 2 — защитата на личните данни. */
  pdp_salt: string | null;
  /** Миграция 6. */
  holidays_seeded: string | null;
}
/** Формулярът на settings:update — ВСИЧКИТЕ 28 ключа са задължителни (именувани параметри на UPDATE в better-sqlite3).
    Числовите идват от полетата като текст („40,5“); празен низ/null = „по подразбиране“ (записва се NULL). */
interface SettingsUpdateInput {
  org: string | null; lib_name: string | null; place: string | null; bulstat: string | null; reg_no: string | null;
  director: string | null; director_role: string | null; librarian: string | null; cat_url: string | null;
  loan_days: number | string | null; max_books: number | string | null; extensions_count: number | string | null;
  extension_days: number | string | null; fine_per_day: number | string | null; annual_fee: number | string | null;
  /** Процент 0–100, иначе обработчикът хвърля и нищо не записва. */
  free_access_pct: number | string | null;
  next_inv_number: number | string | null;
  committee1: string | null; committee2: string | null; committee3: string | null;
  sru_endpoint: string | null;
  suspend_per_day: number | string | null; suspend_max: number | string | null;
  remind2_days: number | string | null; remind3_days: number | string | null; anonymize_years: number | string | null;
  lost_price_multiplier: number | string | null; lost_fallback_amount: number | string | null;
}
/** Формулярът за формат на етикетите (settings:updateLabelFormat) — всичко по желание, липсващото/нечисловото пада към подразбиращото. */
interface SettingsLabelFormatInput {
  /** 'roll' — ролка; всичко друго се записва като 'sheet'. */
  lbl_mode?: string;
  lbl_w?: number | string | null; lbl_h?: number | string | null; lbl_cols?: number | string | null;
  lbl_mt?: number | string | null; lbl_ml?: number | string | null; lbl_gx?: number | string | null; lbl_gy?: number | string | null;
  /** Стар извикващ: едно поле/едно разстояние — попълват четирите нови, ако те липсват. */
  lbl_margin?: number | string | null; lbl_gap?: number | string | null;
  /** Истинност → 1/0. */
  lbl_border?: boolean | number | string | null;
  sig_w?: number | string | null; sig_h?: number | string | null; card_w?: number | string | null; card_h?: number | string | null;
}
/** Стойност от формата за етикети, подрязана до допустимата граница. */
interface SettingsLabelClamp { field: string; label: string; given: number; saved: number }

/** Файл в папката с резервните копия (backup:list). `mtime` е в милисекунди. */
interface BackupFileRow { name: string; path: string; size: number; mtime: number; auto: boolean; encrypted: boolean }
/** Последният опит за дублиране във втората папка. */
interface BackupSecondCopy { ok: boolean; at: string; folder: string; file: string | null; error: string | null }
/** Състоянието на втората папка за копия (backup:secondFolder и `second` в backup:autoStatus). */
interface BackupSecondFolderState {
  /** Празен низ, ако не е зададена. */
  folder: string; configured: boolean; available: boolean | null; last: BackupSecondCopy | null; canConfigure: boolean;
}
/** Последният опит за автоматично копие (успешен или не). */
type BackupAutoAttempt =
  | { ok: true; at: string; date: IsoDate; path: string; encrypted: boolean }
  | { ok: false; at: string; date: IsoDate; kind: string; message: string };
/** Състоянието на автоматичното копие за картата в „Настройки“ (backup:autoStatus). */
interface BackupAutoStatus {
  encrypted: boolean;
  state: 'encrypted' | 'failed' | 'locked' | 'off';
  pdpConfigured: boolean; pdpUnlocked: boolean;
  today: { date: IsoDate; path: string; encrypted: boolean } | null;
  plainDailyCount: number; plainIntradayCount: number; plainRestoreCount: number; plainManualCount: number;
  last: { path: string; encrypted: boolean; date: IsoDate } | null;
  /** Провалът на КРИПТИРАНЕТО за днес (не на самото писане). */
  failure: { date: IsoDate; message: string; at: string; kind: string } | null;
  warning: string | null;
  newest: { name: string; path: string; mtime: number; size: number } | null;
  ageDays: number | null; stale: boolean;
  lastAttempt: BackupAutoAttempt | null;
  keepPolicy: { dailyDays: number; weeklyDays: number; monthlyDays: number };
  second: BackupSecondFolderState;
}

/** Ред от audit_log (SELECT *). `diff` е JSON [{field, before, after}] или NULL. */
interface AuditLogRow extends DbAuditLog {}

/** Бързите числа на таблото (dashboard:stats). */
interface DashboardStats { books: number; readers: number; loansOpen: number; overdue: number }
/** Пълното табло (dashboard:full). */
interface DashboardFull {
  fundCount: number; fundValue: number; activeReaders: number; loansOpen: number; overdueCount: number;
  /** Първите 7 просрочени; daysLate е null само без effectiveDaysLate в зависимостите. */
  overdueRows: Array<LoanRow & { daysLate: number | null }>;
  overdueBuckets: { d7: number; d30: number; more: number };
  /** Винаги 12 седмици, последната е текущата. */
  loansWeeks: number[];
  year: string; acquiredYear: number; deaccessionedYear: number; loansYear: number; readersYear: number;
  inventoryTarget: number; inventoryScannedYear: number; inventoryPct: 10 | 5 | 2;
  /** Прозорец от най-много 40 реда; общият брой е upcomingCount. */
  upcoming: LoanRow[]; upcomingCount: number; upcomingByDay: Array<{ date: IsoDate; n: number }>;
  holdsReady: number; holdsWaiting: number;
  today: {
    reregDue: number; longOverdue: number; anonCandidates: number; suspendedNow: number;
    isTodayOpen: boolean; dueReminders: number; overduePeriodicals: number; dnevnikFilled: boolean;
  };
}

/** Мястото на базата (dbLocation:get). */
interface DbLocationInfo { folder: string; isDefault: boolean; isPackaged: boolean }

/** Пълният износ в ZIP (exportAll:run). `tables` е без PROCHETI-ME.txt. */
interface ExportAllResult { path: string; tables: number; rows: number; pdpLocked: boolean }

/** Брой и стойност в една от страните на находка при съгласуването на фонда. */
interface FundCheckSide { label: string; n: number; v: number }
/** Една находка на проверката на фондовите числа (fund:check). */
interface FundCheckFinding {
  key: 'chain' | 'keys' | 'baddate' | 'nobatch';
  level: 'тежко' | 'важно' | 'бележка';
  title: string;
  a?: FundCheckSide; b?: FundCheckSide;
  diff?: { n: number; v: number };
  why: string;
  /** Може да е празен низ. */
  todo: string;
  /** Само при 'baddate' — до 200 документа без валидна дата на вписване. */
  list?: Array<{ id: number; inv_number: number | null; title: string; register_date: string | null }>;
}
/** Резултатът на проверката на фонда за година. */
interface FundCheckResult { year: number; findings: FundCheckFinding[]; ok: boolean }

/** Прочетеният файл за внос — прегледът преди съответствието (import:choose / import:load). */
interface ImportPreview {
  path: string; encoding: string; delimiter: string | null; warning: string | null;
  headers: string[];
  /** Индекс на колона (като ключ) → поле от IMPORT_FIELDS. */
  mapping: Record<string, string>;
  /** Първите 8 реда; колоните „Дата на вписване“ вече са ISO. */
  preview: string[][];
  previewDateCols: number[]; total: number;
  /** Полето → надписът му (IMPORT_FIELDS в handlers/data-import.js). */
  fields: Record<string, string>;
}
/** Настройките на вноса (формата #impOptF). */
interface ImportOptions {
  skipDuplicates?: boolean; defaultDepartment?: string; defaultLanguage?: string; defaultCategory?: string;
  /** Празно = днешна дата за редовете без дата; нечетима или бъдеща дата — отказ. */
  defaultRegisterDate?: IsoDate | string;
}
/** Отчетът след вноса (import:run). */
interface ImportReport {
  added: number; skipped: number;
  errors: Array<{ line: number; error: string }>;
  usedInv: Array<{ line: number; inv: number }>;
  warnings: string[];
  /** inv е суровият текст от файла, когато номерът не е разчетен. */
  skippedRows: Array<{ line: number; inv: number | string | null; title: string; reason: string }>;
  convertedLeva: number; priceEuro: number; priceEmpty: number; priceBad: number; priceNote: string | null;
  futureDated: Array<{ line: number; inv: number | null; title: string; date: string }>;
  futureDatedCount: number; futureDateNote: string | null;
  registerDateDefaulted: number; registerDateDefault: IsoDate | null;
  fileWarning: string | null;
  deaccessionedToNote?: number; statusToNote?: number; catalogNote?: string;
}

/** Ред от инвентарната книга (INV_BOOK_SELECT в handlers/inv-book.js) с датите на проверките. */
interface InvBookRow {
  id: number; inv_number: number | null; register_date: string | null; title: string; author: string | null;
  volume: string | null; year: string | null; price: number | null; call_number: string | null; status: string | null;
  description: string | null; udk: string | null; author_mark: string | null; quantity: number;
  category_name: string | null; acq_no: number | null; acq_date: string | null; act_no: number | null; act_date: string | null;
  checks: string[];
}
/** Показателите над инвентарната книга — по целия регистър. */
interface InvBookSummary {
  rows: number; activeCopies: number; value: number; deacc: number; undatedRows: number; undatedCopies: number; checked: number;
}
/** Прозорец от инвентарната книга. `summary` е само при offset 0 и summary !== false. */
interface InvBookPage { rows: InvBookRow[]; total: number; offset: number; limit: number; summary: InvBookSummary | undefined }

/** Брой документи и стойност в КДБФ. */
interface KdbfSum { n: number; v: number }
/** Партида в Част № 1 на КДБФ (acquisitions.* + вписаното по нея). */
interface KdbfAcquisitionRow {
  id: number; no: number; year: string; date: string; how: string | null; from_source: string | null;
  doc_type: string | null; doc_no: string | null; doc_date: string | null; total_count: number | null;
  sum: number | null; donor_address: string | null; note: string | null;
  committee1: string | null; committee2: string | null; committee3: string | null; director: string | null;
  registered_count: number; registered_value: number; inv_from: number | null; inv_to: number | null;
}
/** Книгата за движение на фонда за година (kdbf:report). */
interface KdbfReport {
  part1: KdbfAcquisitionRow[];
  /** Всички актове за годината, и анулираните (revoked_at). */
  part3: Array<ActRow & { item_count: number; item_value: number }>;
  stockEnd: KdbfSum; acquiredYear: KdbfSum; deaccYear: KdbfSum; deaccOutOfStock: KdbfSum;
  /** Каквото е подадено, иначе текущата година като низ. */
  year: string | number;
  crossIn: KdbfSum; crossOut: KdbfSum;
  undated: { n: number; v: number; rows: number; missing_from_stock: number };
  part1Sum: KdbfSum;
  byKind: Array<{ kind: string; n: number; v: number }>;
}

/** Начислено/събрано по един вид обезщетение (stats:report → fines). */
interface StatsFineGroup { charged: number; collected: number; otherYears: number }
/** Двойка „стойност → брой“ за разбивките. */
type StatsPair = [string, number];
/** Справки и статистика за година (stats:report). */
interface StatsReport {
  year: string | number;
  fundCount: number; fundValue: number; acquiredCount: number; acquiredValue: number;
  deaccessionedCount: number; deaccessionedValue: number; loansCount: number; readersCount: number;
  visits: number; visitsRecorded: boolean;
  dnevnikVisits: { home: number; child: number; reading: number; internet: number; total: number };
  visitsCheck: { a: { label: string; n: number }; b: { label: string; n: number }; diff: number; why: string; todo: string };
  visitsAnyRecorded: boolean;
  returnedOnTime: number; returnedLate: number;
  finesCollected: number; finesCharged: number;
  /** Само за текущата година, иначе 0. */
  finesOpen: number; openOverdue: number;
  fines: { late: StatsFineGroup; loss: StatsFineGroup };
  fundByLanguage: StatsPair[]; fundByDepartment: StatsPair[]; fundByCategory: StatsPair[];
  topLoans: Array<{ title: string; author: string; n: number }>;
}
/** Описание на готова справка (REPORTS_CATALOG в handlers/stats.js). */
interface ReportDef { id: string; title: string; needsYear: boolean; hint: string }
/** Резултатът на готова справка — по `id`. */
type ReportResult =
  | { id: 'annual_ab'; year: string;
      /** Сборът на Дневника — ключовете са колоните на dnevnik_days (DNEVNIK_FIELDS) плюс тоталите; динамичен списък. */
      totals: Record<string, number>; daysRecorded: number; daysWithRow: number; daysOnClosed: number }
  | { id: 'fund_breakdown'; year: string; fundCount: number; fundValue: number;
      byDepartment: StatsPair[]; byLanguage: StatsPair[]; byCategory: StatsPair[] }
  | { id: 'readers_by_category'; year: string; total: number; byCategory: StatsPair[]; newThisYear: number;
      asOf: IsoDate; undated: number }
  | { id: 'fund_movement'; year: string;
      /** [начин, бройки, стойност по документа] */
      acquired: Array<[string, number, number]>; acquiredTotal: number; acquiredValue: number;
      /** [начин, инвентирани бройки, вписана стойност] */
      acquiredRegistered: Array<[string, number, number]>; acquiredRegisteredCount: number; acquiredRegisteredValue: number;
      deaccessioned: Array<[string, number, number]>; deaccessionedTotal: number; deaccessionedValue: number }
  | { id: 'mzs_annual'; year: string; total: number; byDirection: StatsPair[]; byStatus: StatsPair[] }
  | { id: 'fees_income'; year: string;
      /** [вид, брой, сума] */
      charged: Array<[string, number, number]>; chargedTotal: number; chargedValue: number; paidCount: number; paidValue: number };

/** Една група в прозореца за изтриване — `main` е броят на „главното нещо“ (документи, читатели), ако групата има такова. */
interface ResetGroup { group: string; rows: number; main: number | null; text: string }
/** Какво ще изчезне и какво остава при „Изтриване на всички данни“ (reset:plan). */
interface ResetPlan {
  /** Думата за потвърждение („ИЗТРИЙ“). */
  word: string;
  /** Редове по таблица — ключовете са имената на таблиците от WIPE (които ги има в базата). */
  counts: Record<string, number>;
  groups: ResetGroup[]; totalRows: number;
  keep: Array<{ table: string; label: string; why: string }>;
  library: { name: string; employees: number; authorMarks: number };
  backupFolder: string; backupEncrypted: boolean; pdpConfigured: boolean; dbFolder: string;
  catalogFolder: string; catalogRepo: string;
  catalogReset: { columns: string[]; folder: string; repo: string; any: boolean };
  identityReset: { columns: string[]; libName: string; org: string; place: string; any: boolean };
}
/** Отговорът след изтриването (reset:wipe) — програмата вече се рестартира. */
interface ResetWipeResult {
  backup: { path: string; encrypted: boolean };
  /** byTable/byGroup — ключове по таблиците и групите от WIPE. */
  deleted: { byTable: Record<string, number>; byGroup: Record<string, number>; total: number };
  vacuum: { ok: boolean; error: string | null; before: number | null; after: number | null };
  restarting: true; message: string; catalogCleared: boolean; identityCleared: boolean;
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

  /* ---- Авторски знак (handlers/author-mark.js) ---- */
  'authorMark:status': {
    args: [];
    result: {
      rows: number; letters: number;
      /** Разделителят, изведен от вече въведените знаци: '-', ' ' или '' (без). */
      separator: string;
      example: AuthorMarkHit | AuthorMarkMiss | null; sample: AuthorMarkRef[];
      builtinRows: number; isBuiltin: boolean;
    };
  };
  /** Диалог за файл; при отказ — { ok:false, error:'Отказано от потребителя.' }. Разчетеното чака authorMark:confirm. */
  'authorMark:choose': {
    args: [];
    result: { file: string; rows: number; letters: number; dropped: number; how: string; sample: AuthorMarkRef[] };
  };
  'authorMark:confirm': { args: []; result: { rows: number } };
  /** Броят изтрити редове. */
  'authorMark:clear': { args: []; result: number };
  'authorMark:loadBuiltin': { args: []; result: { rows: number } };
  /** Без внесена таблица — грешка; иначе предложение или отказ с причина (и двете са `data`). */
  'authorMark:suggest': {
    args: [{ author?: string | null; title?: string | null }?];
    result: AuthorMarkHit | AuthorMarkMiss;
  };
  'authorMark:audit': {
    args: [];
    result: {
      total: number;
      /** Първите 200. */
      mismatched: Array<Pick<BookColumns, 'id' | 'inv_number' | 'author' | 'title' | 'author_mark'> & { expected: string; basis: string }>;
      mismatchedTotal: number; missingTotal: number;
    };
  };
  'authorMark:fillPreview': {
    args: [];
    result: {
      willTotal: number; skipTotal: number;
      /** Първите 200. */
      will: Array<Pick<BookColumns, 'id' | 'inv_number' | 'author' | 'title'> & {
        mark: string; basis: string; from: 'author' | 'title'; exact: boolean }>;
      /** Първите 50. */
      skip: Array<Pick<BookColumns, 'id' | 'inv_number' | 'author' | 'title'> & { reason: string }>;
    };
  };
  /** Броят попълнени празни знака. */
  'authorMark:fillApply': { args: []; result: number };

  /* ---- Авторитетни данни (handlers/authorities.js) ---- */
  'authorities:fields': { args: []; result: Record<AuthorityField, string> };
  /** `field` е от AuthorityField — друго се отказва с „Непознато поле“. */
  'authorities:list': { args: [string]; result: AuthorityValueRow[] };
  'authorities:suggest': { args: []; result: Record<AuthorityField, string[]> };
  'authorities:duplicates': {
    args: [{ field: string; loose?: boolean }];
    result: Array<{ items: AuthorityValueRow[]; total: number; avail: number }>;
  };
  'authorities:merge': {
    args: [{ field: string; from: string[]; to: string }];
    result: { changed: number; merged: number };
  };

  /* ---- Книги (handlers/books.js) ---- */
  /** Няма извикване от екран. `date` не се проверява за валидна дата (празно — днес). */
  'books:addCheck': {
    args: [{ bookId: Id; date?: IsoDate }];
    result: { changes: number; lastInsertRowid: number | bigint };
  };
  /** `field` — 'department' | 'status' | 'category_id' | 'language'; „отчислен“ се отказва. Броят променени редове. */
  'books:bulkUpdate': {
    args: [{ ids: Id[]; field: string; value: string | number | null }];
    result: number;
  };
  /** Празен код → null; двусмислен код (баркод на един, инв. № на друг) → грешка. */
  'books:byBarcode': { args: [string]; result: BookSelectRow | null };
  /** Празен масив или един елемент; вторият аргумент е редът, който не се брои (при редакция). */
  'books:byIsbn': { args: [string, (Id | null)?]; result: BookIsbnMatch[] };
  /** Няма извикване от екран. */
  'books:checks': { args: [Id]; result: Array<{ date: string }> };
  'books:clearOrphanDeaccession': { args: [Id]; result: void };
  /** `data` е id на новия ред; предупрежденията и предложенията стоят ДО него (`extra`). */
  'books:create': {
    extra: {
      invGap: BookInvGapNotice | null; dateWarning: string | null; acqWarning: string | null;
      kindWarning: string | null; isbnDuplicate: BookIsbnMatch | null; catalogWarning: string | null;
      /** Отворените предложения за покупка на същото заглавие (handlers/suggestions.js). */
      suggestions: Array<{ id: number; date: string | null; title: string; author: string | null; reader_id: number | null;
        reader_name: string | null; status: string; author_match: boolean }>;
    };
    args: [BookInput & {
      /** Инвентарният номер на оригинала при „+ Още екземпляр“ — тогава не се предупреждава за ISBN. */
      copied_from?: Id | null }];
    result: number;
  };
  'books:deaccessionedWithoutAct': {
    args: [];
    result: Array<Pick<BookColumns, 'id' | 'inv_number' | 'title' | 'author' | 'status_date'>>;
  };
  /** При история или вписан номер първото повикване отказва; второто до 2 минути трие. */
  'books:delete': { args: [Id]; result: void };
  'books:findDuplicateBarcodes': {
    args: [];
    result: Array<{ barcode: string; books: Array<Pick<BookColumns, 'id' | 'inv_number' | 'barcode' | 'title' | 'author' | 'status'>> }>;
  };
  /** `_rev` — отпечатъкът на реда; връща се в books:update. Непознат id → undefined. */
  'books:get': { args: [Id]; result: (BookSelectRow & { _rev: string }) | undefined };
  'books:invGaps': { args: []; result: BookInvGap[] };
  /** Без page — пълният масив; с page — според режима (виж BooksListPage). sort: 'title' | 'cn' | 'inv'. */
  'books:list': {
    args: [(string | null)?, string?, BooksListPage?];
    result: BookListRow[] | BookLabelRow[] | { ids: number[] } | BooksListWindow;
    call: {
      (query: string | null, sort: string, page: BooksListPage & { labels: true }): Promise<IpcResult<BookLabelRow[]>>;
      (query: string | null, sort: string, page: BooksListPage & { idsOnly: true }): Promise<IpcResult<{ ids: number[] }>>;
      (query: string | null, sort: string, page: BooksListPage): Promise<IpcResult<BooksListWindow>>;
      (query?: string | null, sort?: string): Promise<IpcResult<BookListRow[]>>;
    };
  };
  'books:multiCopyRecords': {
    args: [];
    result: Array<Pick<BookColumns, 'id' | 'inv_number' | 'title' | 'author' | 'price' | 'status'> & { quantity: number; open_loans: number }>;
  };
  'books:setLendable': { args: [Id]; result: void };
  'books:splitCopies': { args: [Id]; result: BookSplitResult };
  /** Число — целият запис липсва; { id, missing, date } — липсват `missing` от бройките (date → status_date). */
  'books:splitCopiesBatch': {
    args: [Array<Id | { id: Id; missing: number | string; date?: IsoDate }>];
    result: {
      results: Array<BookSplitResult & { id: Id; partial?: true }>;
      skipped: Array<{ id: Id; inv_number: number | null; title: string | null }>;
    };
  };
  /** `_rev` липсва — без проверка за едновременна редакция. */
  'books:update': {
    args: [BookInput & { id: Id; _rev?: string }];
    result: { invGap: BookInvGapNotice | null };
  };
  /* ---- Лимит на записите (handlers/books.js) ---- */
  'limits:usage': { args: []; result: { books: number; readers: number; limitBooks: number; limitReaders: number } };
  /** Липсващо или нечислово поле става 0 (без ограничение). */
  'limits:update': {
    args: [{ limit_books?: number | string; limit_readers?: number | string }];
    result: void;
  };

  /* ---- Онлайн каталог (handlers/catalog.js) ---- */
  'catalog:autoPushStatus': {
    args: [];
    result: { at: string | null; error: string | null; okAt: string | null; write: CatalogWriteState | null };
  };
  /** `data` е избраната папка; състоянието на връзката и първият запис — ДО него (`extra`). */
  'catalog:chooseFolder': {
    args: []; result: string;
    extra: {
      adopted: CatalogRemoteSlug | null; mismatch: boolean; remote: CatalogRemoteSlug | null;
      write: { written: boolean; blocked: boolean; error: string | null; published: number | null; now: number | null; message: string | null };
    };
  };
  'catalog:disconnectFolder': { args: []; result: void };
  /** Пътят на записания файл. */
  'catalog:export': { args: []; result: string };
  'catalog:exportCsv': { args: []; result: string };
  'catalog:exportDc': { args: []; result: { path: string; count: number; excluded: number } };
  'catalog:exportMarc': { args: []; result: { path: string; count: number; excluded: number } };
  /** Без данни; `committed` — имало ли е промяна за публикуване. */
  'catalog:gitPublishNow': { args: []; result: void; extra: { committed: boolean } };
  /** null — няма свързана папка. */
  'catalog:remoteCheck': { args: []; result: { mismatch: boolean; remote: CatalogRemoteSlug | null } | null };
  'catalog:status': {
    args: [];
    result: {
      folder: string | null; total: number; available: number;
      /** null — няма свързана папка. */
      isGitRepo: boolean | null;
      rawUrl: string | null; ghUser: string | null; ghRepo: string | null; ghBranch: string | null;
      suggestedRepo: string; libName: string;
    };
  };
  'catalog:updateGh': {
    args: [{ gh_user?: string | null; gh_repo?: string | null; gh_branch?: string | null }];
    result: void;
  };
  /** `force` — записва въпреки предпазителя срещу рязко свиване (след изричен въпрос). */
  'catalog:writeNow': { args: [{ force?: boolean }?]; result: true };

  /* ---- Видове документи (handlers/categories.js) ---- */
  'categories:create': { args: [string]; result: { changes: number; lastInsertRowid: number | bigint } };
  /** Броят документи, останали без вид. */
  'categories:delete': { args: [Id]; result: number };
  'categories:list': { args: []; result: CategoryRow[] };
  'categories:update': { args: [{ id: Id; name: string }]; result: void };
  /** Броят документи от този вид. */
  'categories:usage': { args: [Id]; result: number };

  /* ---- Витрини в каталога (handlers/shelves.js) ---- */
  'shelves:addBook': { args: [{ shelfId: Id; code: string }]; result: { inv_number: number | null; title: string } };
  /** Пропуснатите: { id, reason } за изчезнал документ, иначе { inv_number, title, reason }. */
  'shelves:addBooks': {
    args: [{ shelfId: Id; ids: Id[] }];
    result: { added: number; skipped: Array<{ id?: Id; inv_number?: number | null; title?: string; reason: string }> };
  };
  /** id на новата витрина. */
  'shelves:create': { args: [string]; result: number };
  'shelves:delete': { args: [Id]; result: void };
  'shelves:items': { args: [Id]; result: ShelfItemRow[] };
  /** `n` — публикуваните документи, `stale` — стоят във витрината, но не стигат до сайта. */
  'shelves:list': { args: []; result: Array<ShelfRow & { n: number; stale: number }> };
  'shelves:removeBook': { args: [{ shelfId: Id; bookId: Id }]; result: void };
  'shelves:rename': { args: [{ id: Id; name: string }]; result: void };

  /* ---- Календар (handlers/calendar.js) ---- */
  'calendar:get': { args: []; result: { workDays: number[]; closed: CalendarClosedRow[]; from: IsoDate } };
  /** Дните от седмицата (0 = неделя … 6 = събота); празен списък се отказва. */
  'calendar:saveWorkDays': { args: [Array<number | string>]; result: CalendarShift };
  'calendar:addClosed': { args: [{ date: IsoDate; reason?: string | null }]; result: CalendarShift };
  'calendar:removeClosed': { args: [IsoDate]; result: void };

  /* ---- Правила за обслужване (handlers/circ-rules.js) ---- */
  'circRules:list': { args: []; result: CircRuleRow[] };
  /** Празно или 0 дни = общата стойност (NULL); стойностите от формата идват като низ. */
  'circRules:save': {
    args: [{ category: string; loan_days?: number | string | null; max_books?: number | string | null;
      extensions_count?: number | string | null; extension_days?: number | string | null;
      suspend_per_day?: number | string | null; suspend_max?: number | string | null }];
    result: void;
  };
  'circRules:delete': { args: [string]; result: void };
  /** Без категория — общите настройки. */
  'circRules:effective': { args: [(string | null)?]; result: CircRuleEffective };

  /* ---- Служители (handlers/employees.js) ---- */
  'employees:list': { args: []; result: EmployeeRow[] };
  'employees:create': { args: [string]; result: number };
  /** Непратено (или null) поле пази досегашната стойност. */
  'employees:update': { args: [{ id: Id; name?: string | null; active?: boolean | number | null }]; result: void };
  'employees:delete': { args: [Id]; result: void };

  /* ---- Лични данни (handlers/gdpr.js) ---- */
  /** При срок 0 години (изключено) otherCount и cutoff липсват. */
  'gdpr:candidates': {
    args: [];
    result: { years: number; count: number; auditCount: number; searchCount: number; otherCount?: number; cutoff?: IsoDate };
  };
  'gdpr:anonymize': {
    args: [];
    result: { anonymized: number; auditCleared: number; searchCleared: number; otherCleared: number; cutoff: IsoDate };
  };
  'gdpr:forgetReader': {
    args: [Id | { id: Id }];
    result: {
      readerCleared: number; auditCleared: number; name: string; searchCleared: number; holdsCancelled: number;
      holdsActivated: HoldActivated[]; mzsCleared: number;
      mzsSimilar: Array<{ id: number; no: number; year: string; requester: string }>;
      mzsNote: string | null; namesakes: number; backupsNote: string;
    };
  };

  /* ---- Резервации (handlers/holds.js) ---- */
  /** Само активните: първо заделените, после по реда на заявяване. */
  'holds:list': { args: []; result: Array<HoldRow & { status: 'чака' | 'заделена' }> };
  'holds:add': {
    args: [{ reader_id: Id; code: string }];
    /** `queue` — мястото на опашката (броят активни резервации за документа). */
    result: { id: number; title: string; inv_number: number | null; queue: number };
  };
  /** `next` — повиканият следващ в опашката, когато отказаната резервация е била заделена. */
  'holds:cancel': { args: [Id]; result: { next: HoldBrief & { title: string; inv_number: number | null } } | null };

  /* ---- Обслужване по домовете (handlers/housebound.js) ---- */
  'housebound:get': { args: [Id]; result: { profile: HouseboundProfileRow | null; visits: HouseboundVisitRow[] } };
  'housebound:save': {
    args: [{ reader_id: Id; day?: string | null; frequency?: string | null; note?: string | null }];
    result: void;
  };
  'housebound:remove': { args: [Id]; result: void };
  /** Без дата — днес; бъдеща или невалидна дата се отказва. */
  'housebound:addVisit': { args: [{ reader_id: Id; date?: IsoDate; note?: string | null }]; result: number };
  'housebound:list': {
    args: [];
    result: Array<HouseboundProfileRow & { name: string; phone: string | null; address: string | null;
      address2: string | null; last_visit: IsoDate | null }>;
  };

  /* ---- Мобилно сканиране (handlers/mobile.js) ---- */
  /** Път до записания файл; отказан диалог — { ok:false, error: 'Отказано от потребителя.' }. */
  'mobile:generate': { args: []; result: string };
  /** Списъкът на отворената проверка за телефона: 'html' — страницата с вграден списък, 'json' — само списъкът. Път до файла. */
  'mobile:sessionExport': { args: [{ sessionId: Id; kind: 'html' | 'json' }]; result: string };
  /** Адресът на приложението по https (с #lib=… за името на файла) и QR код за него като SVG. */
  'mobile:siteInfo': { args: []; result: { url: string; qrSvg: string } };
  /** Един елемент на `codes` = един код; редове с „#“ и празните се подминават. */
  'inventorySessions:importScans': {
    args: [{ sessionId: Id; codes: string[] }];
    result: {
      added: number; duplicates: number; unknown: string[];
      /** `inv_number` е кодът (низ), когато самото разпознаване е отказало. */
      skipped: Array<{ inv_number: number | string | null; reason: string }>;
      malformed: Array<{ code: string; reason: string }>;
      lost: Array<MobileLostCase & { inv_number: number | null; title: string }>;
    };
  };

  /* ---- Напомняния (handlers/notices.js) ---- */
  'loans:reminders': { args: []; result: ReminderRow[] };
  'notices:log': {
    args: [{ reader_id: Id; level?: number; channel?: string | null; loans_count?: number }];
    result: true;
  };
  /** Без `data`, когато писмото се отваря цяло; `shortened` — отворено с fallbackBody. */
  'loans:mailto': {
    args: [{ email: string | null; subject?: string; body?: string; fallbackBody?: string }];
    result: { shortened: true; length: number } | undefined;
  };

  /* ---- МЗС (handlers/mzs.js) ---- */
  'mzs:list': {
    args: [];
    result: Array<MzsRow & { reader_name: string | null; reader_card: string | null; book_inv: number | null;
      book_title: string | null }>;
  };
  /** Без година — текущата. */
  'mzs:nextNo': { args: [(string | number)?]; result: number };
  /** Без `on` (или с невалидна дата) — днес. `text` е готовото изречение за екрана. */
  'mzs:overdue': {
    args: [{ on?: IsoDate }?];
    result: Array<{
      id: number; no: number; year: string; direction: string; partner: string; author: string | null;
      title: string; status: string | null; due_date: IsoDate; date_sent: IsoDate | null;
      date_received: IsoDate | null; reader_id: number | null; book_id: number | null;
      reader_name: string | null; reader_card: string | null; reader_phone: string | null;
      book_inv: number | null; days_over: number; text: string;
    }>;
  };
  /** Празен № — следващият свободен за годината на датата; ново състояние само „заявено“/„отказано“. */
  'mzs:create': { args: [MzsInput & { date: IsoDate; partner: string; title: string }]; result: number };
  /** Непратено поле пази старото; датата на новото състояние — от date_sent/… или днес. */
  'mzs:update': {
    args: [MzsInput & { id: Id; date_sent?: IsoDate | null; date_received?: IsoDate | null; date_returned?: IsoDate | null }];
    result: void;
  };
  'mzs:delete': { args: [Id]; result: void };

  /* ---- Читатели (handlers/readers.js) ---- */
  /** Без `page` — масив (с `limit` до 500); с `page` — прозорец с броячите. */
  'readers:list': {
    args: [(string | null)?, (number | null)?, ReaderListPage?];
    result: ReaderListRow[] | ReaderListWindow;
    call: {
      (query: string | null, limit: number | null, page: ReaderListPage): Promise<IpcResult<ReaderListWindow>>;
      (query?: string | null, limit?: number | null): Promise<IpcResult<ReaderListRow[]>>;
    };
  };
  /** `_rev` — отпечатъкът на реда за readers:update. */
  'readers:get': { args: [Id]; result: (ReaderRow & { _rev: string }) | undefined };
  'readers:byCard': { args: [string]; result: ReaderRow | undefined };
  'readers:mzsHeld': {
    args: [Id];
    result: Array<{ id: number; no: number; year: string; partner: string; author: string | null; title: string;
      due_date: IsoDate | null; date_received: IsoDate | null; overdue: boolean }>;
  };
  /** Без отбелязано съгласие (и съгласие на родител при дете до 14 г.) се отказва. */
  'readers:create': { args: [ReaderInput & { gdpr_consent: boolean | number }]; result: number };
  /** ПЪЛНА замяна на картона: непратено поле от READER_FIELDS става NULL, непратено
      gdpr_consent/parent_consent — 0 (само category, status и registered_at пазят старото). */
  'readers:update': { args: [ReaderInput & { id: Id; _rev?: string }]; result: void };
  'readers:clearSuspension': { args: [Id]; result: void };
  /** При история — първото повикване отказва, второто до 2 минути изтрива. */
  'readers:delete': { args: [Id]; result: { holdsActivated: Array<HoldActivated & { card_no: string | null }> } };
  /** Път до записания файл; отказан диалог — { ok:false, error: 'Отказано от потребителя.' }. */
  'readers:exportCsv': { args: []; result: string };

  /* ---- История на търсенията (handlers/search-history.js) ---- */
  /** Под 2 знака или повторение на последното търсене — нищо не се записва. */
  'searchHistory:log': { args: [{ kind: string; query: string }]; result: void };
  'searchHistory:suggest': { args: [string]; result: string[] };

  /* ---- Антивирусни изключения (handlers/security-exclusions.js) ---- */
  /** `dirs` — всички папки; `safe` влизат в скрипта, `rejected` — трябва да се добавят на ръка. */
  'security:exclusionInfo': { args: []; result: { dirs: string[]; safe: string[]; rejected: string[]; exe: string } };
  /** Път до записания .bat; отказан диалог — { ok:false, error: 'Отказано от потребителя.' }. */
  'security:writeExclusionScript': { args: []; result: string };

  /* ---- Предложения за покупка (handlers/suggestions.js) ---- */
  'suggestions:list': {
    args: [string?];
    /** reader_name е вече заменено с живото име, ако читателят е в базата. */
    result: Array<SuggestionRow & { reader_name_live: string | null; acq_no: number | null; acq_year: string | null }>;
  };
  'suggestions:create': {
    args: [{ title: string; author?: string | null; note?: string | null; reader_id?: Id | null;
      reader_name?: string | null; date?: IsoDate }];
    result: number;
  };
  /** book_id — партидата се чете от книгата, ако acquisition_id не е подаден (само при „получено“). */
  'suggestions:setStatus': {
    args: [{ id: Id; status: SuggestionStatus; acquisition_id?: Id | null; book_id?: Id | null }];
    result: void;
  };
  'suggestions:delete': { args: [Id]; result: void };
  'suggestions:matchBook': {
    args: [{ title?: string | null; author?: string | null }?];
    result: Array<{ id: number; date: IsoDate; title: string; author: string | null; reader_id: number | null;
      reader_name: string | null; status: string; author_match: boolean }>;
  };

  /* ---- Посещения (handlers/visits.js) ---- */
  /** `replace` — задава броя за деня вместо да добавя; `added` е null при замяна. */
  'visits:add': {
    args: [{ date: IsoDate; count: number | string; replace?: boolean }];
    result: {
      added: number | null; total: number; before: number;
      dnevnik: { home: number; child: number; reading: number; internet: number; total: number; recorded: boolean };
    };
  };
  'visits:get': { args: [IsoDate]; result: number };

  /* ---- Постъпления (handlers/acquisitions.js) ---- */
  'acquisitions:list': { args: []; result: Array<AcqColumns & { registered_count: number; registered_value: number }> };
  'acquisitions:get': {
    args: [Id];
    /** fund_qty — ОТЧЕТНАТА бройка (COALESCE(inventory.quantity, 1)), отделна от quantity на BOOK_SELECT. */
    result: (AcqColumns & { items: Array<BookSelectRow & { fund_qty: number }> }) | null;
  };
  /** Годината по подразбиране е текущата. */
  'acquisitions:nextNo': { args: [(string | number)?]; result: number };
  'acquisitions:create': { args: [AcqInput & { no: number | string }]; result: number };
  /** Номерът и годината не се пипат оттук; отговорът е броят променени полета. */
  'acquisitions:update': { args: [{ id: Id; acq: AcqInput }]; result: number };
  'acquisitions:delete': { args: [Id]; result: void };

  /* ---- Периодика (handlers/periodicals.js) ---- */
  'periodicals:list': {
    args: [];
    result: Array<PeriodicalColumns & { issue_count: number; last_issue_date: IsoDate | null; volume_count: number;
      next_expected: IsoDate | null; issue_overdue_days: number }>;
  };
  'periodicals:get': {
    /** year: „ГГГГ“, „—“ (броеве без дата) или „всички“; без него — текущата/последната година с броеве. */
    args: [Id, { year?: string | number }?];
    result: (PeriodicalColumns & {
      issue_years: Array<{ year: string; n: number }>; issue_year: string; issue_total: number;
      issues: PeriodicalIssueRow[]; volumes: PeriodicalVolumeRow[];
    }) | null;
  };
  'periodicals:create': { args: [PeriodicalInput]; result: number };
  /** languageVolumes — в колко инвентирани комплекта е пренесен смененият език. */
  'periodicals:update': { args: [PeriodicalInput & { id: Id }]; result: { languageVolumes: number } };
  'periodicals:delete': { args: [Id]; result: void };
  /** outside_volume: true — изрично „само в кардекса“ за вече инвентиран комплект. */
  'periodicalIssues:add': {
    args: [{ periodical_id: Id; issue_no: string; date?: IsoDate; price?: number | string | null;
      note?: string | null; volume_year?: number | string | null; outside_volume?: boolean }];
    result: number;
  };
  'periodicalIssues:delete': { args: [Id]; result: void };
  /** Празна цена → сборът на броевете; confirm_empty — комплект без броеве и с нулева стойност. */
  'periodicalVolumes:register': {
    args: [{ periodical_id: Id; year: string | number; price?: number | string | null; register_date?: IsoDate;
      inv_number?: number | string | null; acquisition_id?: Id | null; note?: string | null; confirm_empty?: boolean }];
    result: { book_id: number; inv_number: number; year: string; title: string; price: number; issue_count: number;
      invGap: PeriodicalInvGap | null };
  };

  /* ---- Аналитично описание (handlers/analytics.js) ---- */
  'analytics:list': { args: [{ q?: string; year?: string | number; onlyLocal?: boolean }?]; result: AnalyticRow[] };
  'analytics:get': { args: [Id]; result: AnalyticRow | undefined };
  'analytics:years': { args: []; result: Array<{ year: string; n: number }> };
  'analytics:create': { args: [AnalyticInput]; result: number };
  'analytics:update': { args: [AnalyticInput & { id: Id }]; result: void };
  'analytics:delete': { args: [Id]; result: void };

  /* ---- Персоналии (handlers/persons.js) ---- */
  /** Низ — търсене; обект { sameAs } — картоните със същия ключ на името (PersonNamesakeRow). */
  'persons:list': {
    args: [(string | { sameAs: string; exceptId?: Id | null })?];
    result: PersonListRow[] | PersonNamesakeRow[];
  };
  'persons:get': { args: [Id]; result: (PersonColumns & { photo: string | null }) | undefined };
  'persons:create': { args: [PersonInput]; result: number };
  'persons:update': { args: [PersonInput & { id: Id }]; result: void };
  'persons:delete': { args: [Id]; result: void };

  /* ---- Летопис (handlers/chronicle.js) ---- */
  'chronicle:list': {
    args: [{ q?: string; year?: string | number }?];
    result: Array<ChronicleColumns & { has_photo: number; links: number }>;
  };
  'chronicle:get': { args: [Id]; result: (ChronicleColumns & { photo: string | null }) | undefined };
  'chronicle:years': { args: []; result: Array<{ year: string; n: number }> };
  'chronicle:create': { args: [ChronicleInput]; result: number };
  'chronicle:update': { args: [ChronicleInput & { id: Id }]; result: void };
  'chronicle:delete': { args: [Id]; result: void };

  /* ---- Краеведски връзки (handlers/links.js) ---- */
  'links:list': { args: [{ fromKind: LinkFromKind; fromId: Id }]; result: LinkRow[] };
  'links:backlinks': { args: [{ toKind: LinkToKind; toId: Id }]; result: LinkBacklinkRow[] };
  'links:add': {
    args: [{ fromKind: LinkFromKind; fromId: Id; toKind: LinkToKind; toId: Id; note?: string | null }];
    result: void;
  };
  'links:delete': { args: [Id]; result: void };
  'links:search': { args: [{ kind: LinkToKind; q: string }]; result: Array<{ id: number; label: string }> };

  /* ---- Краеведски снимки (handlers/local-photo.js) ---- */
  /** Отговорът е data URI на записаната снимка; затворен диалог е { ok:false } с FILE_DIALOG_CANCELLED. */
  'localPhoto:choose': { args: [{ table: 'persons' | 'chronicle'; id: Id }]; result: string };
  'localPhoto:clear': { args: [{ table: 'persons' | 'chronicle'; id: Id }]; result: void };

  /* ---- Онлайн достъп за читатели (handlers/online-access.js) ---- */
  'online:status': { args: []; result: OnlineStatus };
  'online:activate': { args: [{ token: string }]; result: { lib: string; name: string; exp: IsoDate } };
  'online:deactivate': { args: []; result: void };
  /** Празен ключ = „не го сменяй“ (записаният никога не се връща към екрана). */
  'online:updateSettings': { args: [{ online_bridge_url?: string | null; online_upload_key?: string | null }]; result: void };
  'online:setReaderConsent': {
    args: [{ readerId: Id; consent: boolean | number; date?: IsoDate | null }];
    result: { online_consent: number; online_consent_date: IsoDate | null };
  };
  /** ПИН-ът се връща ЕДИН път; в базата остава само хешът. */
  'online:issuePin': { args: [{ readerId: Id }]; result: { pin: string; cardNumber: string; setAt: IsoDate } };
  'online:revokePin': { args: [{ readerId: Id }]; result: void };
  'online:syncNow': { args: []; result: { generated: string | null } };
  /** Личните съобщения на читателя за картона — всички (и оттеглените), най-новите първи (v2.4.82). */
  'online:messages': { args: [{ readerId: Id }]; result: ReaderMessage[] };
  /** Отказва се, ако читателят няма онлайн достъп (съгласие + ПИН) — той не би го видял. */
  'online:sendMessage': { args: [{ readerId: Id; title?: string | null; text: string }]; result: ReaderMessage };
  'online:withdrawMessage': { args: [{ id: Id }]; result: { id: number; withdrawn_at: string } };

  /* ---- Защита на ЕГН/№ ЛК (handlers/pdp.js) ---- */
  'pdp:status': { args: []; result: PdpStatus };
  'pdp:setup': { args: [string]; result: true };
  /** При стара/кратка парола data е обект с подсказка за смяна (отключването пак е успешно). */
  'pdp:unlock': { args: [string]; result: true | { ok: true; advise: string } };
  'pdp:lock': { args: []; result: void };
  'pdp:changePassword': { args: [{ oldPassword: string; newPassword: string }]; result: true };

  /* ---- Номенклатури (handlers/av.js) ---- */
  'av:categories': { args: []; result: Record<AvCategory, string> };
  'av:options': { args: []; result: Record<AvCategory, AvOption[]> };
  /** Замества целия списък на категорията; празните редове отпадат. Отговорът е броят записани стойности. */
  'av:save': {
    args: [{ category: AvCategory; values: Array<{ value: string; opac_label?: string | null }> }];
    result: number;
  };

  /* ---- Дневник (handlers/dnevnik.js) ---- */
  'dnevnik:getMonth': {
    args: [{ year: number | string; month: number | string }];
    result: { year: number; month: number; daysInMonth: number; days: DnevnikMonthDay[];
      monthTotal: DnevnikSumRow; ytdTotal: DnevnikSumRow;
      daysFilled: number; daysFilledClosed: number; ytdDaysFilled: number };
  };
  /** warnings — затворен ден по календара, разминати „Всичко“ на Раздел А, деца > „в заемна за дома“. */
  'dnevnik:saveDay': { args: [DnevnikSaveInput]; result: { date: IsoDate; closed: boolean; warnings: string[] } };
  'dnevnik:suggest': {
    args: [{ date: IsoDate }];
    result: {
      date: IsoDate; suggestions: Partial<Record<DnevnikField, number>>; eventsCount: number;
      unclassified: number; periodicalsByType: number;
      /** Видове без собствен ред във формуляра: [име на вида, брой заемания], броени в „Книги“. */
      typeFallback: Array<[string, number]>; typeMissing: number;
      sectionA: { age: number; sex: number; edu: number; prof: number; visitHome: number; visitChild: number;
        visitHomeDesk: number; visitHomeHousebound: number };
    };
  };
  /** Отговорът е пътят на записания файл; затворен диалог е { ok:false } с FILE_DIALOG_CANCELLED. */
  'dnevnik:exportCsv': { args: [{ year: number | string; month: number | string }]; result: string };

  /* ---- Търсене по ISBN (handlers/isbn-lookup.js) ---- */
  'isbn:lookup': { args: [string]; result: IsbnLookupData };
  'sru:lookup': { args: [string]; result: SruRecord };

  /* ---- Приложение (main.js) ---- */
  'app:checkForUpdates': { args: []; result: true };
  'app:getUser': { args: []; result: string };
  'app:getVersion': { args: []; result: string };
  /** Изходът става в quitAndInstall() — отговор почти не стига до екрана. */
  'app:installUpdate': { args: []; result: void };
  'app:openLogsFolder': { args: []; result: void };
  /** Името се изрязва; празно/липсващо = без служител. Връща записаното име. */
  'app:setUser': { args: [(string | null)?]; result: string };

  /* ---- Одитна следа (handlers/audit.js) ---- */
  /** Търсенето е по желание; износът е без лимита от 500 реда и се вписва в следата. */
  'audit:export': { args: [string?]; result: AuditLogRow[] };
  'audit:list': { args: [string?]; result: AuditLogRow[] };

  /* ---- Резервни копия (handlers/backup.js) ---- */
  'backup:autoStatus': { args: []; result: BackupAutoStatus };
  'backup:chooseSecondFolder': { args: []; result: { folder: string; copied: boolean } };
  'backup:clearSecondFolder': { args: []; result: true };
  'backup:list': { args: []; result: BackupFileRow[] };
  /** Паролата — поне 10 знака, иначе отказ. `data` е пътят. */
  'backup:now': { args: [{ password?: string }?]; result: string; extra: { encrypted: boolean } };
  /** Без аргумент — системен диалог; второто извикване носи пътя, одобрен от диалога, и паролата. */
  'backup:restoreBrowse': {
    args: [{ path?: string; password?: string }?];
    result: { needsPassword: true; path: string } | { needsPassword: false };
  };
  /** Аргументът се деструктурира в сигнатурата — без обект обработчикът гърми извън run(). */
  'backup:restoreFromList': {
    args: [{ path: string; password?: string }];
    result: { needsPassword: true; path: string } | { needsPassword: false };
  };
  'backup:secondFolder': { args: []; result: BackupSecondFolderState };

  /* ---- Табло (handlers/dashboard.js) ---- */
  'dashboard:full': { args: []; result: DashboardFull };
  'dashboard:stats': { args: []; result: DashboardStats };

  /* ---- Място на базата (handlers/db-location.js) ---- */
  /** Рестартира програмата; `data` (новата папка) практически не стига до екрана. */
  'dbLocation:choose': { args: []; result: string };
  'dbLocation:get': { args: []; result: DbLocationInfo };
  'dbLocation:resetDefault': { args: []; result: void };

  /* ---- Износ (handlers/export-all.js) ---- */
  'exportAll:run': { args: []; result: ExportAllResult };

  /* ---- Проверка на фонда (handlers/fund-check.js) ---- */
  /** Без година — текущата. */
  'fund:check': { args: [(string | number)?]; result: FundCheckResult };
  'fund:checkLogged': { args: [(string | number)?]; result: FundCheckResult };

  /* ---- Внос (handlers/data-import.js) ---- */
  'import:choose': { args: []; result: ImportPreview };
  /** Път на провлачен файл; без одобрение от диалога — само .csv/.txt/.tsv/.xlsx. */
  'import:load': { args: [string]; result: ImportPreview };
  /** Аргументът се деструктурира в сигнатурата. mapping: индекс на колона → поле; без 'title' — отказ. */
  'import:run': { args: [{ mapping: Record<string, string>; options?: ImportOptions }]; result: ImportReport };

  /* ---- Инвентарна книга (handlers/inv-book.js) ---- */
  /** Без аргумент — целият регистър като масив; с обект — прозорец. Екранът ги различава с Array.isArray. */
  'invBook:list': {
    args: [{ q?: string; offset?: number; limit?: number; summary?: boolean }?];
    result: InvBookRow[] | InvBookPage;
    call: {
      (page: { q?: string; offset?: number; limit?: number; summary?: boolean }): Promise<IpcResult<InvBookPage>>;
      (): Promise<IpcResult<InvBookRow[]>>;
    };
  };

  /* ---- КДБФ (handlers/kdbf.js) ---- */
  'kdbf:report': { args: [(string | number)?]; result: KdbfReport };

  /* ---- Печат (handlers/print.js) ---- */
  'print:savePdf': { args: [{ fileName?: string }?]; result: { path: string } };

  /* ---- Статистика и готови справки (handlers/stats.js) ---- */
  'reports:list': { args: []; result: ReportDef[] };
  /** Аргументът се деструктурира в сигнатурата; непознат id — грешка. */
  'reports:run': { args: [{ id: string; year?: string | number }]; result: ReportResult };
  'stats:report': { args: [(string | number)?]; result: StatsReport };

  /* ---- Нулиране (handlers/reset.js) ---- */
  'reset:plan': { args: []; result: ResetPlan };
  /** Без думата „ИЗТРИЙ“ — отказ. newLibrary изчиства и наименованието, организацията и мястото. */
  'reset:wipe': { args: [{ word: string; newLibrary?: boolean }]; result: ResetWipeResult };

  /* ---- Настройки (handlers/settings.js, settings:noticeDefaults — main.js) ---- */
  /** Системен диалог; `data` е data URI на логото. */
  'settings:chooseLogo': { args: []; result: string };
  'settings:clearLogo': { args: []; result: void };
  'settings:get': { args: []; result: SettingsRow };
  'settings:noticeDefaults': {
    args: [];
    /** placeholders — двойки [ключ, обяснение]. */
    result: { subject: string; body: string; sms: string; placeholders: Array<[string, string]> };
  };
  'settings:update': { args: [SettingsUpdateInput]; result: void };
  'settings:updateLabelFormat': { args: [SettingsLabelFormatInput?]; result: { clamped: SettingsLabelClamp[] } };
  /** Празно = текстът по подразбиране (записва се NULL). */
  'settings:updateNotices': {
    args: [{ notice_subject?: string | null; notice_body?: string | null; notice_sms?: string | null }?];
    result: void;
  };
  /** Истинност → 1/0. */
  'settings:updateScanSound': { args: [boolean | number]; result: void };
  /** Записва се String(theme). */
  'settings:updateTheme': { args: [string | number]; result: void };
}
