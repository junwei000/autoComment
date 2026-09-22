# OpenRouter Local Batch Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert AutoComment into a self-contained open-source Chrome extension that uses the user's OpenRouter key and runs only the batch backlink-comment workflow.

**Architecture:** `batch.html`/`batch.js` own settings, CSV input and the serial queue; testable helpers live under `lib/`; `background.js` owns authenticated OpenRouter requests; `content.js` owns page inspection, form filling and refresh-or-10-second submission completion. All private backend and monetization code is removed.

**Tech Stack:** Chrome Manifest V3, vanilla HTML/CSS/JavaScript, OpenRouter Chat Completions API, Node.js built-in test runner.

## Global Constraints

- The extension must not call `jieyunsang.cn` or any private backend.
- OpenRouter API Key and model ID are user configurable; the key is stored only in `chrome.storage.local`.
- The only core UI is the widened batch page.
- CSV input reads only the first column, accepts an optional case-insensitive `url` header, and ignores all other columns.
- The result table keeps its existing columns, except “目标页面” becomes “站点” and displays the URL hostname.
- After comment submission, advance only after page refresh completes or a fixed 10-second post-submit timeout wins.
- Payment, points, user ID, CSV sales/download, remote statistics and backend/database code must be deleted.

---

### Task 1: Pure batch and submission helpers

**Files:**
- Create: `lib/batch-utils.js`
- Create: `lib/submission-waiter.js`
- Create: `tests/batch-utils.test.js`
- Create: `tests/submission-waiter.test.js`

**Interfaces:**
- Produces: `parseUrlCsv(text) -> { items, invalidCount, duplicateCount }`
- Produces: `normalizeUrl(value) -> string | null`
- Produces: `getDisplayDomain(url) -> string`
- Produces: `createSubmissionWaiter({ timeoutMs, addNavigationListener, removeNavigationListener, setTimer, clearTimer }) -> { wait, dispose }`

- [ ] Write Node tests proving optional-header parsing, first-column-only behavior, normalization, de-duplication and domain formatting.
- [ ] Run `node --test tests/batch-utils.test.js` and verify failures because the helper does not exist.
- [ ] Implement the minimal UMD-style helper so it works as `window.AutoCommentBatchUtils` and `module.exports`.
- [ ] Run the batch helper tests and verify they pass.
- [ ] Write submission waiter tests for navigation-first, timeout-first and exactly-once resolution.
- [ ] Run the waiter tests and verify failures because the helper does not exist.
- [ ] Implement the minimal waiter with a one-shot `finish(reason)` path and cleanup.
- [ ] Run both test files and commit the task.

### Task 2: Local settings UI and OpenRouter service

**Files:**
- Create: `lib/openrouter-client.js`
- Create: `tests/openrouter-client.test.js`
- Modify: `background.js`
- Modify: `manifest.json`
- Modify: `batch.html`
- Modify: `batch.js`

**Interfaces:**
- Consumes: `parseUrlCsv`, `getDisplayDomain` from Task 1.
- Produces: `buildOpenRouterRequest({ apiKey, model, messages })` and `parseOpenRouterResponse(response, payload)`.
- Produces message contract: `{ type: 'OPENROUTER_GENERATE', pageContext, siteProfile } -> { ok, text?, error? }`.

- [ ] Write failing tests asserting the exact endpoint, Bearer header, configurable model, messages, and response/error parsing.
- [ ] Run `node --test tests/openrouter-client.test.js` and verify the expected missing-module failure.
- [ ] Implement the client helper and re-run its tests.
- [ ] Rebuild the batch page as a wide layout containing API Key, model ID, site URL, site description, nickname, email, CSV upload, automation settings, progress and the unchanged result columns with “站点”.
- [ ] Persist all settings in local storage, validate required fields, parse only the first CSV column and render domains.
- [ ] Make the extension action and options entry open `batch.html`; add only the OpenRouter host permission required by the new service.
- [ ] Route generation messages through the background service and verify key material is never returned to content scripts.
- [ ] Run the three focused test files and commit the task.

### Task 3: Content workflow and refresh-or-timeout completion

**Files:**
- Modify: `content.js`
- Modify: `batch.js`
- Modify: `background.js`
- Test: `tests/submission-waiter.test.js`

**Interfaces:**
- Consumes: `OPENROUTER_GENERATE` from Task 2.
- Consumes: the one-shot semantics from `createSubmissionWaiter`.
- Produces: one `BATCH_RESULT` result per URL; success after restored navigation or 10,000 ms post-submit timeout.

- [ ] Add failing waiter integration cases for persisted pre-submit context and restored-page confirmation data.
- [ ] Run the focused tests and verify the new cases fail.
- [ ] Replace Qwen/backend generation with the OpenRouter background message while preserving current page extraction and prompt behavior.
- [ ] Remove user-ID, points, refunds, remote stats and beacon reporting paths.
- [ ] Persist task context before submit; confirm after reload, or confirm after exactly 10,000 ms when no reload occurs; guard both paths against duplicate completion.
- [ ] Make the batch queue close the confirmed tab and only then open the next URL.
- [ ] Run focused tests and commit the task.

### Task 4: Remove monetization/backend artifacts and document release

**Files:**
- Delete: `api/`
- Delete: `server.js`
- Delete: `payment.html`
- Delete: `payment.js`
- Delete: `options.html`
- Delete: `options.js`
- Delete: `scripts/`
- Delete: `tests/payment.test.js`
- Delete: `ALIPAY_PAYMENT_DESIGN.md`
- Delete: `PAYMENT_TEST_CASES.md`
- Delete: `docs/csv-purchase-download-design.md`
- Delete: `autoComment-plugin-20260609-192235.zip`
- Delete: `autoComment-plugin-flat-20260614-132249.zip`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `README.md`
- Create: `tests/repository-clean.test.js`

**Interfaces:**
- Produces: a backend-free package whose only runtime dependency is Chrome and OpenRouter.

- [ ] Write a failing repository-clean test that scans runtime files for the private domain and deleted payment/points/CSV-sale routes.
- [ ] Run it and verify it fails on the legacy files.
- [ ] Delete all backend, payment, sale, generated ZIP and obsolete options artifacts.
- [ ] Reduce package metadata to a private, dependency-free test package and regenerate the lock file without network dependencies.
- [ ] Document installation, local-only settings, CSV format, OpenRouter setup, model configuration, execution behavior and security limitations.
- [ ] Run `npm test`, JSON-parse the manifest, syntax-check all runtime JavaScript files, and commit the task.
