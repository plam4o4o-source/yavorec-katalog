; Български текстове за инсталатора.
;
; NSIS сам превежда стандартните бутони и екрани („Напред“, „Инсталирай“, „Отказ“,
; избора на папка, лентата за напредък), защото езикът е зададен в package.json →
; build.nsis.installerLanguages. Тук се превеждат само собствените съобщения на
; electron-builder, за които няма български превод в самата библиотека и които
; иначе излизат на английски насред българския инсталатор.
;
; Файлът се вмъква СЛЕД генерираните езикови низове, затова тези определения имат
; предимство. 1026 е кодът на български (LCID), 1033 — на английски.
;
; ВАЖНО: NSIS предупреждава „LangString set multiple times“ при презаписване —
; това е очаквано и не е грешка.

!macro customHeader
  ; --- Липсва в Bulgarian.nsh на самия NSIS ---
  ; MultiUser.nsh търси този низ на всеки език; българският езиков файл на NSIS не
  ; го съдържа и NSIS взима английския като заместител, с предупреждение. Затова
  ; build.nsis.warningsAsErrors е изключено в package.json — иначе предупреждението
  ; спира изграждането. Тук низът се задава на български, за да е преведен и ако
  ; страницата за избор на потребители някога се покаже.
  LangString MULTIUSER_TEXT_INSTALLMODE_TITLE 1026 "Избор на потребители"
  LangString MULTIUSER_TEXT_INSTALLMODE_SUBTITLE 1026 "Изберете за кои потребители да бъде инсталирана $(^NameDA)."
  LangString MULTIUSER_INNERTEXT_INSTALLMODE_TOP 1026 "Изберете дали $(^NameDA) да бъде инсталирана само за вас, или за всички потребители на този компютър. $(^ClickNext)"
  LangString MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS 1026 "Инсталиране за всеки, който ползва този компютър"
  LangString MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER 1026 "Инсталиране само за мен"

  ; --- Общи съобщения (messages.yml) ---
  LangString win7Required 1026 "Изисква се Windows 7 или по-нов."
  LangString x64WinRequired 1026 "Изисква се 64-битов Windows."
  LangString appRunning 1026 "${PRODUCT_NAME} в момента работи.$\r$\nНатиснете „ОК“, за да бъде затворена.$\r$\nАко не се затвори, затворете я ръчно."
  LangString appCannotBeClosed 1026 "${PRODUCT_NAME} не може да бъде затворена.$\r$\nЗатворете я ръчно и натиснете „Повтори“, за да продължите."
  LangString installing 1026 "Инсталиране, моля изчакайте…"
  LangString areYouSureToUninstall 1026 "Сигурни ли сте, че искате да премахнете ${PRODUCT_NAME}?"
  LangString decompressionFailed 1026 "Файловете не можаха да бъдат разархивирани. Стартирайте инсталатора отново."
  LangString uninstallFailed 1026 "Старите файлове на програмата не можаха да бъдат премахнати. Стартирайте инсталатора отново."

  ; --- Съобщения на подробния инсталатор (assistedMessages.yml) ---
  LangString chooseInstallationOptions 1026 "Изберете начин на инсталиране"
  LangString chooseUninstallationOptions 1026 "Изберете начин на премахване"
  LangString whichInstallationShouldBeRemoved 1026 "Коя инсталация да бъде премахната?"
  LangString whoShouldThisApplicationBeInstalledFor 1026 "За кого да бъде инсталирана програмата?"
  LangString selectUserMode 1026 "Изберете дали програмата да е достъпна за всички потребители на компютъра, или само за вас"
  LangString whichInstallationRemove 1026 "Програмата е инсталирана и за целия компютър, и за текущия потребител.$\r$\nКоя инсталация искате да премахнете?"
  LangString freshInstallForAll 1026 "Нова инсталация за всички потребители (ще поиска администраторски права)"
  LangString freshInstallForCurrent 1026 "Нова инсталация само за текущия потребител"
  LangString onlyForMe 1026 "Само за &мен"
  LangString forAll 1026 "За всеки, който ползва този компютър (&всички потребители)"
  LangString loginWithAdminAccount 1026 "За да продължите, влезте с потребител с администраторски права…"
  LangString perUserInstallExists 1026 "Вече има инсталация за текущия потребител."
  LangString perUserInstall 1026 "Има инсталация за текущия потребител."
  LangString perMachineInstallExists 1026 "Вече има инсталация за целия компютър."
  LangString perMachineInstall 1026 "Има инсталация за целия компютър."
  LangString reinstallUpgrade 1026 "Ще бъде преинсталирана/обновена."
  LangString uninstall 1026 "Ще бъде премахната."
!macroend
