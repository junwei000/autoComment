// 运行在页面主环境（manifest world: MAIN），content script 的隔离环境看不到页面自己的 fetch/XHR。
// 只追踪会写数据的请求（POST/PUT/PATCH/DELETE），通过 DOM 事件把开始/结束通知给 content.js。
(function () {
  if (window.__autoCommentRequestTracker) return;
  window.__autoCommentRequestTracker = true;

  const EVENT_NAME = 'autocomment:request';
  const TRACKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  let nextId = 1;

  function emit(phase, id, method, url) {
    // detail 用字符串，保证能跨环境读取
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: JSON.stringify({ phase, id, method, url: String(url || '').slice(0, 500) })
    }));
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (!TRACKED_METHODS.has(method)) return originalFetch.apply(this, arguments);
      const id = `f${nextId++}`;
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      emit('start', id, method, url);
      const done = () => emit('end', id, method, url);
      const result = originalFetch.apply(this, arguments);
      result.then(done, done);
      return result;
    };
  }

  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    xhrProto.open = function (method, url) {
      this.__autoCommentRequest = { method: String(method || 'GET').toUpperCase(), url };
      return originalOpen.apply(this, arguments);
    };
    xhrProto.send = function () {
      const info = this.__autoCommentRequest;
      if (info && TRACKED_METHODS.has(info.method)) {
        const id = `x${nextId++}`;
        emit('start', id, info.method, info.url);
        this.addEventListener('loadend', () => emit('end', id, info.method, info.url), { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }
}());
