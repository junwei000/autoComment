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

  function readFirstColumn(text) {
    const values = [];
    let value = '';
    let quoted = false;
    let atStartOfField = true;
    let fieldIndex = 0;

    for (let index = 0; index <= text.length; index += 1) {
      const character = index === text.length ? '\n' : text[index];

      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          if (fieldIndex === 0) value += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else if (fieldIndex === 0) {
          value += character;
        }
        continue;
      }

      if (character === '"' && atStartOfField) {
        quoted = true;
        atStartOfField = false;
      } else if (character === ',') {
        fieldIndex += 1;
        atStartOfField = true;
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        values.push(value);
        value = '';
        quoted = false;
        atStartOfField = true;
        fieldIndex = 0;
      } else {
        if (fieldIndex === 0) value += character;
        atStartOfField = false;
      }
    }

    return values;
  }

  function parseUrlCsv(text) {
    const rows = readFirstColumn(typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '');
    const firstRow = rows[0] && rows[0].trim().toLowerCase() === 'url' ? 1 : 0;
    const items = [];
    const seen = new Set();
    let invalidCount = 0;
    let duplicateCount = 0;

    for (let index = firstRow; index < rows.length; index += 1) {
      const value = rows[index].trim();
      if (!value) continue;

      const url = normalizeUrl(value);
      if (!url) {
        invalidCount += 1;
      } else if (seen.has(url)) {
        duplicateCount += 1;
      } else {
        seen.add(url);
        items.push(url);
      }
    }

    return { items, invalidCount, duplicateCount };
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
    parseUrlCsv, normalizeUrl, getDisplayDomain,
    createTabTimer, setTabPhase, evaluateTabTimeout, getPhaseLabel, PHASE_BUDGETS_MS
  };
}));
