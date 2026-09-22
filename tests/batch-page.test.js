const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const utils = require('../lib/batch-utils');

// 把文本填进 URL 输入框并点「加载」
const load = (text) => `urlInput.value = ${JSON.stringify(text)}; loadUrlInput()`;

function page({ runtimeReply, stored: initialStore } = {}) {
  const elements = new Map();
  const stored = initialStore || {};
  const alerts = [];
  const sent = [];
  const element = () => ({ value: '', checked: false, textContent: '', innerHTML: '', dataset: {}, style: {}, disabled: false, children: [], classList: { add() {}, remove() {} }, addEventListener() {}, appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; }, focus() { this.focused = true; }, reportValidity() { return true; } });
  const context = {
    console, TextDecoder, TextEncoder, Uint8Array, URL, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    window: { AutoCommentBatchUtils: utils },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, addEventListener() {} },
    chrome: { tabs: {
      created: [], removed: [], removedListeners: [], nextId: 100,
      create(options, cb) { const tab = { id: this.nextId++, url: options.url }; this.created.push(tab); setTimeout(() => cb(tab), 5); },
      remove(id, cb) { this.removed.push(id); cb && cb(); },
      sendMessage: () => new Promise(() => {}),
      onRemoved: { addListener(fn) { context.chrome.tabs.removedListeners.push(fn); }, removeListener(fn) { const l = context.chrome.tabs.removedListeners; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
      fireRemoved(id) { [...this.removedListeners].forEach((fn) => fn(id, {})); }
    }, runtime: { sendMessage: async (message) => { sent.push(message); return runtimeReply; } }, storage: { local: { get: async () => stored, set: async (value) => Object.assign(stored, value), remove: async (keys) => keys.forEach(key => delete stored[key]) } } },
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

const rowText = (row) => row.children.map((cell) => cell.textContent).join(' | ');

test('URL input loads full links, removes duplicates and previews the full URL', () => {
  const app = page();
  app.run(load('https://example.com/article\nhttps://example.com/article\n'));
  assert.equal(app.run('parsedUrls.length'), 1);
  assert.equal(app.run('parsedUrls[0].url'), 'https://example.com/article');
  assert.match(app.elements.get('urlSummary').textContent, /共 1 条.*去重 1 条/);
  const row = app.elements.get('urlPreviewBody').children[0];
  assert.equal(row.children[1].textContent, 'https://example.com/article');
  assert.equal(row.children[2].textContent, '待处理');
});

test('empty input, links without scheme and more than 300 lines are rejected with a message', () => {
  const app = page();
  app.run(load('   \n'));
  assert.match(app.elements.get('urlSummary').textContent, /请输入/);
  assert.equal(app.run('parsedUrls.length'), 0);

  app.run(load('https://ok.example/a\nexample.com/b'));
  assert.equal(app.run('parsedUrls.length'), 1);
  assert.match(app.elements.get('urlSummary').textContent, /第 2 行/);

  const many = Array.from({ length: 301 }, (_, i) => `https://s.example/${i}`).join('\n');
  app.run(load(many));
  assert.match(app.elements.get('urlSummary').textContent, /最多 300 行.*301/);
  assert.equal(app.run('parsedUrls.length'), 1, 'previous list is kept');
  assert.equal(app.alerts.length, 0);
});

test('the line counter tracks non-empty lines and warns past 300', () => {
  const app = page();
  app.run("urlInput.value = 'https://a.example/1\\n\\nhttps://a.example/2'; updateUrlLineCounter()");
  assert.equal(app.elements.get('urlLineCounter').textContent, '2 / 300 行');
  app.run(`urlInput.value = ${JSON.stringify(Array.from({ length: 305 }, (_, i) => `https://s.example/${i}`).join('\n'))}; updateUrlLineCounter()`);
  assert.equal(app.elements.get('urlLineCounter').dataset.state, 'error');
});

test('loading new URLs after completing a batch resets to idle and enables Start', async () => {
  const app = page();
  app.run(load('https://first.example/article'));
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

  app.run(load('https://second.example/new'));
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

test('preview rows show processing, then keep a success mark after the task completes', () => {
  const app = page();
  app.run(load('https://a.example/post\nhttps://b.example/post'));
  const [first, second] = app.elements.get('urlPreviewBody').children;
  app.run("highlightPreviewRow(0, 'processing')");
  assert.equal(first.children[2].textContent, '处理中');
  app.run("parsedUrls[0].url; totalCount = 2; status = 'running'; handleTabResult(0, 'success', 'Nice post', null, 3)");
  assert.equal(first.children[2].textContent, 'success');
  assert.equal(first.className, 'url-done-success');
  app.run("handleTabResult(1, 'fail', null, 'boom', 2)");
  assert.equal(second.children[2].textContent, '失败');
});

test('a tab waiting on AI is not killed by the page timeout, and shows the phase', async () => {
  const app = page();
  app.run(load('https://a.example/post'));
  app.run(`
    batchId = 'b1'; totalCount = 1; status = 'running'; timeoutSeconds = 60;
    activeTabs.set(7, { urlIndex: 0, ...window.AutoCommentBatchUtils.createTabTimer(Date.now() - 100000) });
  `);
  app.run("handleBatchPhase({ type: 'BATCH_PHASE', batchId: 'b1', urlIndex: 0, phase: 'generating' })");
  const row = app.elements.get('urlPreviewBody').children[0];
  assert.equal(row.children[2].textContent, '处理中 · AI 生成中');
  // 100s since open, but the AI phase started just now: page timeout is paused
  await app.run('checkTimeouts()');
  assert.equal(app.run('localResults.length'), 0);
  assert.equal(app.run('activeTabs.has(7)'), true);
});

test('page timeout reports the phase that stalled', async () => {
  const app = page();
  app.run(load('https://a.example/post'));
  app.run(`
    batchId = 'b1'; totalCount = 1; status = 'running'; timeoutSeconds = 60;
    activeTabs.set(7, { urlIndex: 0, ...window.AutoCommentBatchUtils.createTabTimer(Date.now() - 61000) });
  `);
  app.run("handleBatchPhase({ type: 'BATCH_PHASE', batchId: 'b1', urlIndex: 0, phase: 'finding' })");
  await app.run('checkTimeouts()');
  assert.equal(app.run('localResults[0].errorMessage'), '处理超时（查找评论框阶段）');
});

test('phase messages from another batch are ignored', () => {
  const app = page();
  app.run(load('https://a.example/post'));
  app.run(`batchId = 'b1'; activeTabs.set(7, { urlIndex: 0, ...window.AutoCommentBatchUtils.createTabTimer(Date.now()) });`);
  app.run("handleBatchPhase({ type: 'BATCH_PHASE', batchId: 'old', urlIndex: 0, phase: 'generating' })");
  assert.equal(app.run('activeTabs.get(7).phase'), 'loading');
});

const clone = (value) => JSON.parse(JSON.stringify(value));

function runTwoResults(app) {
  app.run(load('https://a.example/post\nhttps://b.example/post\nhttps://c.example/post'));
  app.run(`batchId = 'b1'; totalCount = 3; pendingCount = 3; setStatus('running');`);
  app.run("handleTabResult(0, 'success', 'Nice post', null, 4)");
  app.run("handleTabResult(1, 'fail', null, 'boom', 2)");
}

test('file, statuses and progress survive reopening the batch page', async () => {
  const first = page();
  runTwoResults(first);
  await first.run('stopBatch()');

  const second = page({ stored: clone(first.stored) });
  await second.run('restoreBatchSnapshot()');
  assert.equal(second.run('parsedUrls.length'), 3);
  assert.equal(second.elements.get('urlInput').value, 'https://a.example/post\nhttps://b.example/post\nhttps://c.example/post');
  const rows = second.elements.get('urlPreviewBody').children;
  assert.equal(rows[0].children[1].textContent, 'https://a.example/post');
  assert.equal(rows[0].children[2].textContent, 'success');
  assert.equal(rows[1].children[2].textContent, '失败');
  assert.equal(rows[2].children[2].textContent, '待处理');
  assert.equal(second.run('successCount'), 1);
  assert.equal(second.run('failCount'), 1);
  assert.equal(second.run('localResults.length'), 2);
  assert.equal(second.run('status'), 'terminated');
  assert.equal(second.run('batchId'), 'b1');
  assert.equal(second.elements.get('progressText').textContent, '2/3 (67%)');
  assert.equal(second.elements.get('startBtn').disabled, false);
});

test('a batch that was running when the page closed comes back as terminated and resumable', async () => {
  const first = page();
  runTwoResults(first);
  const second = page({ stored: clone(first.stored) });
  await second.run('restoreBatchSnapshot()');
  assert.equal(second.run('status'), 'terminated');
  assert.equal(second.run('isTerminated'), true);
  assert.equal(second.elements.get('startBtn').textContent, '▶ 继续处理');
});

test('results confirmed while the batch page was closed are merged on restore', async () => {
  const first = page();
  runTwoResults(first);
  const stored = clone(first.stored);
  stored.batchResults = [{ batchId: 'b1', urlIndex: 2, url: 'https://c.example/post', result: 'success', aiContent: 'Late', timestamp: 1 },
    { batchId: 'other', urlIndex: 0, result: 'fail', timestamp: 1 }];
  const second = page({ stored });
  await second.run('restoreBatchSnapshot()');
  assert.equal(second.run('successCount'), 2);
  assert.equal(second.run('localResults.length'), 3);
  assert.equal(second.run('status'), 'completed');
});

test('loading a new URL list clears the previous task records', async () => {
  const first = page();
  runTwoResults(first);
  await first.run('stopBatch()');
  first.run(load('https://new.example/post'));
  const snapshot = first.stored.batch_state_snapshot;
  assert.equal(snapshot.urls.length, 1);
  assert.equal(snapshot.urls[0].url, 'https://new.example/post');
  assert.deepEqual(clone(snapshot.results), []);
  assert.equal(snapshot.status, 'idle');

  const second = page({ stored: clone(first.stored) });
  await second.run('restoreBatchSnapshot()');
  assert.equal(second.run('successCount'), 0);
  assert.equal(second.run('status'), 'idle');
  assert.equal(second.elements.get('urlPreviewBody').children[0].children[2].textContent, '待处理');
});

test('clearing the batch removes the snapshot', async () => {
  const app = page();
  runTwoResults(app);
  await app.run('stopBatch()');
  app.run('clearBatch()');
  assert.equal(app.stored.batch_state_snapshot, undefined);
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function stoppedBatch(app) {
  for (const id of ['apiKey', 'modelId', 'website', 'description', 'nickname', 'email']) app.elements.get(id).value = id === 'website' ? 'https://mine.example' : id === 'email' ? 'me@mine.example' : 'x';
  app.run(load('https://a.example/1\nhttps://a.example/2\nhttps://a.example/3'));
  app.run(`batchId = 'b1'; totalCount = 3; pendingCount = 3; setStatus('running');`);
  app.run("handleTabResult(0, 'success', 'ok', null, 1)");
  app.run("isTerminated = true; setStatus('terminated'); currentIndex = 1;");
}

test('clicking 继续处理 twice quickly still opens only one tab', async () => {
  const app = page();
  stoppedBatch(app);
  app.run('resumeBatch(); resumeBatch();');
  await tick();
  assert.equal(app.run('chrome.tabs.created.length'), 1);
  assert.equal(app.run('chrome.tabs.created[0].url'), 'https://a.example/2');
});

test('back-to-back open requests before the tab exists open only one tab', async () => {
  const app = page();
  stoppedBatch(app);
  app.run("isTerminated = false; setStatus('running'); openNextTabSync(); openNextTabSync(); setTimeout(openNextTabSync, 0);");
  await tick();
  assert.equal(app.run('chrome.tabs.created.length'), 1);
  assert.equal(app.run('activeTabCount'), 1);
});

test('a tab closed by 停止 does not open another tab after 继续处理', async () => {
  const app = page();
  stoppedBatch(app);
  app.run("isTerminated = false; setStatus('running'); openNextTabSync();");
  await tick();
  const firstTab = app.run('chrome.tabs.created[0].id');
  await app.run('stopBatch()');
  app.run('resumeBatch()');
  await tick();
  // the close event of the stopped tab arrives late
  app.run(`chrome.tabs.fireRemoved(${firstTab})`);
  await tick();
  assert.equal(app.run('chrome.tabs.created.length'), 2, 'one tab before stop, one after continue');
  assert.equal(app.run('activeTabCount'), 1);
});

test('tabs left open when the batch page was reloaded are closed before continuing', async () => {
  const first = page();
  stoppedBatch(first);
  first.run("isTerminated = false; setStatus('running'); openNextTabSync();");
  await tick();
  const orphan = first.run('chrome.tabs.created[0].id');

  const second = page({ stored: clone(first.stored) });
  for (const id of ['apiKey', 'modelId', 'website', 'description', 'nickname', 'email']) second.elements.get(id).value = id === 'website' ? 'https://mine.example' : id === 'email' ? 'me@mine.example' : 'x';
  await second.run('restoreBatchSnapshot()');
  await second.run('resumeBatch()');
  await tick();
  assert.deepEqual(second.run('chrome.tabs.removed'), [orphan]);
  assert.equal(second.run('chrome.tabs.created.length'), 1);
});

test('after a page timeout the tab is closed and the next URL opens', async () => {
  const app = page();
  stoppedBatch(app);
  app.run("isTerminated = false; setStatus('running'); timeoutSeconds = 60; openNextTabSync();");
  await tick();
  const tabId = app.run('chrome.tabs.created[0].id');
  app.run(`activeTabs.get(${tabId}).startTime = Date.now() - 61000`);
  await app.run('checkTimeouts()');
  assert.deepEqual(app.run('chrome.tabs.removed'), [tabId]);
  assert.equal(app.run('localResults.find((r) => r.originalIndex === 1).errorMessage'), '处理超时（等待页面加载阶段）');
  app.run(`chrome.tabs.fireRemoved(${tabId})`);
  await tick();
  assert.equal(app.run('chrome.tabs.created.length'), 2);
  assert.equal(app.run('chrome.tabs.created[1].url'), 'https://a.example/3');
  assert.equal(app.run('activeTabCount'), 1);
});
