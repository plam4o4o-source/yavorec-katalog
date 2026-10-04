# Contributing to InvLib

InvLib is a free library management system for Bulgarian community centre,
school, municipal and public libraries. It keeps the registers required by
**Ordinance No. 3 of 18 November 2014** — the inventory book, the accession and
disposal ledger (КДБФ), the daily register, deaccession acts and stocktaking
protocols — and it works offline, on a single Windows computer, without a
subscription.

The project is maintained mainly by one developer for the needs of a specific
library, but it follows ordinary open-source practice so that any change is easy
to review, whoever makes it.

> **На български:** [`CONTRIBUTING.bg.md`](CONTRIBUTING.bg.md) — същият документ,
> със същите правила. Коментарите в кода и записите в дневника са на български.

You do not need to be an experienced developer to help. Reporting a problem
clearly, or telling us how the program behaved in your library, is a
contribution — see [Reporting bugs](#reporting-bugs) and
[Library testing feedback](#library-testing-feedback).

---

## How to contribute

The short version:

1. [Fork the repository](#1-fork-the-repository)
2. [Clone your fork](#2-clone-your-fork)
3. [Create a feature branch](#3-create-a-feature-branch)
4. [Install dependencies](#4-install-dependencies)
5. [Run the tests](#5-run-the-tests)
6. [Document your changes](#6-document-your-changes)
7. [Submit a pull request](#7-submit-a-pull-request)

### 1. Fork the repository

Open <https://github.com/plam4o4o-source/yavorec-katalog> and click **Fork** in
the top right corner. This creates your own copy of the project under your
GitHub account, which you can change freely without affecting the original.

### 2. Clone your fork

Replace `<your-username>` with your GitHub username:

```bash
git clone https://github.com/<your-username>/yavorec-katalog.git
cd yavorec-katalog
```

### 3. Create a feature branch

Never work directly on `main`. Create a branch whose name says what the change
is about:

```bash
git checkout -b feature/reader-loan-history
```

Useful prefixes: `feature/` for new capabilities, `fix/` for defects,
`docs/` for documentation.

### 4. Install dependencies

**The application lives in the `electron-app/` directory — there is no
`package.json` in the repository root.** All npm commands below are run from
there:

```bash
cd electron-app
npm install
```

`npm install` runs a `postinstall` step (`electron-rebuild`) that compiles
`better-sqlite3` for Electron's ABI, which is what the packaged program needs.

**The tests, however, run on plain Node**, so immediately after installing you
have to compile that one module back:

```bash
npm rebuild better-sqlite3
```

Without this step `npm test` fails with `NODE_MODULE_VERSION mismatch` on a
fresh clone. This is not a bug in your setup — the same two steps are performed
by the CI workflow (`.github/workflows/ci.yml`).

To run the program itself during development:

```bash
npm start
```

### 5. Run the tests

The project uses the test runner built into Node (`node:test`); there is no
external test framework.

```bash
npm test
```

At the time of writing this runs **2000+ tests** and takes a few minutes. Run it
once before you change anything, so you know the starting state is green.

CI runs the suite **twice**, in two time zones, because several tests about
daylight saving time only have any discriminating power outside UTC. Please run
the second pass as well before opening a pull request:

```bash
TZ=Europe/Sofia npm test
```

There are two separate suites for the public online catalogue page, which live
outside `electron-app/` and are therefore not picked up by `npm test` — one for
how the catalogue *reaches* the page (sources, timeouts, cache) and one for what
the page *does* with it at a realistic scale of 15 000 copies:

```bash
cd ../site
NODE_PATH=../electron-app/node_modules node test-page-katalog.js page-katalog.html
NODE_PATH=../electron-app/node_modules node test-page-katalog-view.js
```

The first one takes about a minute and looks stuck: it is waiting out the page's
real production timeouts (6 s for headers, 25 s for the body, per source). That
wait *is* the check.

All checks — the type check, both time zones and both catalogue suites — run
with one command:

```bash
npm run test:all
```

#### Type check (`npm run typecheck`)

The program stays plain JavaScript — nothing is compiled. TypeScript only
*reads* the code (`tsc --checkJs`, `tsconfig.json` for the main process,
`tsconfig.renderer.json` for `src/views/`) and fails CI when a view calls a
`window.api` method that `preload.js` does not expose, reads a property an
element does not have, or passes a function the wrong number of arguments.

- The description of `window.api` (`types/api.generated.d.ts`) is **generated
  from `preload.js`** — after adding or renaming a channel run
  `npm run gen:api-types`; CI fails while the file is stale.
- A new value put on `window` for `onclick="…"` or printing needs a line in
  `types/renderer-globals.d.ts`.
- Where TypeScript cannot know the element type, say it with a JSDoc cast —
  `/** @type {HTMLInputElement} */ (document.querySelector('[name=x]'))` —
  rather than changing the code.
- **`null` and `undefined` are their own types** (`strictNullChecks`, both
  projects, since v2.4.75; `exactOptionalPropertyTypes` since v2.4.77 — an
  optional `x?: T` may be missing, but is not `undefined` unless it says
  so). A channel's answer is `{ ok: true, data }` or `{ ok: false, error }` — after `if (!res.ok) return …` the data is there;
  `call()` returns `T | null`; a nullable column is `| null`. Check before you
  read. When a value cannot be null for a reason TypeScript does not see (a
  check in another function, a regex group that always matches), say so with a
  cast and a comment — `/** @type {number} */ (x)   // проверено горе` — never
  with a blanket `any`. `.filter()` does not narrow in JSDoc; `flatMap(x =>
  x.y ? [{ ...x, y: x.y }] : [])` does.
- CI also fails on unused local variables, a function that returns a value on
  only some paths, a `switch` case that falls through, and `this` of unknown
  type (`noUnusedLocals`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noImplicitThis`).
- **The screen ↔ handler contract** (`types/ipc-contract.d.ts`) describes the
  arguments and the result of **every** channel. Each is exposed on
  `window.api` with its exact signature, and its handler describes its
  parameter with the same type:
  `ipcMain.handle('loans:return', /** @param {unknown} e @param {IpcArg<'loans:return'>} arg */ (e, { id, date_in }) => …)`.
  A field the screen does not send, or one the handler expects under another
  name, is then a type error on both sides.
  - **A new channel** needs an entry in the contract (each key on its own line,
    indented by exactly two spaces), the annotation on its handler, and
    `npm run gen:api-types`. `test/typecheck-v2472.test.js` fails while any
    channel in `preload.js` has no entry, or a handler lacks its `IpcArg`.
  - **A result that depends on the arguments** (a window vs. the whole list,
    labels…) keeps the union in `result` for the handler and adds a `call`
    signature with one overload per mode, so each screen gets the exact
    answer for the mode it asks for (see `books:list`, `readers:list`,
    `invBook:list`).
  - **What is not checked:** values read from a form (`formData()`,
    `setupFormData()`) are `any` — the form's HTML is the only thing that knows
    its fields — so a field removed from a form is **not** caught; objects built
    in code are fully checked.
  - **The handler's answer is checked too** (since v2.4.77). `run()` is
    `run<T>(fn: () => T): IpcResult<T>`, each module's `deps` is
    `HandlerDeps`, and each handler carries `@returns {IpcReply<'ch'>}`
    (`IpcAsyncReply<'ch'>` when async) — returning another type, or leaving
    out a field, is a type error; so is an invented field in an answer written
    out literally (`async () => ({ ok: true, data: {…} })`, fields next to
    `data`). An empty `{}` / `[]` filled later needs a type on its declaration
    (`/** @type {BookInvGap[]} */`). **Limits:** inside `run(() => ({…}))`
    TypeScript does not flag *extra* fields of the returned object, and a
    database row is `any` (better-sqlite3 has no types here), so a handler
    that returns rows straight from SQL is not compared with the contract —
    the row types (below) and `test/shema-v2474.test.js` cover that side.
  - **Fields next to `data`** (`catalogWarning`, `encrypted`, `committed`…) are
    described in the channel's entry as `extra: { … }`. A response has no
    "free" fields: reading or returning an undescribed one is an error. They
    are optional on both sides, so a handler that stops sending one is not
    caught by the types — the screen must cope with it missing.
    (`noPropertyAccessFromIndexSignature` is deliberately off: it only forces
    `obj['x']` instead of `obj.x` — on `dataset`, `process.env`, `deps` — and
    does not catch a typo; removing the free fields does.)
- **Row types come from the database schema** (`types/db.generated.d.ts`,
  `interface DbBooks`, `DbLoans`… — one per table). They are generated from the
  *real* schema: `scripts/gen-db-types.js` starts the program in-process (as
  the tests do), so `schema.sql`, `ensureColumns()`, the migrations and the
  columns handlers add on first use are all included. After any schema change
  run `npm run gen:db-types`; CI fails while the file is stale. A contract row
  that describes a whole table **extends** it (`interface LoanColumns extends
  DbLoans {}`) and only narrows a column's type (e.g. `kind: 'начисление' |
  'плащане'`) — never declares a column the table lacks; a narrowed type that
  contradicts its column is a type error (`tsconfig.renderer.json` checks our
  own `.d.ts` files too). A column or table the code adds outside
  `schema.sql` (`ALTER TABLE … ADD COLUMN`, including the loop over an object
  of columns; `ensureColumns()`; `CREATE TABLE IF NOT EXISTS` in a handler)
  must be reachable from one of the channels in `LAZY_SCHEMA_CHANNELS` in the
  generator, which fails and names it if not. Because the generator starts
  the program, `npm run typecheck` needs `better-sqlite3` built for Node — the
  same as `npm test` (`npm rebuild better-sqlite3` after an Electron rebuild).
- **SQL is checked against the schema.** `test/shema-v2474.test.js` prepares
  every SQL text in `main.js`, `handlers/` and `db/` that can be read without
  running the code against the real schema — a misspelt column or table fails
  there. Readable means: a string, strings joined with `+`, a constant passed
  by name, or a template whose `${…}` uses only constants declared above it
  (evaluated in an empty `vm` context — `${FIELDS.join(', ')}`,
  `${F.QTY_JOIN}` from `db/`, `${LOAN_SELECT}`). Comments are skipped. Queries
  that depend on a value computed at run time are counted, not checked; the
  test caps their number so it does not grow unnoticed.

**A new capability or a fix without a new or updated test is not accepted.**
The convention is one test file per handler — `handlers/x.js` →
`test/handlers-x.test.js` — using a fake `ipcMain` together with a **real**
temporary database (`fs.mkdtempSync` + `db/schema.sql`). The SQL itself is never
mocked: the database is the part most worth testing.

### 6. Document your changes

Every meaningful change (a new domain, a fixed defect, a new field) gets:

1. **A version bump** in `electron-app/package.json` **and**
   `electron-app/package-lock.json`. Both — they are checked against each other.
2. **An entry in `electron-app/CHANGELOG.md`**, bilingual (BG and EN): what
   changed, *why*, and the number of tests before and after. The official site
   reads this file, so the entry is published as written.
3. **One commit for one change.** Unrelated work goes into separate commits,
   even when both were discovered in the same investigation.

Depending on what you touched, also update:

| What you changed | What to update |
|---|---|
| Behaviour a librarian will notice | `docs/narachnik.html` (the handbook) |
| A new table or column | `docs/ARCHITECTURE.md`, `electron-app/db/schema.sql` comments |
| Anything about Ordinance No. 3 | `docs/naredba-3-karta.md` |
| Configuration or build | `electron-app/README.md` |
| The user interface | A screenshot in `docs/screenshots/`, if the old one no longer matches |

Write the reasoning down, not just the change. This codebase explains *why* a
line exists — that is what makes a defect found two years later understandable
instead of mysterious.

### 7. Submit a pull request

Push your branch and open a pull request against `main`:

```bash
git push -u origin feature/reader-loan-history
```

Before you do, please check that:

- [ ] `npm test` passes, and `TZ=Europe/Sofia npm test` as well
- [ ] a new or updated test covers the change
- [ ] the version is bumped in `package.json` **and** `package-lock.json`
- [ ] `CHANGELOG.md` has a bilingual entry
- [ ] the pull request contains one meaningful change, not several unrelated ones
- [ ] no new dependency was added without a reason stated in the description

The repository has a pull request template that mirrors this list. In the
description, explain **what** changes and **why**. If the change fixes a
reported problem, link it by writing `Fixes #123` — GitHub will close that issue
automatically when the pull request is merged.

---

## Development guidelines

- **Follow the existing architecture.** Read
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it describes the
  main-process/renderer boundary, the map of `handlers/*.js`, and the
  load-order (TDZ) trap that is easy to fall into when adding a new module.
- **Every IPC handler goes through the `run(fn)` helper.** It catches errors and
  returns `{ok: false, error}`; a handler never throws towards the renderer.
- **A new domain in `handlers/` follows the established shape:**
  `module.exports = function registerXHandlers(ipcMain, deps) { ... }`.
- **Avoid new dependencies.** The test framework is the built-in `node:test`;
  the XLSX import uses Node's own `zlib` rather than a package. Every dependency
  makes `npm run build` and the signing of the installer harder, and this program
  is installed by librarians who cannot debug a broken installer.
- **Keep compatibility.** Databases in real libraries carry years of records.
  A schema change must migrate existing data, never assume a fresh database, and
  never silently rewrite what a librarian entered.
- **Comments in the code are written in Bulgarian.** The program serves Bulgarian
  libraries and the whole domain — Ordinance No. 3, КДБФ, the daily register — is
  Bulgarian regulatory material that does not translate well. Do not translate
  existing comments; write new ones in Bulgarian if you can, and in English if
  you cannot. Both are better than none.

---

## Reporting bugs

Open an issue using the **Bug report** template:
<https://github.com/plam4o4o-source/yavorec-katalog/issues/new/choose>

The template asks for the InvLib version, the operating system and whether the
database is local or in a shared network folder. Those three answers explain a
large share of reports, so please fill them in.

⚠️ **Never attach personal data.** Reader names, national identification
numbers, addresses and phone numbers must not appear in screenshots or logs.
Crop or blur them first.

---

## Suggesting features

Open an issue using the **Feature request** template.

The most useful suggestions describe the **work in the library** rather than the
technical solution: what you are trying to accomplish, how you do it today, and
why the current way is slow, error-prone or impossible. A rough sketch of the
screen or of the printed document is welcome.

---

## Library testing feedback

If you are a librarian or a tester using InvLib on a real or test collection,
please use the **Library testing feedback** template.

It asks which parts you used, what worked well, what could be improved and where
you got stuck. Feedback from a working library is worth more than any amount of
testing by the developer: you use the program on a real collection, under the
rules you actually have to follow. What worked well matters as much as what did
not — it tells us what must not be broken.

For questions and conversation rather than a report, use
[Discussions](https://github.com/plam4o4o-source/yavorec-katalog/discussions).

---

## Code review

`main` is the protected, published branch: the automatic update of already
installed programs is built from it. Changes are developed in a separate branch
and merged only after review and green tests.

What a review looks at:

- **Correctness against the ordinance.** A number that ends up on a signed
  document must be right. Where a rule comes from Ordinance No. 3, the code says
  which article.
- **The test.** Does it fail if the fix is reverted? A test that passes either
  way proves nothing.
- **Data safety.** Existing records are never overwritten silently, and a partial
  failure never leaves the database half-changed.
- **Clarity for the next reader.** Not cleverness — a librarian's data depends on
  code that a stranger can still understand in five years.

Expect questions. They are about the change, never about the person making it.

---

## Community guidelines

This project has a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you
are expected to follow it.

Be professional, respectful and constructive. Assume the other person is trying
to make the program better for a library somewhere.

Many people here are librarians rather than programmers. A question that looks
elementary is not a nuisance — the program exists for exactly those people, and
if something had to be asked, it probably was not clear enough.

Criticism belongs to the code, the document or the decision. Never to the person.

---

## Releasing a new version

For maintainers: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release-electron.yml`, which builds the installer and
publishes a GitHub Release automatically. See
[“Автоматично обновяване” in `electron-app/README.md`](electron-app/README.md#автоматично-обновяване).

---

## Licence

InvLib is published under **GPL-3.0-or-later**. By contributing you agree that
your contribution is published under the same licence. See [`LICENSE`](LICENSE)
and [`LICENSE.bg.md`](LICENSE.bg.md).
