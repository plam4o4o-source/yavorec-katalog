// ГЕНЕРИРАН ФАЙЛ — не се пише на ръка. Източник: истинската схема на базата
// (schema.sql + ensureColumns() + миграциите). Обновяване: npm run gen:db-types
// (виж scripts/gen-db-types.js). Без strictNullChecks `| null` е само описание.

/** Ред от таблица `account_lines`. */
interface DbAccountLines {
  id: number;
  reader_id: number;
  date: string;
  kind: string;
  type: string | null;
  amount: number;
  note: string | null;
  created_at: string | null;
}
/** Ред от таблица `acquisitions`. */
interface DbAcquisitions {
  id: number;
  no: number;
  year: string;
  date: string;
  how: string | null;
  from_source: string | null;
  doc_type: string | null;
  doc_no: string | null;
  doc_date: string | null;
  total_count: number | null;
  sum: number | null;
  donor_address: string | null;
  note: string | null;
  committee1: string | null;
  committee2: string | null;
  committee3: string | null;
  director: string | null;
}
/** Ред от таблица `analytics`. */
interface DbAnalytics {
  id: number;
  title: string;
  subtitle: string | null;
  author: string | null;
  source_kind: string | null;
  periodical_id: number | null;
  book_id: number | null;
  source_text: string | null;
  year: string | null;
  issue: string | null;
  issue_date: string | null;
  pages: string | null;
  udk: string | null;
  keywords: string | null;
  annotation: string | null;
  is_local: number | null;
  note: string | null;
  created_at: string | null;
}
/** Ред от таблица `audit_log`. */
interface DbAuditLog {
  id: number;
  ts: string | null;
  user: string | null;
  action: string;
  detail: string | null;
  diff: string | null;
}
/** Ред от таблица `author_table`. */
interface DbAuthorTable {
  prefix: string;
  mark: string;
}
/** Ред от таблица `authorised_values`. */
interface DbAuthorisedValues {
  id: number;
  category: string;
  value: string;
  opac_label: string | null;
  sort: number | null;
}
/** Ред от таблица `books`. */
interface DbBooks {
  id: number;
  inv_number: number | null;
  barcode: string | null;
  register_date: string | null;
  title: string;
  subtitle: string | null;
  author: string | null;
  category_id: number | null;
  year: string | null;
  volume: string | null;
  isbn: string | null;
  pages: string | null;
  language: string | null;
  udk: string | null;
  call_number: string | null;
  author_mark: string | null;
  city: string | null;
  publisher: string | null;
  series: string | null;
  series_no: string | null;
  keywords: string | null;
  annotation: string | null;
  cover_url: string | null;
  department: string | null;
  status: string | null;
  status_date: string | null;
  datelastseen: string | null;
  permanent_location: string | null;
  cn_sort: string | null;
  price: number | null;
  description: string | null;
  acquisition_id: number | null;
  deaccession_act_id: number | null;
  deaccession_date: string | null;
  created_at: string | null;
}
/** Ред от таблица `books_fts`. */
interface DbBooksFts {
  title: string | null;
  subtitle: string | null;
  author: string | null;
}
/** Ред от таблица `calendar_closed`. */
interface DbCalendarClosed {
  date: string;
  reason: string | null;
}
/** Ред от таблица `catalog_shelf_items`. */
interface DbCatalogShelfItems {
  shelf_id: number;
  book_id: number;
  sort: number | null;
}
/** Ред от таблица `catalog_shelves`. */
interface DbCatalogShelves {
  id: number;
  name: string;
  sort: number | null;
}
/** Ред от таблица `categories`. */
interface DbCategories {
  id: number;
  name: string;
  code: string | null;
}
/** Ред от таблица `chronicle`. */
interface DbChronicle {
  id: number;
  year: string;
  date: string | null;
  title: string;
  body: string | null;
  category: string | null;
  participants: string | null;
  sources: string | null;
  photo: string | null;
  note: string | null;
  created_at: string | null;
}
/** Ред от таблица `circulation_rules`. */
interface DbCirculationRules {
  category: string;
  loan_days: number | null;
  max_books: number | null;
  extensions_count: number | null;
  extension_days: number | null;
  suspend_per_day: number | null;
  suspend_max: number | null;
}
/** Ред от таблица `deaccession_acts`. */
interface DbDeaccessionActs {
  id: number;
  no: number;
  year: string;
  date: string;
  order_no: string | null;
  reason_code: number | null;
  reason_text: string | null;
  disposal: string | null;
  attach: string | null;
  committee1: string | null;
  committee2: string | null;
  committee3: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  revoked_by: string | null;
  note: string | null;
  created_at: string | null;
  created_by: string | null;
  director: string | null;
}
/** Ред от таблица `deaccession_draft_items`. */
interface DbDeaccessionDraftItems {
  draft_id: number;
  book_id: number;
}
/** Ред от таблица `deaccession_drafts`. */
interface DbDeaccessionDrafts {
  id: number;
  date: string | null;
  order_no: string | null;
  reason_code: number | null;
  reason_text: string | null;
  disposal: string | null;
  attach: string | null;
  committee1: string | null;
  committee2: string | null;
  committee3: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}
