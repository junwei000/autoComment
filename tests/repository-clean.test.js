const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function runtimeFiles() {
  const files = new Set(['manifest.json', manifest.background.service_worker, manifest.options_page]);
  for (const script of manifest.content_scripts) script.js.forEach((file) => files.add(file));
  const html = fs.readFileSync(path.join(root, manifest.options_page), 'utf8');
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) files.add(src);
  files.add('lib/openrouter-client.js');
  return [...files];
}

test('runtime files never reference the private backend, points, payment or CSV sales', () => {
  const forbidden = [/jieyunsang/i, /sendBeacon/, /get-points|deduct-points|refund-points/, /积分/, /payment\.html|alipay/i, /csv-batches|csv-purchase/i, /auto_comment_user_id/];
  for (const file of runtimeFiles()) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
  }
});

test('backend, payment, sale and generated bundle artifacts are removed', () => {
  const removed = ['api', 'server.js', 'payment.html', 'payment.js', 'options.html', 'options.js', 'scripts', 'dist',
    'ALIPAY_PAYMENT_DESIGN.md', 'PAYMENT_TEST_CASES.md', 'docs/csv-purchase-download-design.md',
    'autoComment-plugin-20260609-192235.zip', 'autoComment-plugin-flat-20260614-132249.zip'];
  for (const entry of removed) assert.equal(fs.existsSync(path.join(root, entry)), false, `${entry} should be deleted`);
});

test('package has no runtime dependencies and only OpenRouter host access', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(manifest.host_permissions, ['https://openrouter.ai/*']);
});
