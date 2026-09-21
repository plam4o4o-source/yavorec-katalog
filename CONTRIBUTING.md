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

At the time of writing this runs **1900+ tests** and takes a few minutes. Run it
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

All four checks — both time zones and both catalogue suites — run with one
command:

```bash
npm run test:all
```

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
