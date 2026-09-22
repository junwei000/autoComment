(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AutoCommentSubmissionWaiter = api;
  }
}(typeof window !== 'undefined' ? window : null, function () {
  function createSubmissionWaiter(options) {
    const {
      timeoutMs,
      addNavigationListener,
      removeNavigationListener,
      setTimer,
      clearTimer
    } = options;
    let promise;
    let resolvePromise;
    let listener;
    let timerId = null;
    let started = false;
    let settled = false;
    let settledReason;

    function cleanup() {
      if (!started) return;
      removeNavigationListener(listener);
      if (timerId !== null) clearTimer(timerId);
      started = false;
      timerId = null;
    }

    function finish(reason) {
      if (settled) return;
      settled = true;
      settledReason = reason;
      cleanup();
      if (resolvePromise) resolvePromise(reason);
    }

    function wait() {
      if (promise) return promise;

      promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      if (settled) {
        resolvePromise(settledReason);
        return promise;
      }

      listener = () => finish('navigation');
      started = true;
      addNavigationListener(listener);
      if (!settled) {
        timerId = setTimer(() => finish('timeout'), timeoutMs);
      }

      return promise;
    }

    return {
      wait,
      dispose() {
        finish('disposed');
      }
    };
  }

  return { createSubmissionWaiter };
}));
