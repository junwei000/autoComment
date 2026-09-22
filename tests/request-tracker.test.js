const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadTracker() {
  const events = [];
  class FakeXHR {
    constructor() { this.listeners = {}; }
    open() {}
    send() {}
    addEventListener(type, fn) { this.listeners[type] = fn; }
    finish() { this.listeners.loadend(); }
  }
  let resolveFetch;
  const window = {
    fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
    XMLHttpRequest: FakeXHR,
    dispatchEvent: (event) => events.push(JSON.parse(event.detail))
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/request-tracker.js'), 'utf8'), { window, CustomEvent, String, JSON, Set });
  return { window, events, resolveFetch: () => resolveFetch({ ok: true }) };
}

test('POST fetch emits start, then end once the response settles', async () => {
  const app = loadTracker();
  const pending = app.window.fetch('/wp-comments-post.php', { method: 'post' });
  assert.deepEqual(app.events.map((e) => e.phase), ['start']);
  assert.equal(app.events[0].method, 'POST');
  app.resolveFetch();
  await pending;
  await Promise.resolve();
  assert.deepEqual(app.events.map((e) => e.phase), ['start', 'end']);
  assert.equal(app.events[0].id, app.events[1].id);
});

test('GET requests are not tracked', () => {
  const app = loadTracker();
  app.window.fetch('/feed');
  const xhr = new app.window.XMLHttpRequest();
  xhr.open('GET', '/poll');
  xhr.send();
  assert.equal(app.events.length, 0);
});

test('POST XHR emits start on send and end on loadend', () => {
  const app = loadTracker();
  const xhr = new app.window.XMLHttpRequest();
  xhr.open('POST', '/wp-admin/admin-ajax.php');
  xhr.send('comment=hi');
  assert.deepEqual(app.events.map((e) => e.phase), ['start']);
  xhr.finish();
  assert.deepEqual(app.events.map((e) => [e.phase, e.url]), [['start', '/wp-admin/admin-ajax.php'], ['end', '/wp-admin/admin-ajax.php']]);
});
