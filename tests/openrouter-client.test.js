const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenRouterRequest, parseOpenRouterResponse } = require('../lib/openrouter-client');
const fs = require('node:fs');
const vm = require('node:vm');

function loadBackground(payload, { networkError = false, configured = true } = {}) {
  const listeners = [];
  const requests = [];
  const tabs = [];
  const key = 'private-test-key';
  const chrome = {
    action: { onClicked: { addListener: (fn) => { chrome.click = fn; } } },
    tabs: { create: (options) => tabs.push(options) },
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, onMessage: { addListener: (fn) => listeners.push(fn) } },
    storage: { local: { get: async () => configured ? { openrouter_api_key: key, openrouter_model: 'provider/test-model' } : {} } }
  };
  const context = { chrome, console, AbortSignal, AutoCommentOpenRouter: { buildOpenRouterRequest, parseOpenRouterResponse }, fetch: async (url, options) => {
    requests.push({ url, options });
    if (networkError) throw new Error(key);
    return { ok: !payload?.error, status: payload?.error ? 401 : 200, json: async () => payload };
  } };
  const source = fs.readFileSync(require.resolve('../background.js'), 'utf8').replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(source, context);
  return { chrome, requests, tabs, send: (message) => new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of listeners) handled = listener(message, {}, resolve) || handled;
    if (!handled) reject(new Error('OPENROUTER_GENERATE message not handled'));
  }) };
}

test('builds the exact OpenRouter request and keeps the key only in Authorization', () => {
  const messages = [{ role: 'user', content: 'Write a relevant comment.' }];
  const { url, options } = buildOpenRouterRequest({ apiKey: 'private-test-key', model: 'provider/model', messages });
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { Authorization: 'Bearer private-test-key', 'Content-Type': 'application/json' });
  const body = JSON.parse(options.body);
  assert.deepEqual(body, { model: 'provider/model', messages, stream: false, max_completion_tokens: 600 });
  assert.equal(options.body.includes('private-test-key'), false);
});

test('rejects absent credentials, model and messages with useful errors', () => {
  assert.throws(() => buildOpenRouterRequest({ model: 'm', messages: [] }), /API Key/);
  assert.throws(() => buildOpenRouterRequest({ apiKey: 'k', model: '  ', messages: [] }), /模型/);
  assert.throws(() => buildOpenRouterRequest({ apiKey: 'k', model: 'm', messages: [] }), /messages/);
});

test('extracts and trims successful assistant text', () => {
  assert.deepEqual(parseOpenRouterResponse({ ok: true, status: 200 }, { choices: [{ message: { content: '  A thoughtful comment.\n' } }] }), { ok: true, text: 'A thoughtful comment.' });
});

for (const status of [401, 402, 429]) {
  test(`preserves OpenRouter ${status} errors`, () => {
    assert.deepEqual(parseOpenRouterResponse({ ok: false, status }, { error: { message: 'Request could not be completed' } }), { ok: false, error: `OpenRouter (${status}): Request could not be completed` });
  });
}

test('handles error payloads and malformed or empty replies', () => {
  assert.deepEqual(parseOpenRouterResponse({ ok: true, status: 200 }, { error: { message: 'Provider unavailable' } }), { ok: false, error: 'OpenRouter (200): Provider unavailable' });
  assert.deepEqual(parseOpenRouterResponse({ ok: false, status: 502 }, null), { ok: false, error: 'OpenRouter (502): 请求失败' });
  for (const payload of [null, {}, { choices: [] }, { choices: [{ message: { content: '   ' } }] }]) {
    assert.deepEqual(parseOpenRouterResponse({ ok: true, status: 200 }, payload), { ok: false, error: 'OpenRouter 未返回有效评论内容' });
  }
});

test('background routes the content message, reads local credentials, and opens batch page', async () => {
  const app = loadBackground({ choices: [{ message: { content: 'A relevant comment' } }] });
  app.chrome.click();
  assert.equal(app.tabs[0].url, 'chrome-extension://test/batch.html');
  const result = await app.send({ type: 'OPENROUTER_GENERATE', pageContext: { title: 'Gardening', summary: 'Growing tomatoes' }, siteProfile: { website: 'https://garden.test', description: 'Garden advice' } });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'A relevant comment');
  const request = app.requests[0];
  assert.equal(request.options.headers.Authorization, 'Bearer private-test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'provider/test-model');
  assert.match(JSON.stringify(body.messages), /Growing tomatoes/);
  assert.equal(JSON.stringify(result).includes('private-test-key'), false);
});

test('background never returns a key echoed by provider text, error or network exception', async () => {
  for (const payload of [{ error: { message: 'Invalid private-test-key' } }, { choices: [{ message: { content: 'private-test-key' } }] }]) {
    const app = loadBackground(payload);
    const result = await app.send({ type: 'OPENROUTER_GENERATE', pageContext: {}, siteProfile: {} });
    assert.equal(JSON.stringify(result).includes('private-test-key'), false);
  }
  const app = loadBackground(null, { networkError: true });
  const result = await app.send({ type: 'OPENROUTER_GENERATE', pageContext: {}, siteProfile: {} });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('private-test-key'), false);
});

test('missing local configuration fails before making a request', async () => {
  const app = loadBackground(null, { configured: false });
  const result = await app.send({ type: 'OPENROUTER_GENERATE', pageContext: {}, siteProfile: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /API Key/);
  assert.equal(app.requests.length, 0);
});
