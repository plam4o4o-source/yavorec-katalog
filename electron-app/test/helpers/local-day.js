'use strict';
/* „Днес“ за ТЕСТОВЕТЕ — по часовника на компютъра, както го смята програмата
   от v2.4.67 (виж local-date.js). Нарочно отделно копие, а не require на
   продукционния модул: иначе повреда там би повредила и еталона на теста.

   Смятането назад/напред е с setDate (местен календар), не с 24 часа: около
   смяната на часа „сега − 24 ч“ може да падне в предишния-предишен ден. */
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const localToday = () => localIso(new Date());
/* Местната дата преди n дни (n < 0 — след). */
const localDayOff = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return localIso(d); };

module.exports = { localIso, localToday, localDayOff };
