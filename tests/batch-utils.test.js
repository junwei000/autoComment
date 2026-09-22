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
