const test = require('node:test');
const assert = require('node:assert/strict');

const { createSubmitContext, readRestoredSubmitContext } = require('../lib/submission-waiter');

test('createSubmitContext persists everything the restored page needs to confirm', () => {
  const ctx = createSubmitContext({ batchId: 'b1', urlIndex: 3, url: 'https://blog.example/post', aiContent: 'Nice post' }, 1000);
  assert.deepEqual(ctx, { batchId: 'b1', urlIndex: 3, url: 'https://blog.example/post', result: 'success', aiContent: 'Nice post', errorMessage: null, submittedAt: 1000 });
});

test('restored page on the same site within the window yields a success confirmation', () => {
  const ctx = createSubmitContext({ batchId: 'b1', urlIndex: 3, url: 'https://www.blog.example/post', aiContent: 'Nice post' }, 1000);
  assert.deepEqual(readRestoredSubmitContext(ctx, 'https://blog.example/post/#comment-9', 5000), {
    batchId: 'b1', urlIndex: 3, url: 'https://www.blog.example/post', result: 'success', aiContent: 'Nice post', errorMessage: null
  });
});

test('restored context is ignored on other sites, when stale, or when malformed', () => {
  const ctx = createSubmitContext({ batchId: 'b1', urlIndex: 0, url: 'https://blog.example/post', aiContent: 'x' }, 1000);
  assert.equal(readRestoredSubmitContext(ctx, 'https://unrelated.test/', 2000), null);
  assert.equal(readRestoredSubmitContext(ctx, 'https://blog.example/post', 1000 + 5 * 60 * 1000), null);
  assert.equal(readRestoredSubmitContext(null, 'https://blog.example/post', 2000), null);
  assert.equal(readRestoredSubmitContext({ ...ctx, urlIndex: undefined }, 'https://blog.example/post', 2000), null);
});

const { createSubmitMonitor, SUBMIT_MONITOR_DEFAULTS } = require('../lib/submission-waiter');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, ms) { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    pending: () => timers.size
  };
}

function monitor(clock) {
  return createSubmitMonitor({ idleMs: 10_000, quietMs: 1_000, maxMs: 30_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
}

test('submit monitor defaults: 10s idle, 1s quiet, 30s cap', () => {
  assert.deepEqual(SUBMIT_MONITOR_DEFAULTS, { idleMs: 10_000, quietMs: 1_000, maxMs: 30_000 });
});

test('submit monitor waits for the submit request to finish, then a quiet period', async () => {
  const clock = fakeClock();
  const m = monitor(clock);
  let reason = null;
  m.wait().then((r) => { reason = r; });
  m.requestStarted('r1');
  clock.advance(12_000); // well past the idle window, request still in flight
  await Promise.resolve();
  assert.equal(reason, null);
  m.requestEnded('r1');
  clock.advance(999);
  await Promise.resolve();
  assert.equal(reason, null);
  clock.advance(1);
  await Promise.resolve();
  assert.equal(reason, 'requests-settled');
  assert.equal(clock.pending(), 0);
});

test('a follow-up request during the quiet period extends the wait', async () => {
  const clock = fakeClock();
  const m = monitor(clock);
  let reason = null;
  m.wait().then((r) => { reason = r; });
  m.requestStarted('r1');
  m.requestEnded('r1');
  clock.advance(500);
  m.requestStarted('r2');
  clock.advance(2_000);
  await Promise.resolve();
  assert.equal(reason, null);
  m.requestEnded('r2');
  clock.advance(1_000);
  await Promise.resolve();
  assert.equal(reason, 'requests-settled');
});

test('navigation wins immediately and later events are ignored', async () => {
  const clock = fakeClock();
  const m = monitor(clock);
  const waiting = m.wait();
  m.requestStarted('r1');
  m.navigated();
  m.requestEnded('r1');
  clock.advance(60_000);
  assert.equal(await waiting, 'navigation');
  assert.equal(clock.pending(), 0);
});

test('no request and no navigation within 10s resolves as no-activity', async () => {
  const clock = fakeClock();
  const m = monitor(clock);
  const waiting = m.wait();
  clock.advance(10_000);
  assert.equal(await waiting, 'no-activity');
});

test('a request that never finishes resolves as max-timeout after 30s', async () => {
  const clock = fakeClock();
  const m = monitor(clock);
  const waiting = m.wait();
  clock.advance(2_000);
  m.requestStarted('hang');
  clock.advance(28_000);
  assert.equal(await waiting, 'max-timeout');
  assert.equal(clock.pending(), 0);
});
