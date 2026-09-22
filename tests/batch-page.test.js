const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const utils = require('../lib/batch-utils');

function page({ runtimeReply } = {}) {
  const elements = new Map();
  const stored = {};
  const alerts = [];
  const sent = [];
  const element = () => ({ value: '', checked: false, textContent: '', innerHTML: '', dataset: {}, style: {}, disabled: false, children: [], classList: { add() {}, remove() {} }, addEventListener() {}, appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; }, focus() { this.focused = true; }, reportValidity() { return true; } });
  const context = {
    console, TextDecoder, TextEncoder, Uint8Array, URL, setTimeout, clearTimeout, Papa: require('../lib/papaparse.min.js'),
    window: { AutoCommentBatchUtils: utils },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, addEventListener() {} },
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return runtimeReply; } }, storage: { local: { get: async () => stored, set: async (value) => Object.assign(stored, value), remove: async (keys) => keys.forEach(key => delete stored[key]) } } },
    alert: (message) => alerts.push(message)
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../illegal-site-filter.js'), 'utf8'), context);
  context.window.AutoCommentIllegalSiteFilter = context.AutoCommentIllegalSiteFilter;
  vm.runInContext(fs.readFileSync(require.resolve('../batch.js'), 'utf8'), context);
  for (const id of ['apiKey', 'modelId', 'website', 'description', 'nickname', 'email']) context.document.getElementById(id);
  context.escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return { elements, stored, alerts, sent, run: (code) => vm.runInContext(code, context) };
}

test('saves and loads local credentials and website profile without sync storage', async () => {
  const app = page();
  const values = { apiKey: 'test-secret', modelId: 'provider/model', website: 'https://site.test', description: 'A useful site', nickname: 'Name', email: 'name@site.test' };
  for (const [id, value] of Object.entries(values)) app.elements.get(id).value = value;
  await app.run('saveLocalSettings()');
  assert.equal(app.stored.openrouter_api_key, 'test-secret');
  assert.equal(app.stored.openrouter_model, 'provider/model');
  assert.equal(app.stored.site_profile.website, 'https://site.test');
  app.elements.get('nickname').value = '';
  await app.run('loadLocalSettings()');
  assert.equal(app.elements.get('nickname').value, 'Name');
});

test('missing required configuration focuses the field and blocks starting', () => {
  const app = page();
  assert.equal(app.run('validateSettings()'), false);
  assert.equal(app.elements.get('apiKey').focused, true);
});

test('CSV accepts one headerless row, ignores extra columns, removes duplicates and previews hostname', () => {
  const app = page();
  app.run(`parseCSV(new TextEncoder().encode(${JSON.stringify('Example.com/article,ignore.test\nhttps://example.com/article,else.test\n')}).buffer, 'urls.csv')`);
  assert.equal(app.run('parsedUrls.length'), 1);
  assert.equal(app.run('parsedUrls[0].url'), 'https://example.com/article');
  assert.match(app.elements.get('fileCount').textContent, /去重 1/);
  assert.match(app.elements.get('urlPreviewBody').children[0].innerHTML, /example.com/);
  assert.doesNotMatch(app.elements.get('urlPreviewBody').children[0].innerHTML, /ignore.test|else.test/);
});

test('empty CSV and unclosed quotes produce useful errors', () => {
  const app = page();
  app.run("parseCSV(new Uint8Array([]).buffer, 'empty.csv')");
  assert.match(app.alerts[0], /没有有效 URL|为空/);
  app.run("parseCSV(new Uint8Array([34, 97]).buffer, 'broken.csv')");
  assert.match(app.alerts[1], /格式错误/);
});

test('importing a new CSV after completing a batch resets to idle and enables Start', async () => {
  const app = page();
  app.run("parseCSV(new TextEncoder().encode('first.example/article').buffer, 'first.csv')");
  app.run(`
    batchId = 'finished-batch';
    totalCount = 1;
    successCount = 1;
    currentIndex = 1;
    skippedIndices.add(0);
    localResults = [{ originalIndex: 0, url: parsedUrls[0].url, result: 'success', timestamp: Date.now(), elapsed: 1 }];
  `);
  await app.run('onAllCompleted()');
  assert.equal(app.run('status'), 'completed');
  assert.equal(app.elements.get('startBtn').disabled, true);

  app.run("parseCSV(new TextEncoder().encode('second.example/new').buffer, 'second.csv')");
  assert.equal(app.elements.get('startBtn').disabled, false);
  assert.equal(app.run('status'), 'idle');
  assert.equal(app.run('isTerminated'), false);
  assert.equal(app.run('batchId'), null);
  assert.equal(app.run('currentIndex'), 0);
  assert.equal(app.run('localResults.length'), 0);
  assert.equal(app.run('successCount'), 0);
  assert.equal(app.run('skippedIndices.size'), 0);
  assert.equal(app.run('parsedUrls.length'), 1);
  assert.equal(app.run('parsedUrls[0].url'), 'https://second.example/new');
  assert.equal(app.elements.get('fileName').textContent, 'second.csv');
});

test('connection test saves key/model, sends OPENROUTER_TEST and shows the reply', async () => {
  const app = page({ runtimeReply: { ok: true, text: 'OK', model: 'provider/model', elapsedMs: 820 } });
  app.elements.get('apiKey').value = 'test-secret';
  app.elements.get('modelId').value = 'provider/model';
  await app.run('testOpenRouterConnection()');
  assert.deepEqual(JSON.parse(JSON.stringify(app.sent)), [{ type: 'OPENROUTER_TEST' }]);
  assert.equal(app.stored.openrouter_api_key, 'test-secret');
  const status = app.elements.get('testConnectionStatus');
  assert.match(status.textContent, /连接成功/);
  assert.match(status.textContent, /provider\/model/);
  assert.match(status.textContent, /OK/);
  assert.equal(status.textContent.includes('test-secret'), false);
  assert.equal(app.elements.get('testConnectionBtn').disabled, false);
});

test('connection test shows provider errors and requires key and model first', async () => {
  const app = page({ runtimeReply: { ok: false, error: 'OpenRouter (401): User not found' } });
  await app.run('testOpenRouterConnection()');
  assert.equal(app.sent.length, 0);
  assert.equal(app.elements.get('apiKey').focused, true);
  app.elements.get('apiKey').value = 'bad';
  app.elements.get('modelId').value = 'provider/model';
  await app.run('testOpenRouterConnection()');
  assert.match(app.elements.get('testConnectionStatus').textContent, /连接失败.*401/);
});