/** Ред от таблица `deaccession_items`. */
interface DbDeaccessionItems {
  id: number;
  act_id: number;
  book_id: number | null;
  inv_number: number | null;
  author: string | null;
  title: string | null;
  volume: string | null;
  year: string | null;
  price: number | null;
  udk: string | null;
  category: string | null;
  language: string | null;
  quantity: number | null;
  status_before: string | null;
  shelves_before: string | null;
}
/** Ред от таблица `dnevnik_days`. */
interface DbDnevnikDays {
  id: number;
  date: string;
  a_hours: number | null;
  a_age_u14: number | null;
  a_age_15_18: number | null;
  a_age_19_28: number | null;
  a_age_o28: number | null;
  a_sex_boys: number | null;
  a_sex_men: number | null;
  a_sex_girls: number | null;
  a_sex_women: number | null;
  a_edu_basic: number | null;
  a_edu_sec: number | null;
  a_edu_high: number | null;
  a_prof_industry: number | null;
  a_prof_agri: number | null;
  a_prof_eng: number | null;
  a_prof_agrospec: number | null;
  a_prof_med: number | null;
  a_prof_sci: number | null;
  a_prof_hum: number | null;
  a_prof_creative: number | null;
  a_prof_teach: number | null;
  a_prof_other: number | null;
  a_stud_uni: number | null;
  a_stud_high: number | null;
  a_stud_sec: number | null;
  a_stud_elem: number | null;
  a_visit_home: number | null;
  a_visit_child: number | null;
  a_visit_reading: number | null;
  a_visit_internet: number | null;
  b_hours: number | null;
  b_type_books: number | null;
  b_type_period: number | null;
  b_type_graphic: number | null;
  b_type_carto: number | null;
  b_type_music: number | null;
  b_type_audio: number | null;
  b_type_video: number | null;
  b_type_electronic: number | null;
  b_type_dvd: number | null;
  b_type_talking: number | null;
  b_lang_bg: number | null;
  b_lang_ru: number | null;
  b_lang_slavic: number | null;
  b_lang_en: number | null;
  b_lang_de: number | null;
  b_lang_fr: number | null;
  b_lang_other: number | null;
  b_cat_0: number | null;
  b_cat_1: number | null;
  b_cat_2: number | null;
  b_cat_3: number | null;
  b_cat_5: number | null;
  b_cat_61: number | null;
  b_cat_62: number | null;
  b_cat_63: number | null;
  b_cat_7: number | null;
  b_cat_793: number | null;
  b_cat_80: number | null;
  b_cat_82: number | null;
  b_cat_9: number | null;
  b_cat_91: number | null;
  b_cat_fiction: number | null;
  b_cat_child_nf: number | null;
  b_cat_child_f: number | null;
  b_cat_reading_used: number | null;
  note: string | null;
}
/** Ред от таблица `employees`. */
interface DbEmployees {
  id: number;
  name: string;
  active: number | null;
  created_at: string | null;
}
/** Ред от таблица `events`. */
interface DbEvents {
  id: number;
  ts: string | null;
  date: string;
  kind: string;
  book_id: number | null;
  reader_id: number | null;
  reader_category: string | null;
  book_language: string | null;
  book_udk: string | null;
  book_category: string | null;
  note: string | null;
}
/** Ред от таблица `holds`. */
interface DbHolds {
  id: number;
  book_id: number;
  reader_id: number;
  placed_at: string | null;
  status: string | null;
  ready_at: string | null;
  resolved_at: string | null;
  note: string | null;
  deaccession_act_id: number | null;
  status_before: string | null;
}
/** Ред от таблица `housebound_profiles`. */
interface DbHouseboundProfiles {
  reader_id: number;
  day: string | null;
  frequency: string | null;
  note: string | null;
}
/** Ред от таблица `housebound_visits`. */
interface DbHouseboundVisits {
  id: number;
  reader_id: number;
  date: string;
  note: string | null;
}
/** Ред от таблица `inventory`. */
interface DbInventory {
  id: number;
  book_id: number;
  quantity: number;
}
/** Ред от таблица `inventory_checks`. */
interface DbInventoryChecks {
  id: number;
  book_id: number;
  date: string;
}
/** Ред от таблица `inventory_session_missing`. */
interface DbInventorySessionMissing {
  id: number;
  session_id: number;
  book_id: number | null;
  inv_number: number | null;
  title: string | null;
  author: string | null;
  price: number | null;
  quantity: number | null;
}
/** Ред от таблица `inventory_session_scans`. */
interface DbInventorySessionScans {
  id: number;
  session_id: number;
  book_id: number;
  scanned_at: string | null;
}
/** Ред от таблица `inventory_sessions`. */
interface DbInventorySessions {
  id: number;
  date: string;
  scope: string | null;
  department: string | null;
  committee1: string | null;
  committee2: string | null;
  committee3: string | null;
  pool_size: number | null;
  closed: number | null;
  mode: string | null;
  no: number | null;
  year: string | null;
  order_no: string | null;
  pool_final: number | null;
  on_loan: number | null;
  at_binder: number | null;
  scanned_final: number | null;
  free_access_pct: number | null;
  last_book_id: number | null;
  added_late: number | null;
  mzs_away: number | null;
  director: string | null;
}
/** Ред от таблица `links`. */
interface DbLinks {
  id: number;
  from_kind: string;
  from_id: number;
  to_kind: string;
  to_id: number;
  note: string | null;
  created_at: string | null;
}
/** Ред от таблица `loans`. */
interface DbLoans {
  id: number;
  reader_id: number;
  book_id: number;
  date_out: string;
  date_due: string | null;
  date_in: string | null;
  fine: number | null;
  renewals: number | null;
  anon_category: string | null;
  deaccession_act_id: number | null;
  lost: number | null;
  lost_date: string | null;
  lost_resolution: string | null;
  lost_amount: number | null;
  lost_account_line_id: number | null;
  lost_replacement_book_id: number | null;
  lost_replacement_note: string | null;
  lost_note: string | null;
  deaccession_fine: number | null;
  deaccession_fine_line_id: number | null;
}
/** Ред от таблица `mzs_requests`. */
interface DbMzsRequests {
  id: number;
  no: number;
  year: string;
  date: string;
  direction: string;
  partner: string;
  author: string | null;
  title: string;
  isbn: string | null;
  requester: string | null;
  status: string | null;
  due_date: string | null;
  note: string | null;
  book_id: number | null;
  reader_id: number | null;
  date_sent: string | null;
  date_received: string | null;
  date_returned: string | null;
}
/** Ред от таблица `notice_log`. */
interface DbNoticeLog {
  id: number;
  ts: string | null;
  reader_id: number;
  level: number | null;
  channel: string | null;
  loans_count: number | null;
}
/** Ред от таблица `online_request_results`. */
interface DbOnlineRequestResults {
  id: string;
  status: string;
  reason: string | null;
  at: string;
}
/** Ред от таблица `periodical_issues`. */
interface DbPeriodicalIssues {
  id: number;
  periodical_id: number;
  issue_no: string;
  date: string | null;
  price: number | null;
  note: string | null;
  volume_year: number | null;
}
/** Ред от таблица `periodical_volumes`. */
interface DbPeriodicalVolumes {
  id: number;
  periodical_id: number;
  year: string;
  book_id: number | null;
  issue_count: number | null;
  issue_sum: number | null;
  created_at: string | null;
}
/** Ред от таблица `periodicals`. */
interface DbPeriodicals {
  id: number;
  title: string;
  freq: string | null;
  publisher: string | null;
  issn: string | null;
  department: string | null;
  note: string | null;
  language: string | null;
}
/** Ред от таблица `persons`. */
interface DbPersons {
  id: number;
  name: string;
  alt_names: string | null;
  birth_date: string | null;
  birth_place: string | null;
  death_date: string | null;
  death_place: string | null;
  activity: string | null;
  bio: string | null;
  awards: string | null;
  sources: string | null;
  photo: string | null;
  note: string | null;
  created_at: string | null;
}
/** Ред от таблица `reader_messages`. */
interface DbReaderMessages {
  id: number;
  reader_id: number;
  title: string | null;
  body: string;
  created_at: string;
  read_at: string | null;
  withdrawn_at: string | null;
}
/** Ред от таблица `reader_registrations`. */
interface DbReaderRegistrations {
  id: number;
  reader_id: number | null;
  reader_key: string;
  date: string;
  kind: string;
}
/** Ред от таблица `readers`. */
interface DbReaders {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  address2: string | null;
  email: string | null;
  card_no: string | null;
  egn: string | null;
  id_card_no: string | null;
  id_card_date: string | null;
  id_card_issuer: string | null;
  birth_date: string | null;
  category: string | null;
  registered_at: string | null;
  re_registered_at: string | null;
  status: string | null;
  gdpr_consent: number | null;
  gdpr_consent_date: string | null;
  parent_consent: number | null;
  parent_consent_date: string | null;
  suspended_until: string | null;
  guarantor_name: string | null;
  guarantor_relation: string | null;
  guarantor_phone: string | null;
  note: string | null;
  alert_note: string | null;
  online_consent: number | null;
  online_consent_date: string | null;
  online_pin_hash: string | null;
  online_pin_set_at: string | null;
  created_at: string | null;
}
/** Ред от таблица `readers_fts`. */
interface DbReadersFts {
  name: string | null;
}
/** Ред от таблица `search_history`. */
interface DbSearchHistory {
  id: number;
  ts: string | null;
  user: string | null;
  kind: string;
  query: string;
}
/** Ред от таблица `settings`. */
interface DbSettings {
  id: number;
  org: string | null;
  lib_name: string | null;
  place: string | null;
  bulstat: string | null;
  reg_no: string | null;
  director: string | null;
  director_role: string | null;
  librarian: string | null;
  cat_url: string | null;
  loan_days: number | null;
  max_books: number | null;
  extensions_count: number | null;
  extension_days: number | null;
  fine_per_day: number | null;
  annual_fee: number | null;
  free_access_pct: number | null;
  next_inv_number: number | null;
  committee1: string | null;
  committee2: string | null;
  committee3: string | null;
  lbl_mode: string | null;
  lbl_w: number | null;
  lbl_h: number | null;
  lbl_cols: number | null;
  lbl_gap: number | null;
  lbl_margin: number | null;
  lbl_border: number | null;
  sig_w: number | null;
  sig_h: number | null;
  card_w: number | null;
  card_h: number | null;
  logo: string | null;
  theme: string | null;
  scan_sound: number | null;
  catalog_folder: string | null;
  sru_endpoint: string | null;
  suspend_per_day: number | null;
  suspend_max: number | null;
  remind2_days: number | null;
  remind3_days: number | null;
  notice_subject: string | null;
  notice_body: string | null;
  notice_sms: string | null;
  anonymize_years: number | null;
  lost_price_multiplier: number | null;
  lost_fallback_amount: number | null;
  work_days: string | null;
  gh_user: string | null;
  gh_repo: string | null;
  gh_branch: string | null;
  limit_books: number | null;
  limit_readers: number | null;
  online_bridge_url: string | null;
  online_upload_key: string | null;
  online_activation: string | null;
  online_last_sync: string | null;
  online_last_error: string | null;
  online_last_hash: string | null;
  online_last_full: string | null;
  online_bridge_features: string | null;
  lbl_mt: number | null;
  lbl_ml: number | null;
  lbl_gx: number | null;
  lbl_gy: number | null;
  pdp_salt: string | null;
  pdp_verifier: string | null;
  holidays_seeded: string | null;
}
/** Ред от таблица `suggestions`. */
interface DbSuggestions {
  id: number;
  date: string;
  reader_id: number | null;
  reader_name: string | null;
  author: string | null;
  title: string;
  note: string | null;
  status: string | null;
  acquisition_id: number | null;
  created_at: string | null;
}
/** Ред от таблица `visits`. */
interface DbVisits {
  id: number;
  date: string;
  count: number;
}
