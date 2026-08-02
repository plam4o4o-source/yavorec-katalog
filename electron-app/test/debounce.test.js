// Тестове за debounce.js — generic "сливане" на бързи последователни
// извиквания, ползвано в main.js за да не се презаписва katalog.json
// синхронно при всяка мутация (Фаза 2, "write amplification").
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDebouncer } = require('../debounce');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('multiple rapid schedule() calls coalesce into a single fn call', async () => {
  let calls = 0;
  const d = createDebouncer(() => { calls++; }, 30);
  d.schedule(); d.schedule(); d.schedule();
  assert.equal(calls, 0, 'fn must not run synchronously');
  assert.equal(d.pending(), true);
  await wait(80);
  assert.equal(calls, 1, 'exactly one call after the delay, despite 3 schedule() calls');
  assert.equal(d.pending(), false);
});

test('flush() runs fn immediately and cancels any pending timer', async () => {
  let calls = 0;
  const d = createDebouncer(() => { calls++; }, 1000);
  d.schedule();
  assert.equal(d.pending(), true);
  const before = Date.now();
  d.flush();
  assert.equal(calls, 1, 'flush must call fn synchronously, not wait for the delay');
  assert.equal(d.pending(), false, 'flush must cancel the pending timer');
  await wait(1100);
  assert.equal(calls, 1, 'the cancelled timer must not fire later and double-call fn');
});

test('flush() with nothing scheduled still calls fn (manual "write now" always writes)', () => {
  let calls = 0;
  const d = createDebouncer(() => { calls++; }, 1000);
  d.flush();
  assert.equal(calls, 1);
});

test('a new schedule() after a completed run schedules again (not a one-shot)', async () => {
  let calls = 0;
  const d = createDebouncer(() => { calls++; }, 20);
  d.schedule();
  await wait(50);
  assert.equal(calls, 1);
  d.schedule();
  await wait(50);
  assert.equal(calls, 2);
});

test('fn receives the arguments passed to schedule()/flush()', async () => {
  const seen = [];
  const d = createDebouncer((...args) => seen.push(args), 20);
  d.schedule('a', 1);
  await wait(50);
  d.flush('b', 2);
  assert.deepEqual(seen, [['a', 1], ['b', 2]]);
});
