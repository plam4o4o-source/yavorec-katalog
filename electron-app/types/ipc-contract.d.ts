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

interface IpcContract {
}
