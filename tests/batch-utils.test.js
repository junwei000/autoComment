const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseUrlCsv,
  normalizeUrl,
  getDisplayDomain
} = require('../lib/batch-utils');

test('parseUrlCsv skips an optional case-insensitive url header', () => {
  const result = parseUrlCsv('URL\nexample.com\nhttps://www.example.org/path');

  assert.deepEqual(result, {
    items: ['https://example.com/', 'https://www.example.org/path'],
    invalidCount: 0,
    duplicateCount: 0
  });
});

test('parseUrlCsv reads only the first CSV column', () => {
  const result = parseUrlCsv([
    'https://first.example,not a URL',
    'not a URL,https://second.example',
    'https://third.example,"comma, in ignored column"'
  ].join('\n'));

  assert.deepEqual(result, {
    items: ['https://first.example/', 'https://third.example/'],
    invalidCount: 1,
    duplicateCount: 0
  });
});

test('parseUrlCsv ignores multiline quoted values outside the first column', () => {
  const result = parseUrlCsv([
    'url,notes',
    'https://first.example,"ignored value',
    'on another line"',
    'https://second.example,another ignored value'
  ].join('\n'));

  assert.deepEqual(result, {
    items: ['https://first.example/', 'https://second.example/'],
    invalidCount: 0,
    duplicateCount: 0
  });
});

test('normalizeUrl trims input, adds https, and rejects invalid or unsupported URLs', () => {
  assert.equal(normalizeUrl('  example.com/a?b=1  '), 'https://example.com/a?b=1');
  assert.equal(normalizeUrl('HTTP://EXAMPLE.COM'), 'http://example.com/');
  assert.equal(normalizeUrl('example.com:8080/path'), 'https://example.com:8080/path');
  assert.equal(normalizeUrl('localhost:3000/path'), 'https://localhost:3000/path');
  assert.equal(normalizeUrl('mailto:user@example.com'), null);
  assert.equal(normalizeUrl('tel:123'), null);
  assert.equal(normalizeUrl('ftp://example.com'), null);
  assert.equal(normalizeUrl('not a URL'), null);
  assert.equal(normalizeUrl(''), null);
});

test('parseUrlCsv de-duplicates normalized URLs and counts invalid entries', () => {
  const result = parseUrlCsv('example.com\nhttps://example.com/\nftp://invalid.example\nexample.org');

  assert.deepEqual(result, {
    items: ['https://example.com/', 'https://example.org/'],
    invalidCount: 1,
    duplicateCount: 1
  });
});

test('getDisplayDomain returns the lowercase hostname including www', () => {
  assert.equal(getDisplayDomain('https://WWW.Example.COM:8080/path'), 'www.example.com');
  assert.equal(getDisplayDomain('invalid URL'), '');
});

const { createTabTimer, setTabPhase, evaluateTabTimeout, getPhaseLabel, PHASE_BUDGETS_MS } = require('../lib/batch-utils');

test('AI generation budget covers three 60s attempts plus retry delays; submit budget covers 30s request cap plus reload', () => {
  assert.ok(PHASE_BUDGETS_MS.generating >= 3 * 60_000 + 3_000);
  assert.ok(PHASE_BUDGETS_MS.submitting >= 30_000 + 20_000);
});

test('page timeout counts loading and comment-box search from tab open', () => {
  const timer = createTabTimer(0);
  setTabPhase(timer, 'finding', 20_000);
  assert.deepEqual(evaluateTabTimeout(timer, 59_000, 60_000), { timedOut: false });
  assert.deepEqual(evaluateTabTimeout(timer, 61_000, 60_000), { timedOut: true, message: '处理超时（查找评论框阶段）' });
});

test('time spent waiting for AI does not count against the page timeout', () => {
  const timer = createTabTimer(0);
  setTabPhase(timer, 'generating', 40_000);
  // 90s into AI generation: well past the 60s page timeout, but AI has its own budget
  assert.deepEqual(evaluateTabTimeout(timer, 130_000, 60_000), { timedOut: false });
  setTabPhase(timer, 'filling', 130_000);
  // only 40s (before AI) + 15s (after AI) counted
  assert.deepEqual(evaluateTabTimeout(timer, 145_000, 60_000), { timedOut: false });
  assert.deepEqual(evaluateTabTimeout(timer, 151_000, 60_000), { timedOut: true, message: '处理超时（填写表单阶段）' });
});

test('AI generation that exceeds its own budget times out with a specific message', () => {
  const timer = createTabTimer(0);
  setTabPhase(timer, 'generating', 10_000);
  const result = evaluateTabTimeout(timer, 10_000 + PHASE_BUDGETS_MS.generating + 1, 60_000);
  assert.equal(result.timedOut, true);
  assert.equal(result.message, `AI 生成超时（${PHASE_BUDGETS_MS.generating / 1000} 秒）`);
});

test('submitting has its own budget too', () => {
  const timer = createTabTimer(0);
  setTabPhase(timer, 'submitting', 50_000);
  assert.deepEqual(evaluateTabTimeout(timer, 50_000 + PHASE_BUDGETS_MS.submitting - 1, 60_000), { timedOut: false });
  assert.equal(evaluateTabTimeout(timer, 50_000 + PHASE_BUDGETS_MS.submitting + 1, 60_000).message, `提交超时（${PHASE_BUDGETS_MS.submitting / 1000} 秒）`);
});

test('unknown phases are ignored and labels are readable', () => {
  const timer = createTabTimer(0);
  setTabPhase(timer, 'bogus', 1_000);
  assert.equal(timer.phase, 'loading');
  assert.equal(getPhaseLabel('generating'), 'AI 生成中');
  assert.equal(getPhaseLabel('loading'), '等待页面加载');
});
