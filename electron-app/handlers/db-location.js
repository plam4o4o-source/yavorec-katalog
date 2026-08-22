// Местоположение на базата данни — извадени от main.js в отделен модул
// (Фаза 4, стъпка 9 от разбиването на монолита на модули по домейн).
// Позволява библиотеката да ползва мрежова папка вместо локалната по
// подразбиране (споделена база между няколко работни компютъра).
//
// Същия DI модел като backup.js: `db`/`mainWindow` — getter/setter функции
// (`dbLocation:choose`/`resetDefault` затварят db и правят app.relaunch()+
// app.exit(0), точно като backup.js — процесът приключва веднага след
// записа в config.json, следващото стартиране прочита новата папка).
// `readConfig`/`writeConfig`/`resolveDbDir`/`resolveDbPath` се подават по
// референция — дефинирани са в main.js и остават там (ползва ги и
// initDb() при стартиране, извън обхвата на този модул).
module.exports = function registerDbLocationHandlers(ipcMain, deps) {
  const {
    app, dialog, fs, path,
    getDb, setDb, getMainWindow,
    run, readConfig, writeConfig, updateConfig, resolveDbDir, resolveDbPath
  } = deps;

  ipcMain.handle('dbLocation:get', () =>
    run(() => ({ folder: resolveDbDir(), isDefault: !readConfig().dbFolder, isPackaged: app.isPackaged }))
  );
  ipcMain.handle('dbLocation:choose', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете папка за базата данни (локална или мрежова)',
        properties: ['openDirectory', 'createDirectory']
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      const newDir = filePaths[0];
      const oldPath = resolveDbPath();
      const newPath = path.join(newDir, 'library.db');
      if (path.resolve(oldPath) === path.resolve(newPath)) return { ok: false, error: 'Това е текущата папка на базата данни.' };

      // В избраната папка вече може да има library.db — най-често защото това е
      // споделена мрежова база, към която друг компютър в библиотеката вече е
      // свързан. Копирането по подразбиране тук би я презаписало безвъзвратно
      // с текущата (локална) база, затова питаме изрично какво иска потребителят.
      let doCopy = true;
      if (fs.existsSync(newPath)) {
        const { response } = await dialog.showMessageBox(getMainWindow(), {
          type: 'warning',
          buttons: ['Отказ', 'Ползвай съществуващата база от тази папка', 'Презапиши я с моята текуща база'],
          defaultId: 1,
          cancelId: 0,
          title: 'В папката вече има база данни',
          message: 'В избраната папка вече има файл library.db.',
          detail: 'Ако това е споделена мрежова база на библиотеката, изберете „Ползвай съществуващата база" — текущите данни в нея остават недокоснати, просто се свързвате към нея. Ако изберете „Презапиши", съществуващият файл ще бъде безвъзвратно заменен с вашата текуща база данни.'
        });
        if (response === 0) return { ok: false, error: 'Отказано от потребителя.' };
        doCopy = (response === 2);
      }

      /* Редът тук е важен — същият модел като performRestore() в handlers/backup.js.
         Досега базата се затваряше ПРЕДИ копирането: ако копирането се провалеше
         (мрежов дял само за четене, пълен диск, изчезнала папка), програмата
         оставаше жива, но със ЗАТВОРЕНА база — всяко следващо действие гърми с
         „The database connection is not open", а рестарт няма, защото config.json
         не е записан. Сега копието се прави настрани (в ЦЕЛЕВАТА папка, за да е
         преименуването на същото устройство — атомарно), докато базата още работи;
         базата се затваря чак когато новият файл вече е на мястото си. Провал на
         който и да е етап оставя работеща база и непроменена настройка. */
      const db = getDb();
      if (db) db.pragma('wal_checkpoint(TRUNCATE)');
      if (doCopy && fs.existsSync(oldPath)) {
        const stagedPath = newPath + '.copy-tmp';
        try {
          fs.copyFileSync(oldPath, stagedPath);
          fs.renameSync(stagedPath, newPath);
        } catch (err) {
          try { if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath); } catch (e) { /* нищо за чистене */ }
          return { ok: false, error: 'Базата данни не можа да бъде копирана в избраната папка — нищо не е променено '
            + 'и програмата продължава да работи с текущата база. Грешка: ' + err.message };
        }
      }
      if (db) db.close();
      /* updateConfig, не readConfig+writeConfig: при неуспешен прочит второто
         записва обект само с dbFolder и мълчаливо изтрива всичко останало
         (напр. lastUserName). Отказаният запис се съобщава — иначе програмата
         щеше да се рестартира и да отвори СТАРАТА папка, твърдейки, че е сменена. */
      if (!updateConfig((cfg) => { cfg.dbFolder = newDir; })) {
        return { ok: false, error: 'Настройките (config.json) не можаха да бъдат прочетени, затова новата '
          + 'папка НЕ беше записана. Копието на повредения файл е до него (config.bad.json). '
          + 'Базата остава на старото място.' };
      }
      app.relaunch();
      app.exit(0);
      return { ok: true, data: newDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('dbLocation:resetDefault', () =>
    run(() => {
      // Виж бележката при dbLocation:setFolder по-горе.
      if (!updateConfig((cfg) => { delete cfg.dbFolder; })) {
        throw new Error('Настройките (config.json) не можаха да бъдат прочетени — папката НЕ беше върната '
          + 'към стандартната. Копието на повредения файл е до него (config.bad.json).');
      }
      app.relaunch();
      app.exit(0);
    })
  );
};
