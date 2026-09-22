const test = require('node:test');
const assert = require('node:assert/strict');

const { createSubmissionWaiter } = require('../lib/submission-waiter');

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
