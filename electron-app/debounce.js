// Малка, generic помощна функция за "сливане" (debounce/coalesce) на много
// бързи последователни извиквания в едно, изпълнено известно време след
// последното. Извадена в отделен non-Electron модул, за да е тестваема с
// node:test (main.js не може да се require-не директно — той е Electron
// main процес с странични ефекти при зареждане).
//
// Ползва се в main.js за katalog.json (Фаза 2, "write amplification" —
// целият каталог се пресъздаваше и записваше синхронно при ВСЯКА мутация на
// книга/заемане; сега се насрочва един-единствен запис, известно време след
// последната промяна, вместо на всяка поотделно).
function createDebouncer(fn, delayMs) {
  let timer = null;
  function schedule(...args) {
    if (timer) return; // вече насрочено — следващите извиквания се сливат в същия запис
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
    if (timer.unref) timer.unref(); // да не пречи на нормалното затваряне на приложението
  }
  function flush(...args) {
    if (timer) { clearTimeout(timer); timer = null; }
    return fn(...args);
  }
  function pending() { return timer !== null; }
  return { schedule, flush, pending };
}

module.exports = { createDebouncer };
