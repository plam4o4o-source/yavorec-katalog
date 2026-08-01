# Промени / Changelog

Всяко издание по-долу съответства на git таг `vX.Y.Z`. Текстът тук се
показва автоматично в описанието на съответното GitHub Release
(`.github/workflows/release-electron.yml`). По-старите версии (преди
v1.13.7) не са описани тук в детайли — вижте историята на commit-ите в
GitHub за пълни подробности.

Each entry below corresponds to a git tag `vX.Y.Z`. This text is copied
automatically into the matching GitHub Release description. Versions before
v1.13.7 are not documented here in detail — see the GitHub commit history
for full detail.

## v1.13.7

**Промени:**
- Общ преглед на README вече и на английски език, в допълнение към
  българския.
- Лицензът (GPL-3.0) вече има и неофициален превод на български —
  `LICENSE.bg.md`; оригиналният, юридически меродавен текст на английски
  остава недокоснат в `LICENSE`.
- Описанието на всяко бъдещо издание в GitHub Releases вече се попълва
  автоматично от този файл.

**Changes:**
- The README overview is now available in English in addition to
  Bulgarian.
- The license (GPL-3.0) now has an unofficial Bulgarian reference
  translation — `LICENSE.bg.md`; the original, legally authoritative
  English text remains unchanged in `LICENSE`.
- Every future release's GitHub Releases description is now filled in
  automatically from this file.

## v1.13.6

**Промени:**
- Лицензът е сменен от собственически на GNU GPL-3.0, за да отговаря на
  условията за безплатно подписване на код чрез SignPath Foundation.
- Премахнат Azure Trusted Signing (акаунт, кука, стъпки в build workflow-а)
  след неуспешна организационна проверка на самоличността.
- Оправени всички остатъчни текстове „Всички права запазени“ в
  `package.json`, README и footer текста в самата програма.

**Changes:**
- License changed from proprietary to GNU GPL-3.0, to meet the
  requirements for free code signing via SignPath Foundation.
- Removed Azure Trusted Signing (account, build hook, workflow steps)
  after the organization identity validation failed.
- Fixed all remaining "all rights reserved" text in `package.json`, the
  README, and the in-app footer credit.
