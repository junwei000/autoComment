(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AutoCommentSubmissionWaiter = api;
  }
}(typeof window !== 'undefined' ? window : null, function () {
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

  const SUBMIT_MONITOR_DEFAULTS = { idleMs: 10000, quietMs: 1000, maxMs: 30000 };

  // 点击提交后的等待：
  // - 页面跳转 → 'navigation'（由新页面加载完成后确认）
  // - 提交请求全部结束且静默 quietMs → 'requests-settled'
  // - idleMs 内既无请求也无跳转 → 'no-activity'
  // - 请求迟迟不结束，到 maxMs → 'max-timeout'
  function createSubmitMonitor(options) {
    const { idleMs, quietMs, maxMs } = { ...SUBMIT_MONITOR_DEFAULTS, ...options };
    const { setTimer, clearTimer } = options;
    const inflight = new Set();
    const timers = { idle: null, quiet: null, max: null };
    let sawRequest = false;
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });

    function stop(name) {
      if (timers[name] !== null) {
        clearTimer(timers[name]);
        timers[name] = null;
      }
    }

    function finish(reason) {
      if (settled) return;
      settled = true;
      stop('idle');
      stop('quiet');
      stop('max');
      resolvePromise(reason);
    }

    timers.idle = setTimer(() => {
      timers.idle = null;
      if (!sawRequest) finish('no-activity');
    }, idleMs);
    timers.max = setTimer(() => {
      timers.max = null;
      finish('max-timeout');
    }, maxMs);

    return {
      wait: () => promise,
      requestStarted(id) {
        if (settled) return;
        sawRequest = true;
        inflight.add(id);
        stop('idle');
        stop('quiet');
      },
      requestEnded(id) {
        if (settled || !inflight.delete(id) || inflight.size > 0) return;
        stop('quiet');
        timers.quiet = setTimer(() => {
          timers.quiet = null;
          finish('requests-settled');
        }, quietMs);
      },
      navigated() {
        finish('navigation');
      },
      dispose() {
        finish('disposed');
      }
    };
  }

  return { createSubmitContext, readRestoredSubmitContext, createSubmitMonitor, SUBMIT_MONITOR_DEFAULTS };
}));
