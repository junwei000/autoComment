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

  // 点击提交后固定等待 10 秒；期间页面刷新则由新页面补确认
  const SUBMIT_TIMEOUT_MS = 10000;
  // 刷新后的页面只在该时间窗内补确认，避免过期上下文误报
  const RESTORE_WINDOW_MS = 2 * 60 * 1000;

  function createSubmitContext({ batchId, urlIndex, url, aiContent }, now) {
    return {
      batchId,
      urlIndex,
      url: url || '',
      result: 'success',
      aiContent: aiContent || null,
      errorMessage: null,
      submittedAt: now
    };
  }

  function siteKey(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function isSameSite(a, b) {
    const left = siteKey(a);
    const right = siteKey(b);
    if (!left || !right) return false;
    return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
  }

  // 返回应发给 background 的确认数据；上下文无效、过期或不属于当前站点时返回 null
  function readRestoredSubmitContext(ctx, pageUrl, now) {
    if (!ctx || !ctx.batchId || !Number.isInteger(ctx.urlIndex)) return null;
    if (typeof ctx.submittedAt !== 'number' || now - ctx.submittedAt > RESTORE_WINDOW_MS) return null;
    if (!isSameSite(ctx.url, pageUrl)) return null;
    return {
      batchId: ctx.batchId,
      urlIndex: ctx.urlIndex,
      url: ctx.url,
      result: ctx.result || 'success',
      aiContent: ctx.aiContent || null,
      errorMessage: ctx.errorMessage || null
    };
  }

  return { createSubmissionWaiter, createSubmitContext, readRestoredSubmitContext, SUBMIT_TIMEOUT_MS };
}));
