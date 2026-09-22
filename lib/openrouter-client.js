(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AutoCommentOpenRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  function buildOpenRouterRequest({ apiKey, model, messages }) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('请配置 OpenRouter API Key');
    if (typeof model !== 'string' || !model.trim()) throw new Error('请配置 OpenRouter 模型 ID');
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('缺少 messages');
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      options: {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.trim(), messages, stream: false, max_completion_tokens: 600 })
      }
    };
  }

  function parseOpenRouterResponse(response, payload) {
    if (!response.ok || payload?.error) {
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : '请求失败';
      return { ok: false, error: `OpenRouter (${response.status}): ${message}` };
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'OpenRouter 未返回有效评论内容' };
    return { ok: true, text: content.trim() };
  }

  return { buildOpenRouterRequest, parseOpenRouterResponse };
}));
