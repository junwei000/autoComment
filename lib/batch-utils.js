(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AutoCommentBatchUtils = api;
  }
}(typeof window !== 'undefined' ? window : null, function () {
  function normalizeUrl(value) {
    if (typeof value !== 'string') return null;

    const text = value.trim();
    if (!text) return null;

    const hasExplicitScheme = /^[a-z][a-z\d+.-]*:/i.test(text);
    const isSchemelessHostPort = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d-]+\.)+[a-z\d-]+):\d+(?:[/?#]|$)/i.test(text);
    const isHttpUrl = /^https?:\/\//i.test(text);

    if (hasExplicitScheme && !isSchemelessHostPort && !isHttpUrl) return null;

    const candidate = isHttpUrl ? text : `https://${text}`;

    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (!url.hostname) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  const MAX_URL_LINES = 300;

  // 输入框内容：每行一个完整的 http(s) 链接；空行忽略，超过 300 行直接拒绝
  function parseUrlLines(text) {
    const lines = (typeof text === 'string' ? text : '')
      .split(/\r?\n/)
      .map((line, index) => ({ value: line.trim(), lineNumber: index + 1 }))
      .filter((line) => line.value);
    const result = { items: [], lineCount: lines.length, invalidLines: [], duplicateCount: 0, tooMany: lines.length > MAX_URL_LINES };
    if (result.tooMany) return result;

    const seen = new Set();
    for (const { value, lineNumber } of lines) {
      const url = /^https?:\/\//i.test(value) ? normalizeUrl(value) : null;
      if (!url) {
        result.invalidLines.push(lineNumber);
      } else if (seen.has(url)) {
        result.duplicateCount += 1;
      } else {
        seen.add(url);
        result.items.push(url);
      }
    }
    return result;
  }

  function getDisplayDomain(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return '';
    return new URL(normalized).hostname.toLowerCase();
  }

  // ====== 单页超时：按阶段计时 ======
  // 常规阶段累计计入「单页超时」；AI 生成和提交阶段暂停单页计时，改用各自上限
  const PHASE_LABELS = {
    loading: '等待页面加载',
    finding: '查找评论框',
    generating: 'AI 生成中',
    filling: '填写表单',
    submitting: '提交中'
  };
  const PHASE_BUDGETS_MS = {
    generating: 200000, // 3 次请求 × 60s + 重试间隔
    submitting: 60000   // 提交请求最长 30s + 刷新后页面加载
  };
  const PHASE_TIMEOUT_MESSAGES = {
    generating: 'AI 生成超时',
    submitting: '提交超时'
  };

  function getPhaseLabel(phase) {
    return PHASE_LABELS[phase] || '';
  }

  function createTabTimer(now) {
    return { startTime: now, phase: 'loading', phaseStart: now, pausedMs: 0 };
  }

  function setTabPhase(timer, phase, now) {
    if (!PHASE_LABELS[phase] || timer.phase === phase) return;
    if (PHASE_BUDGETS_MS[timer.phase]) timer.pausedMs += now - timer.phaseStart;
    timer.phase = phase;
    timer.phaseStart = now;
  }

  function evaluateTabTimeout(timer, now, pageTimeoutMs) {
    const budget = PHASE_BUDGETS_MS[timer.phase];
    if (budget) {
      if (now - timer.phaseStart <= budget) return { timedOut: false };
      return { timedOut: true, message: `${PHASE_TIMEOUT_MESSAGES[timer.phase]}（${budget / 1000} 秒）` };
    }
    if (now - timer.startTime - timer.pausedMs <= pageTimeoutMs) return { timedOut: false };
    return { timedOut: true, message: `处理超时（${getPhaseLabel(timer.phase)}阶段）` };
  }

  return {
    parseUrlLines, MAX_URL_LINES, normalizeUrl, getDisplayDomain,
    createTabTimer, setTabPhase, evaluateTabTimeout, getPhaseLabel, PHASE_BUDGETS_MS
  };
}));
