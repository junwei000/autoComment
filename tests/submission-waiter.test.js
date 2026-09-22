const test = require('node:test');
const assert = require('node:assert/strict');

const { createSubmissionWaiter, createSubmitContext, readRestoredSubmitContext, SUBMIT_TIMEOUT_MS } = require('../lib/submission-waiter');

function createControlledWaiter() {
  let navigationListener;
  let timerCallback;
  const calls = { add: 0, remove: 0, clear: 0 };

  return {
    waiter: createSubmissionWaiter({
      timeoutMs: 10_000,
      addNavigationListener(listener) {
        calls.add += 1;
        navigationListener = listener;
      },
      removeNavigationListener(listener) {
        calls.remove += 1;
        assert.equal(listener, navigationListener);
      },
      setTimer(callback, timeoutMs) {
        assert.equal(timeoutMs, 10_000);
        timerCallback = callback;
        return 'timer-id';
      },
      clearTimer(timerId) {
        calls.clear += 1;
        assert.equal(timerId, 'timer-id');
      }
    }),
    calls,
    triggerNavigation() {
      navigationListener();
    },
    triggerTimeout() {
      timerCallback();
    }
  };
}

test('wait resolves with navigation and cleans up when navigation arrives first', async () => {
  const controlled = createControlledWaiter();
  const waiting = controlled.waiter.wait();

  controlled.triggerNavigation();

  assert.equal(await waiting, 'navigation');
  assert.deepEqual(controlled.calls, { add: 1, remove: 1, clear: 1 });
});

test('wait resolves with timeout and cleans up when the timeout arrives first', async () => {
  const controlled = createControlledWaiter();
  const waiting = controlled.waiter.wait();

  controlled.triggerTimeout();

  assert.equal(await waiting, 'timeout');
  assert.deepEqual(controlled.calls, { add: 1, remove: 1, clear: 1 });
});

test('wait resolves exactly once when navigation and timeout both fire', async () => {
  const controlled = createControlledWaiter();
  const waiting = controlled.waiter.wait();

  controlled.triggerNavigation();
  controlled.triggerTimeout();

  assert.equal(await waiting, 'navigation');
  assert.deepEqual(controlled.calls, { add: 1, remove: 1, clear: 1 });
});

test('post-submit timeout is exactly 10 seconds', () => {
  assert.equal(SUBMIT_TIMEOUT_MS, 10_000);
});

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
