// 批量外链评论自动化 - 扩展端核心逻辑（本地批次管理）

// ==================== 配置 ====================
const { parseUrlLines, MAX_URL_LINES, normalizeUrl, getDisplayDomain, createTabTimer, setTabPhase, evaluateTabTimeout, getPhaseLabel } = window.AutoCommentBatchUtils;
const POLL_INTERVAL = 3000;
const TIMEOUT_CHECK_INTERVAL = 5000;
const TIMEOUT_STORAGE_KEY = 'batch_timeout_seconds';

// ==================== 状态 ====================
let batchId = null;
let parsedUrls = [];                // [{originalIndex, url}]
let status = 'idle';                // idle | running | completed
let activeTabCount = 0;
let currentIndex = 0;               // 当前处理到的索引（本地管理）

// 实时计数
let totalCount = 0;
let successCount = 0;
let failCount = 0;
let skippedCount = 0;
let noCommentBoxCount = 0;
let manualRequiredCount = 0;
let blockedIllegalCount = 0;
let pendingCount = 0;

// 本地结果存储
let localResults = [];              // [{originalIndex, url, result, aiContent, errorMessage, timestamp}]

// 轮询定时器
let pollTimer = null;

// 活跃标签页记录 { tabId -> { urlIndex, ...createTabTimer() } }（按阶段计时）
let activeTabs = new Map();
let activeTabsByIndex = new Map();  // urlIndex -> { urlIndex, startTime }

// 定时器
let timeoutCheckTimer = null;
let timeoutSeconds = 60;

// 标签打开锁（防止并发）
let isOpeningTab = false;

// 等待确认的标签页: tabId -> { urlIndex }
let tabsPendingConfirm = new Map();
// 需要收到 BATCH_CONFIRMED 才关闭的标签页
let tabsWaitingClose = new Set();
// 已跳过（已存在评论）的 urlIndex 记录
let skippedIndices = new Set();

// ==================== DOM 引用 ====================
const urlInput = document.getElementById('urlInput');
const urlLineCounter = document.getElementById('urlLineCounter');
const loadUrlsBtn = document.getElementById('loadUrlsBtn');
const urlSummary = document.getElementById('urlSummary');
const urlPreview = document.getElementById('urlPreview');
const urlPreviewBody = document.getElementById('urlPreviewBody');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const successCountEl = document.getElementById('successCount');
const failCountEl = document.getElementById('failCount');
const skippedCountEl = document.getElementById('skippedCount');
const noCommentBoxCountEl = document.getElementById('statsNoCommentBox');
const manualRequiredCountEl = document.getElementById('manualRequiredCount');
const pendingCountEl = document.getElementById('pendingCount');
const progressText = document.getElementById('progressText');
const footerActions = document.getElementById('footerActions');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const settingsFields = Object.fromEntries(['apiKey', 'modelId', 'website', 'description', 'nickname', 'email'].map(id => [id, document.getElementById(id)]));
const settingsStatus = document.getElementById('settingsStatus');
const testConnectionBtn = document.getElementById('testConnectionBtn');
const testConnectionStatus = document.getElementById('testConnectionStatus');
const statusBadge = document.getElementById('statusBadge');
const timeoutInput = document.getElementById('timeoutInput');
const statsPanel = document.getElementById('statsPanel');
const statsTotal = document.getElementById('statsTotal');
const statsSuccess = document.getElementById('statsSuccess');
const statsSkipped = document.getElementById('statsSkipped');
const statsManualRequired = document.getElementById('statsManualRequired');
const statsNoCommentBox = document.getElementById('statsNoCommentBox');
const statsFail = document.getElementById('statsFail');
const statsRate = document.getElementById('statsRate');
const filterResult = document.getElementById('filterResult');
const filterDomain = document.getElementById('filterDomain');
const filterTimeRange = document.getElementById('filterTimeRange');
const filterKeyword = document.getElementById('filterKeyword');
const statsTableBody = document.getElementById('statsTableBody');
const statsTableWrap = document.getElementById('statsTableWrap');
const statsCountLabel = document.getElementById('statsCountLabel');

// 批量任务设置勾选框
const batchAutoOpenPanel = document.getElementById('batchAutoOpenPanel');
const batchAutoGenerate = document.getElementById('batchAutoGenerate');
const batchAutoSubmit = document.getElementById('batchAutoSubmit');

// ==================== 批量任务设置存储键 ====================
const BATCH_SETTINGS_KEY = 'batch_task_settings';
const BATCH_URLS_KEY = 'batch_task_urls';
const BATCH_DOMAIN_BLACKLIST = ['nsfw-ai.net'];

// 全局勾选框设置的本地存储键
const BATCH_CHECKBOX_SETTINGS_KEY = 'batch_checkbox_settings';

// 加载全局勾选框设置
async function loadBatchCheckboxSettings() {
  const data = await chrome.storage.local.get([BATCH_CHECKBOX_SETTINGS_KEY]);
  const saved = data[BATCH_CHECKBOX_SETTINGS_KEY] || {};
  batchAutoOpenPanel.checked = saved.autoOpenPanel !== false;
  batchAutoGenerate.checked = saved.autoGenerate !== false;
  batchAutoSubmit.checked = !!saved.autoSubmit;
}

// 保存全局勾选框设置
async function saveBatchCheckboxSettings() {
  return new Promise((resolve) => {
    const settings = {
      autoOpenPanel: batchAutoOpenPanel.checked,
      autoGenerate: batchAutoGenerate.checked,
      autoSubmit: batchAutoSubmit.checked
    };
    chrome.storage.local.set({
      [BATCH_CHECKBOX_SETTINGS_KEY]: settings
    }, () => {
      console.log('[batch] 全局勾选框设置已保存:', settings);
      resolve();
    });
  });
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadLocalSettings();
  await loadTimeoutSetting();
  await loadBatchCheckboxSettings(); // 全局记忆的勾选框设置
  bindEvents();

  updateUI();
  updateUrlLineCounter();
  await restoreBatchSnapshot();
}

async function loadLocalSettings() {
  const saved = await chrome.storage.local.get(['openrouter_api_key', 'openrouter_model', 'site_profile']);
  settingsFields.apiKey.value = saved.openrouter_api_key || '';
  settingsFields.modelId.value = saved.openrouter_model || '';
  for (const id of ['website', 'description', 'nickname', 'email']) settingsFields[id].value = saved.site_profile?.[id] || '';
}

async function saveLocalSettings() {
  const siteProfile = Object.fromEntries(['website', 'description', 'nickname', 'email'].map(id => [id, settingsFields[id].value.trim()]));
  await chrome.storage.local.set({
    openrouter_api_key: settingsFields.apiKey.value.trim(),
    openrouter_model: settingsFields.modelId.value.trim(),
    site_profile: siteProfile
  });
  settingsStatus.textContent = '设置已保存在此浏览器';
}

function validateSettings() {
  for (const field of Object.values(settingsFields)) {
    if (!field.value.trim() || !field.reportValidity()) {
      field.focus();
      settingsStatus.textContent = '请填写所有必填配置，并检查格式';
      return false;
    }
  }
  if (!normalizeUrl(settingsFields.website.value)) {
    settingsFields.website.focus();
    settingsStatus.textContent = '网站 URL 必须是有效的 HTTP 或 HTTPS 地址';
    return false;
  }
  settingsFields.website.value = normalizeUrl(settingsFields.website.value);
  return true;
}

// 用当前填写的 Key 与模型发一条测试消息，确认 OpenRouter 能跑通
async function testOpenRouterConnection() {
  for (const id of ['apiKey', 'modelId']) {
    if (!settingsFields[id].value.trim()) {
      settingsFields[id].focus();
      testConnectionStatus.textContent = '请先填写 API Key 和模型 ID';
      testConnectionStatus.dataset.state = 'error';
      return;
    }
  }
  testConnectionBtn.disabled = true;
  testConnectionStatus.textContent = '正在发送测试消息…';
  testConnectionStatus.dataset.state = 'pending';
  try {
    await saveLocalSettings();
    const reply = await chrome.runtime.sendMessage({ type: 'OPENROUTER_TEST' });
    if (reply && reply.ok) {
      const seconds = (reply.elapsedMs / 1000).toFixed(1);
      testConnectionStatus.textContent = `连接成功 · ${reply.model} · ${seconds}s · 回复：${reply.text.slice(0, 80)}`;
      testConnectionStatus.dataset.state = 'ok';
    } else {
      testConnectionStatus.textContent = `连接失败：${(reply && reply.error) || '后台无响应'}`;
      testConnectionStatus.dataset.state = 'error';
    }
  } catch (_) {
    testConnectionStatus.textContent = '连接失败：无法联系插件后台，请重新加载插件';
    testConnectionStatus.dataset.state = 'error';
  } finally {
    testConnectionBtn.disabled = false;
  }
}

async function loadTimeoutSetting() {
  return new Promise((resolve) => {
    chrome.storage.local.get([TIMEOUT_STORAGE_KEY], (data) => {
      const saved = parseInt(data[TIMEOUT_STORAGE_KEY], 10);
      timeoutSeconds = (saved && saved >= 10 && saved <= 600) ? saved : 60;
      timeoutInput.value = String(timeoutSeconds);
      resolve();
    });
  });
}

// ==================== 事件绑定 ====================
function saveTimeoutSetting() {
  const val = parseInt(timeoutInput.value, 10);
  if (val >= 10 && val <= 600) {
    timeoutSeconds = val;
    chrome.storage.local.set({ [TIMEOUT_STORAGE_KEY]: val });
  } else {
    timeoutInput.value = String(timeoutSeconds);
  }
}

// ==================== 事件绑定 ====================
function bindEvents() {
  for (const field of Object.values(settingsFields)) field.addEventListener('change', saveLocalSettings);
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    if (validateSettings()) await saveLocalSettings();
  });
  testConnectionBtn.addEventListener('click', testOpenRouterConnection);
  // URL 输入框
  urlInput.addEventListener('input', updateUrlLineCounter);
  loadUrlsBtn.addEventListener('click', loadUrlInput);

  // 操作按钮
  startBtn.addEventListener('click', () => {
    if (status === 'terminated') {
      resumeBatch();
    } else {
      startBatch();
    }
  });
  stopBtn.addEventListener('click', stopBatch);
  exportBtn.addEventListener('click', exportResults);
  clearBtn.addEventListener('click', clearBatch);

  // 设置
  timeoutInput.addEventListener('change', saveTimeoutSetting);

  // 勾选框设置（全局记忆）
  batchAutoOpenPanel.addEventListener('change', saveBatchCheckboxSettings);
  batchAutoGenerate.addEventListener('change', saveBatchCheckboxSettings);
  batchAutoSubmit.addEventListener('change', saveBatchCheckboxSettings);

  // 监听 background 消息（结果回调）
  chrome.runtime.onMessage.addListener((message) => {
    // background 通知：结果已落盘，标签页可以安全关闭了
    if (message.type === 'BATCH_CONFIRMED') {
      console.log('[batch] 收到 BATCH_CONFIRMED >>>', { urlIndex: message.urlIndex, result: message.result, aiContentLen: message.aiContent ? message.aiContent.length : 0, tabsPendingConfirm: [...tabsPendingConfirm.entries()], tabsWaitingClose: [...tabsWaitingClose], time: new Date().toISOString() });
      handleTabConfirmed(message.urlIndex, message.result, message.aiContent, message.errorMessage);
    } else if (message.type === 'BATCH_PHASE') {
      handleBatchPhase(message);
    }
  });

  // 统计筛选器
  filterResult.addEventListener('change', renderStats);
  filterDomain.addEventListener('change', renderStats);
  filterTimeRange.addEventListener('change', renderStats);
  filterKeyword.addEventListener('input', debounce(renderStats, 300));
}

// ==================== URL 输入 ====================
function evaluateIllegalSiteForBatchItem(url, sourceDomain) {
  const filter = window.AutoCommentIllegalSiteFilter;
  if (!filter || typeof filter.evaluateUrl !== 'function') {
    console.warn('[batch] 非法网站过滤器未加载，跳过 URL 预检测');
    return { blocked: false };
  }
  return filter.evaluateUrl(url, { sourceDomain });
}

function getIllegalSiteBlockMessage(check) {
  if (!check || !check.blocked) return '';
  return check.reason || '非法网站拦截：命中赌博/色情规则';
}

function countUrlLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

function updateUrlLineCounter() {
  const count = countUrlLines(urlInput.value);
  urlLineCounter.textContent = `${count} / ${MAX_URL_LINES} 行`;
  urlLineCounter.dataset.state = count > MAX_URL_LINES ? 'error' : '';
}

function showUrlSummary(text, state) {
  urlSummary.textContent = text;
  urlSummary.dataset.state = state || '';
}

function describeLines(lineNumbers) {
  const shown = lineNumbers.slice(0, 10).join('、');
  return lineNumbers.length > 10 ? `${shown} 等 ${lineNumbers.length} 行` : shown;
}

// 把输入框里的链接加载为新的待处理列表（会清空上一批的任务记录）
function loadUrlInput() {
  if (status === 'running') return;
  const { items, lineCount, invalidLines, duplicateCount, tooMany } = parseUrlLines(urlInput.value);
  if (lineCount === 0) {
    showUrlSummary('请输入要处理的 URL，每行一个', 'error');
    return;
  }
  if (tooMany) {
    showUrlSummary(`最多 ${MAX_URL_LINES} 行，当前 ${lineCount} 行，请删减后再加载`, 'error');
    return;
  }
  if (items.length === 0) {
    showUrlSummary(`没有有效链接：第 ${describeLines(invalidLines)} 行不是以 http:// 或 https:// 开头的完整链接`, 'error');
    return;
  }

  let illegalCount = 0;
  let blacklistedCount = 0;
  parsedUrls = [];
  previewRows = new Map();
  urlPreviewBody.innerHTML = '';

  for (const url of items) {
    const sourceDomain = getDisplayDomain(url);
    if (isBatchDomainBlacklisted(url, sourceDomain)) {
      blacklistedCount++;
      continue;
    }
    const illegalCheck = evaluateIllegalSiteForBatchItem(url, sourceDomain);
    if (illegalCheck.blocked) illegalCount++;
    parsedUrls.push({
      originalIndex: parsedUrls.length,
      url,
      sourceDomain,
      illegalCheck: illegalCheck.blocked ? illegalCheck : null,
      originalRow: [url]
    });
    urlPreviewBody.appendChild(createPreviewRow(parsedUrls.length - 1, url, illegalCheck));
  }

  const notes = [];
  if (duplicateCount) notes.push(`去重 ${duplicateCount} 条`);
  if (invalidLines.length) notes.push(`跳过第 ${describeLines(invalidLines)} 行（不是完整链接）`);
  if (illegalCount) notes.push(`非法拦截 ${illegalCount} 条`);
  if (blacklistedCount) notes.push(`跳过 ${blacklistedCount} 条黑名单域名`);
  showUrlSummary(`已加载，共 ${parsedUrls.length} 条${notes.length ? `；${notes.join('，')}` : ''}`, invalidLines.length ? 'warn' : 'ok');
  urlPreview.classList.add('visible');
  resetBatchState();
}

function resetUrlList() {
  if (status === 'running') return;
  urlPreview.classList.remove('visible');
  urlPreviewBody.innerHTML = '';
  parsedUrls = [];
  previewRows = new Map();
  startBtn.disabled = true;
  showUrlSummary('', '');
}

// ==================== 批量处理核心 ====================
async function startBatch() {
  if (!validateSettings()) return;
  if (parsedUrls.length === 0) {
    showUrlSummary('请先输入 URL 并点击「加载到待处理列表」', 'error');
    urlInput.focus();
    return;
  }

  await saveLocalSettings();
  await new Promise((resolve) => {
    chrome.storage.local.remove(['batchCtx', 'batchSubmitCtx'], resolve);
  });

  // 保存批量任务设置和 URL 列表到 storage.local，供 content.js 读取
  await saveBatchTaskSettings();

  batchId = generateUUID();
  totalCount = parsedUrls.length;
  successCount = 0;
  failCount = 0;
  skippedCount = 0;
  noCommentBoxCount = 0;
  manualRequiredCount = 0;
  blockedIllegalCount = 0;
  pendingCount = totalCount;
  currentIndex = 0;
  localResults = [];
  status = 'running';

  setStatus('running');
  updateUI();
  updateStatsUI();

  // 打开第一个标签页
  openNextTabSync();
}

// 保存批量任务设置到 storage.local
async function saveBatchTaskSettings() {
  return new Promise((resolve) => {
    const settings = {
      autoOpenPanel: batchAutoOpenPanel.checked,
      autoGenerate: batchAutoGenerate.checked,
      autoSubmit: batchAutoSubmit.checked,
      savedAt: Date.now()
    };
    const urls = parsedUrls.map(item => item.url);

    chrome.storage.local.set({
      [BATCH_SETTINGS_KEY]: settings,
      [BATCH_URLS_KEY]: urls
    }, () => {
      console.log('[batch] 批量任务设置已保存:', settings, 'URL 数量:', urls.length);
      resolve();
    });
  });
}

// 清除批量任务设置
async function clearBatchTaskSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([BATCH_SETTINGS_KEY, BATCH_URLS_KEY], () => {
      console.log('[batch] 批量任务设置已清除');
      resolve();
    });
  });
}

// 终止标志：stopBatch 后保持 results 但不再处理
let isTerminated = false;

async function stopBatch() {
  // 停止继续打开新标签页
  isTerminated = true;
  setStatus('terminated');

  // 标记所有待处理的为未处理（可用于恢复）
  const terminatedCount = pendingCount;

  // 清空轮询和超时检查
  if (pollTimer) clearTimeout(pollTimer);
  stopTimeoutChecker();

  // 先把正在处理的标签页记为已终止，避免关闭回调把它当作待恢复项卡住。
  const activeEntries = Array.from(activeTabs.entries());
  for (const [tabId, info] of activeEntries) {
    if (!localResults.some((r) => r.originalIndex === info.urlIndex)) {
      const elapsed = Math.round((Date.now() - info.startTime) / 1000);
      handleTabResult(info.urlIndex, 'fail', null, '手动终止', elapsed, { suppressCompletion: true });
    }
  }

  // 关闭所有打开的标签页
  const tabIds = activeEntries.map(([tabId]) => tabId);
  activeTabs.clear();
  activeTabsByIndex.clear();
  tabsPendingConfirm.clear();
  tabsWaitingClose.clear();
  for (const tabId of tabIds) {
    try {
      await new Promise((resolve) => {
        chrome.tabs.remove(tabId, () => resolve());
      });
    } catch (_) {}
  }
  activeTabCount = 0;

  // 状态设为 terminated，用于显示保留的结果
  updateStatsUI();
  updateUI();

  // 显示终止提示
  console.log(`[batch] 已手动终止。共保留 ${localResults.length} 条结果（成功 ${successCount}，失败 ${failCount}），跳过 ${terminatedCount} 条未处理`);
}

// 恢复处理（从终止状态继续）
async function resumeBatch() {
  if (!validateSettings()) return;
  await saveLocalSettings();
  await saveBatchTaskSettings();
  console.log('[resumeBatch] 开始恢复处理', { status, currentIndex, totalCount, successCount, failCount });

  if (status !== 'terminated') {
    console.log('[resumeBatch] 状态不是 terminated，不执行');
    return;
  }

  // 重置终止状态
  isTerminated = false;
  isOpeningTab = false;  // 重置锁，确保可以继续打开

  // 重置待处理计数（仅统计还未处理的）
  const processedCount = getProcessedCount();
  pendingCount = totalCount - processedCount;
  const processedIndices = new Set(localResults.map((r) => r.originalIndex));
  let nextIndex = currentIndex;
  while (nextIndex < totalCount && processedIndices.has(nextIndex)) {
    nextIndex++;
  }
  if (nextIndex >= totalCount) {
    const fallbackIndex = parsedUrls.findIndex((_, idx) => !processedIndices.has(idx));
    nextIndex = fallbackIndex === -1 ? totalCount : fallbackIndex;
  }
  currentIndex = nextIndex;

  console.log('[resumeBatch] 将要处理的 URL 索引范围:', currentIndex, '-', totalCount - 1);

  setStatus('running');
  updateUI();

  // 从断点继续打开标签页（固定为1）
  console.log('[resumeBatch] 将打开 1 个标签页');

  openNextTabSync();
}

// 立即打开下一个标签页（从本地队列获取）
async function openNextTabSync() {
  console.log('[openNextTabSync] 调用', { isOpeningTab, status, isTerminated, currentIndex, totalCount });
  if (isOpeningTab) {
    console.log('[openNextTabSync] 跳过 - 正在打开中');
    return;
  }
  isOpeningTab = true;
  await openNextTab();
  isOpeningTab = false;
}

async function openNextTab() {
  console.log('[openNextTab] 检查条件', { status, isTerminated, activeTabCount, currentIndex, totalCount });

  if (status !== 'running') {
    console.log('[openNextTab] 跳过 - 状态不是 running');
    return;
  }
  if (isTerminated) {
    console.log('[openNextTab] 跳过 - 已终止');
    return;
  }
  if (activeTabCount >= 1) {
    console.log('[openNextTab] 跳过 - 已有标签页在处理中');
    return;
  }
  if (currentIndex >= totalCount) {
    console.log('[openNextTab] 跳过 - 索引超出范围');
    return;
  }

  const urlIndex = currentIndex;
  const item = parsedUrls[urlIndex];
  const { url, sourceDomain } = item;
  console.log('[openNextTab] 准备打开标签页', { urlIndex, url });
  currentIndex++;

  const illegalCheck = item.illegalCheck || evaluateIllegalSiteForBatchItem(url, sourceDomain);
  if (illegalCheck.blocked) {
    console.warn('[batch] 命中非法网站规则，跳过打开标签页:', { urlIndex, url, illegalCheck });
    item.illegalCheck = illegalCheck;
    handleTabResult(urlIndex, 'blocked_illegal', null, getIllegalSiteBlockMessage(illegalCheck), 0);
    if (status === 'running' && currentIndex < totalCount) {
      setTimeout(openNextTabSync, 0);
    } else if (status === 'running' && activeTabCount === 0) {
      checkAllCompleted();
    }
    return;
  }

  try {
    chrome.tabs.create({ url, active: true }, (tab) => {
      activeTabCount++;
      activeTabs.set(tab.id, { urlIndex, ...createTabTimer(Date.now()) });
      activeTabsByIndex.set(urlIndex, { urlIndex, startTime: Date.now() });

      // 高亮预览表格中对应的行
      highlightPreviewRow(urlIndex, 'processing');

      startTimeoutChecker();
      updateStatsUI();

      // 监听标签页关闭
      const listener = (tabId, removeInfo) => {
        if (tabId === tab.id) {
          // 取 startTime（必须在删除前获取）
          const startTime = activeTabs.get(tab.id)?.startTime;
          activeTabs.delete(tab.id);
          activeTabsByIndex.delete(urlIndex);
          activeTabCount = Math.max(0, activeTabCount - 1);
          chrome.tabs.onRemoved.removeListener(listener);

          console.log('[batch] 标签页关闭:', { tabId, urlIndex, activeTabCount, status });

          // 检查是否已有结果（content.js 主动上报或超时处理过了），没有则记为手动关闭失败
          if (!localResults.some((r) => r.originalIndex === urlIndex)) {
            console.log('[batch] 标签关闭但无结果，记为失败:', urlIndex);
            const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : null;
            handleTabResult(urlIndex, 'fail', null, '用户手动关闭', elapsed);
          } else {
            console.log('[batch] 标签关闭已有结果:', urlIndex);
          }

          updateStatsUI();

          // 标签关闭后补充新标签
          if (status === 'running' && currentIndex < totalCount) {
            openNextTabSync();
          } else if (status === 'running' && activeTabCount === 0) {
            // 所有标签页都已关闭，检查是否全部完成
            const processedCount = getProcessedCount();
            console.log('[batch] 所有标签关闭，检查完成状态:', { processedCount, totalCount, activeTabCount });
            checkAllCompleted();
          }
        }
      };
      chrome.tabs.onRemoved.addListener(listener);

      // 等待 content script 就绪后再发送任务
      function sendWhenReady(tabId, retries = 0) {
        if (status !== 'running' || isTerminated || !activeTabs.has(tabId)) {
          console.log('[batch] sendWhenReady 停止重试：任务已停止或标签页不再活跃', { tabId, status, isTerminated });
          return;
        }
        if (retries > 20) {
          console.warn('[batch] content.js 就绪超时，放弃发送, tabId:', tabId);
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: 'PING' }).then(() => {
          // content.js 已就绪，发送正式任务
          console.log('[batch] content.js 已就绪，发送 BATCH_HANDLE → tabId:', tab.id, { batchId, urlIndex, url, time: new Date().toISOString() });
          chrome.tabs.sendMessage(tab.id, {
            type: 'BATCH_HANDLE',
            batchId,
            urlIndex,
            url
          }).then((response) => {
            console.log('[batch] 收到 content.js 响应:', response, 'tabId:', tab.id, 'tabsPendingConfirm:', [...tabsPendingConfirm.keys()], 'time:', new Date().toISOString());
            if (response && response.ok) {
              if (localResults.some((r) => r.originalIndex === urlIndex) || !activeTabs.has(tab.id)) {
                console.log('[batch] 结果已确认或标签已关闭，不再登记 tabsPendingConfirm:', { tabId: tab.id, urlIndex });
                return;
              }
              console.log('[batch] 记录 tabId', tab.id, '到 tabsPendingConfirm, 等待 BATCH_CONFIRMED...');
              tabsPendingConfirm.set(tab.id, { urlIndex });
              tabsWaitingClose.add(tab.id);
            } else {
              console.warn('[batch] content.js 响应 ok=false 或无响应:', response);
            }
          }).catch((err) => {
            console.warn('[batch] sendMessage BATCH_HANDLE 发送失败:', err.message || err, 'tabId:', tab.id);
            if (isPortClosedAfterNavigation(err)) {
              // 提交后页面刷新会断开响应通道：由刷新后的页面补发确认，或由单页超时兜底
              if (!localResults.some((r) => r.originalIndex === urlIndex) && activeTabs.has(tab.id)) {
                tabsPendingConfirm.set(tab.id, { urlIndex });
                tabsWaitingClose.add(tab.id);
              }
              return;
            }
            // 发送失败时，如果尚未记录结果，则记为失败
            if (!localResults.some((r) => r.originalIndex === urlIndex)) {
              console.log('[batch] sendMessage 失败但无结果记录，记为失败');
              handleTabResult(urlIndex, 'fail', null, '消息发送失败：' + (err.message || '标签页可能已关闭'));
            }
          });
        }).catch(() => {
          // content.js 还没注入，500ms 后重试
          setTimeout(() => sendWhenReady(tabId, retries + 1), 500);
        });
      }
      sendWhenReady(tab.id);
    });
  } catch (e) {
    console.error('[batch] openNextTab 错误:', e);
    // 出错时继续下一个
    if (currentIndex < totalCount) {
      setTimeout(openNextTabSync, 1000);
    }
  }
}

function isPortClosedAfterNavigation(err) {
  const message = String((err && err.message) || err || '');
  return /message port closed|message channel closed|back\/forward cache/i.test(message);
}

// 按结果类型累计计数并标记列表行（新结果与恢复快照共用）
function countResult(urlIndex, result) {
  if (result === 'success') successCount++;
  else if (result === 'skipped') { skippedCount++; skippedIndices.add(urlIndex); }
  else if (result === 'no_comment_box') noCommentBoxCount++;
  else if (result === 'manual_required') manualRequiredCount++;
  else if (result === 'blocked_illegal') blockedIllegalCount++;
  else failCount++;
  highlightPreviewRow(urlIndex, ['success', 'skipped', 'no_comment_box', 'manual_required', 'blocked_illegal'].includes(result) ? result : 'fail');
}

// 处理标签页结果
// elapsed 可选，外部已知的耗时直接传入（如手动关闭时），否则从 activeTabsByIndex 计算
function handleTabResult(urlIndex, result, aiContent, errorMessage, forcedElapsed, options = {}) {
  console.log('[batch] handleTabResult 被调用:', { urlIndex, result, aiContentLen: aiContent ? aiContent.length : 0, errorMessage });
  const item = parsedUrls[urlIndex];
  if (!item) {
    console.log('[batch] handleTabResult: item 不存在, urlIndex=', urlIndex);
    return;
  }

  // 避免重复处理
  if (localResults.some((r) => r.originalIndex === urlIndex)) {
    console.log('[batch] handleTabResult: 重复调用, urlIndex=', urlIndex);
    return;
  }

  let elapsed = forcedElapsed !== undefined ? forcedElapsed : null;
  if (elapsed === null) {
    const tabInfo = activeTabsByIndex.get(urlIndex);
    elapsed = tabInfo ? Math.round((Date.now() - tabInfo.startTime) / 1000) : null;
  }

  const resultEntry = {
    originalIndex: urlIndex,
    url: item.url,
    sourceDomain: item.sourceDomain || '',
    result: result,
    aiContent: aiContent || null,
    errorMessage: errorMessage || null,
    timestamp: Date.now(),
    elapsed,
    originalRow: item.originalRow || null  // 保存原始行数据用于导出
  };

  localResults.push(resultEntry);

  countResult(urlIndex, result);

  pendingCount = totalCount - getProcessedCount();
  updateStatsUI();
  renderStats();

  saveBatchSnapshot();

  // 检查是否全部完成（成功 + 失败 + 已跳过 + 无评论框 >= 总数）
  const processedCount = getProcessedCount();
  console.log('[batch] handleTabResult 完成检查:', {
    urlIndex,
    result,
    successCount,
    failCount,
    skippedCount,
    manualRequiredCount,
    blockedIllegalCount,
    processedCount,
    totalCount,
    shouldComplete: processedCount >= totalCount
  });
  checkAllCompleted(options);
}

// background 通知：结果已落盘，可以安全关闭标签页了
function handleTabConfirmed(urlIndex, result, aiContent, errorMessage) {
  console.log('[batch] handleTabConfirmed >>>', { urlIndex, result, aiContentLen: aiContent ? aiContent.length : 0, errorMessage, tabsPendingConfirmBefore: [...tabsPendingConfirm.entries()] });

  // 如果已经记录过结果（标签页可能已被 onRemoved 提前关闭清理），跳过 handleTabResult
  if (localResults.some((r) => r.originalIndex === urlIndex)) {
    console.log('[batch] handleTabConfirmed: urlIndex', urlIndex, '已有结果，可能是标签页提前关闭，无需重复处理');
    checkAllCompleted();
  } else {
    // 处理结果（更新 UI、写入 storage）
    handleTabResult(urlIndex, result, aiContent, errorMessage);
  }

  // 查找并关闭标签页（如果还在的话）
  let closedTab = false;
  for (const [tabId, info] of tabsPendingConfirm) {
    if (info.urlIndex === urlIndex) {
      console.log('[batch] 关闭 tabId:', tabId, 'urlIndex:', urlIndex);
      tabsPendingConfirm.delete(tabId);
      tabsWaitingClose.delete(tabId);
      closedTab = true;
      chrome.tabs.remove(tabId, () => {});
      break;
    }
  }

  if (!closedTab) {
    for (const [tabId, info] of activeTabs) {
      if (info.urlIndex === urlIndex) {
        console.log('[batch] tabsPendingConfirm 未登记，按 activeTabs 关闭 tabId:', tabId, 'urlIndex:', urlIndex);
        chrome.tabs.remove(tabId, () => {});
        break;
      }
    }
  }

  // 找不到对应的 tabId 说明已经关闭了（用户手动关或超时自动关），无需处理
  console.log('[batch] handleTabConfirmed <<<');
}

function getProcessedCount() {
  return successCount + failCount + skippedCount + noCommentBoxCount + manualRequiredCount + blockedIllegalCount;
}

function checkAllCompleted(options = {}) {
  const processedCount = getProcessedCount();
  const shouldComplete = !options.suppressCompletion &&
    status === 'running' &&
    totalCount > 0 &&
    processedCount >= totalCount;

  console.log('[batch] checkAllCompleted:', {
    processedCount,
    totalCount,
    activeTabCount,
    status,
    shouldComplete
  });

  if (shouldComplete) {
    onAllCompleted();
  }
}

// ==================== 本地任务快照 ====================
// 输入的 URL、待处理列表、批次状态和全部结果保存在本机，重新打开批量页时恢复；加载新 URL 时清空
const BATCH_SNAPSHOT_KEY = 'batch_state_snapshot';

function saveBatchSnapshot() {
  if (parsedUrls.length === 0) return;
  chrome.storage.local.set({
    [BATCH_SNAPSHOT_KEY]: {
      version: 1,
      inputText: urlInput.value,
      summaryText: urlSummary.textContent,
      summaryState: urlSummary.dataset.state || '',
      urls: parsedUrls.map((item) => ({ url: item.url, illegalCheck: item.illegalCheck || null })),
      batchId,
      status,
      totalCount,
      results: localResults,
      savedAt: Date.now()
    }
  });
}

async function restoreBatchSnapshot() {
  const data = await chrome.storage.local.get([BATCH_SNAPSHOT_KEY, 'batchResults']);
  const snapshot = data[BATCH_SNAPSHOT_KEY];
  if (!snapshot || !Array.isArray(snapshot.urls) || snapshot.urls.length === 0) return;

  parsedUrls = [];
  previewRows = new Map();
  urlPreviewBody.innerHTML = '';
  snapshot.urls.forEach(({ url, illegalCheck }, index) => {
    parsedUrls.push({ originalIndex: index, url, sourceDomain: getDisplayDomain(url), illegalCheck: illegalCheck || null, originalRow: [url] });
    urlPreviewBody.appendChild(createPreviewRow(index, url, { blocked: !!illegalCheck, ...(illegalCheck || {}) }));
  });
  urlPreview.classList.add('visible');
  urlInput.value = typeof snapshot.inputText === 'string' ? snapshot.inputText : parsedUrls.map((item) => item.url).join('\n');
  updateUrlLineCounter();
  showUrlSummary(snapshot.summaryText || `已加载，共 ${parsedUrls.length} 条`, snapshot.summaryState);

  batchId = snapshot.batchId || null;
  totalCount = snapshot.totalCount || 0;
  localResults = Array.isArray(snapshot.results) ? snapshot.results : [];

  // 批量页关闭期间由刷新后的页面确认、只落在 background 记录里的结果
  const known = new Set(localResults.map((r) => r.originalIndex));
  for (const r of Array.isArray(data.batchResults) ? data.batchResults : []) {
    if (!batchId || r.batchId !== batchId || known.has(r.urlIndex) || !parsedUrls[r.urlIndex]) continue;
    known.add(r.urlIndex);
    localResults.push({
      originalIndex: r.urlIndex, url: parsedUrls[r.urlIndex].url, sourceDomain: parsedUrls[r.urlIndex].sourceDomain,
      result: r.result, aiContent: r.aiContent || null, errorMessage: r.errorMessage || null,
      timestamp: r.timestamp || Date.now(), elapsed: null, originalRow: [parsedUrls[r.urlIndex].url]
    });
  }

  successCount = failCount = skippedCount = noCommentBoxCount = manualRequiredCount = blockedIllegalCount = 0;
  skippedIndices.clear();
  for (const r of localResults) countResult(r.originalIndex, r.result);
  pendingCount = Math.max(0, totalCount - getProcessedCount());

  // 关闭页面时仍在运行的批次：标签页已失控，恢复为「已终止」，可点「重新开始」续跑
  let restoredStatus = snapshot.status || 'idle';
  if (restoredStatus === 'running') restoredStatus = 'terminated';
  if (restoredStatus === 'terminated' && totalCount > 0 && getProcessedCount() >= totalCount) restoredStatus = 'completed';
  isTerminated = restoredStatus === 'terminated' || restoredStatus === 'completed';
  setStatus(restoredStatus);
  updateStatsUI();
  updateUI();
}

// 全部完成
async function onAllCompleted() {
  console.log('[batch] onAllCompleted 被调用!');
  isTerminated = true;  // 防止继续打开新标签页
  setStatus('completed');
  stopTimeoutChecker();
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // 关闭所有剩余标签页
  const tabIds = Array.from(activeTabs.keys());
  activeTabs.clear();
  activeTabsByIndex.clear();
  activeTabCount = 0;
  for (const tabId of tabIds) {
    try {
      chrome.tabs.remove(tabId, () => {});
    } catch (_) {}
  }

  updateStatsUI();
  updateUI();
}

// 超时检测
function startTimeoutChecker() {
  if (timeoutCheckTimer) return;
  timeoutCheckTimer = setInterval(() => {
    if (status !== 'running') {
      stopTimeoutChecker();
      return;
    }
    checkTimeouts();
  }, TIMEOUT_CHECK_INTERVAL);
}

function stopTimeoutChecker() {
  if (timeoutCheckTimer) {
    clearInterval(timeoutCheckTimer);
    timeoutCheckTimer = null;
  }
}

async function checkTimeouts() {
  if (activeTabs.size === 0) {
    stopTimeoutChecker();
    return;
  }
  const now = Date.now();
  const toRemove = [];
  for (const [tabId, info] of activeTabs) {
    const verdict = evaluateTabTimeout(info, now, timeoutSeconds * 1000);
    if (verdict.timedOut) {
      toRemove.push({ tabId, urlIndex: info.urlIndex, message: verdict.message });
    }
  }
  for (const { tabId, urlIndex, message } of toRemove) {
    activeTabs.delete(tabId);
    activeTabsByIndex.delete(urlIndex);
    handleTabResult(urlIndex, 'fail', null, message);
    try {
      await new Promise((resolve) => {
        chrome.tabs.remove(tabId, () => resolve());
      });
    } catch (_) {}
  }
}

// content.js 上报当前阶段：AI 生成/提交阶段暂停单页计时，并在列表里显示进度
function handleBatchPhase(message) {
  if (!message || message.batchId !== batchId) return;
  for (const info of activeTabs.values()) {
    if (info.urlIndex !== message.urlIndex) continue;
    setTabPhase(info, message.phase, Date.now());
    const label = getPhaseLabel(info.phase);
    const entry = previewRows.get(message.urlIndex);
    if (entry && label) entry.statusCell.textContent = `处理中 · ${label}`;
    return;
  }
}

// ==================== UI 更新 ====================
function setStatus(s) {
  status = s;
  statusBadge.textContent = {
    idle: '空闲',
    running: '运行中',
    completed: '已完成',
    terminated: '已终止'
  }[s] || s;
  statusBadge.className = 'status-badge ' + s;
  saveBatchSnapshot();
}

function updateUI() {
  const isIdle = status === 'idle';
  const isRunning = status === 'running';
  const isCompleted = status === 'completed';
  const isTerminated = status === 'terminated';

  // 开始按钮：空闲时可开始，终止时可重新开始
  startBtn.disabled = isRunning || isCompleted || parsedUrls.length === 0;
  // 终止状态下显示"重新开始"，正常空闲显示"开始批量处理"
  startBtn.textContent = isTerminated ? '▶ 重新开始' : '▶ 开始批量处理';

  stopBtn.disabled = isIdle || isTerminated || isCompleted;
  stopBtn.style.display = (isTerminated || isCompleted) ? 'none' : 'inline-flex';

  exportBtn.disabled = localResults.length === 0;
  clearBtn.disabled = isRunning;
  // 运行中不允许改动待处理列表
  urlInput.disabled = isRunning;
  loadUrlsBtn.disabled = isRunning;

  // 进度、实时日志、底部操作：终止状态保持显示
  progressSection.style.display = (isIdle) ? 'none' : 'block';
  footerActions.style.display = (isIdle) ? 'none' : 'flex';

  // 统计面板：终止状态保持显示（显示已处理的结果）
  if (isIdle) {
    statsPanel.classList.remove('visible');
    statsTableBody.innerHTML = '';
  } else if (localResults.length > 0) {
    statsPanel.classList.add('visible');
    renderStats();
  }

  // 终止状态下可重新开始，将待处理计数恢复
  if (isTerminated) {
    pendingCount = totalCount - getProcessedCount();
    updateStatsUI();
  }
}

function updateStatsUI() {
  const processed = getProcessedCount();
  const percent = totalCount > 0 ? Math.round((processed / totalCount) * 100) : 0;
  progressBar.style.width = percent + '%';
  progressText.textContent = `${processed}/${totalCount} (${percent}%)`;
  successCountEl.textContent = successCount;
  failCountEl.textContent = failCount;
  skippedCountEl.textContent = skippedCount;
  noCommentBoxCountEl.textContent = noCommentBoxCount;
  if (manualRequiredCountEl) manualRequiredCountEl.textContent = manualRequiredCount;
  pendingCountEl.textContent = pendingCount;
}

// ==================== 导出 ====================
function exportResults() {
  if (localResults.length === 0) {
    alert('没有可导出的结果');
    return;
  }

  const header = 'URL,序号,站点,结果,错误信息,AI 生成内容,耗时（秒）,时间';

  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = localResults.map((r) => {
    return [r.url, r.originalIndex + 1, getDisplayDomain(r.url), getResultText(r.result), r.errorMessage, r.aiContent, r.elapsed, new Date(r.timestamp).toISOString()].map(escape).join(',');
  });

  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `batch_result_${batchId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function clearBatch() {
  resetUrlList();
  resetBatchState();
}

// A newly accepted file starts a fresh batch without clearing its URL preview.
function resetBatchState() {
  batchId = null;
  totalCount = successCount = failCount = skippedCount = noCommentBoxCount = manualRequiredCount = blockedIllegalCount = pendingCount = 0;
  currentIndex = 0;
  localResults = [];
  activeTabCount = 0;
  activeTabs.clear();
  activeTabsByIndex.clear();
  tabsPendingConfirm.clear();
  tabsWaitingClose.clear();
  skippedIndices.clear();
  isTerminated = false;
  isOpeningTab = false;
  statsTableBody.innerHTML = '';
  statsTotal.textContent = '0';
  statsSuccess.textContent = '0';
  statsSkipped.textContent = '0';
  if (statsManualRequired) statsManualRequired.textContent = '0';
  statsNoCommentBox.textContent = '0';
  statsFail.textContent = '0';
  statsRate.textContent = '—';
  statsPanel.classList.remove('visible');
  filterDomain.innerHTML = '<option value="all">全部域名</option>';
  filterResult.value = 'all';
  filterTimeRange.value = 'all';
  filterKeyword.value = '';
  const staleKeys = ['batchLocalResults', BATCH_SETTINGS_KEY, BATCH_URLS_KEY, 'batchCtx', 'batchSubmitCtx'];
  // 加载新 URL 时由 setStatus 直接用新列表的快照覆盖；清空批次时删除快照
  if (parsedUrls.length === 0) staleKeys.push(BATCH_SNAPSHOT_KEY);
  chrome.storage.local.remove(staleKeys);
  setStatus('idle');
  updateUI();
}

// ==================== 统计面板 ====================

// 待处理列表的行：urlIndex -> { row, statusCell, baseClass }
let previewRows = new Map();

const PREVIEW_STATE_CLASS = {
  processing: 'url-processing',
  success: 'url-done-success',
  fail: 'url-done-fail',
  no_comment_box: 'url-done-fail',
  skipped: 'url-done-skipped',
  manual_required: 'url-done-skipped',
  blocked_illegal: 'url-done-blocked'
};

function getPreviewStatusText(state) {
  if (!state) return '待处理';
  if (state === 'processing') return '处理中';
  if (state === 'success') return 'success';
  return getResultText(state);
}

function createPreviewRow(urlIndex, url, illegalCheck) {
  const row = document.createElement('tr');
  row.dataset.url = url;
  row.title = illegalCheck.blocked ? `${url}\n${getIllegalSiteBlockMessage(illegalCheck)}` : url;
  const baseClass = illegalCheck.blocked ? 'illegal' : '';
  row.className = baseClass;

  const indexCell = document.createElement('td');
  indexCell.textContent = String(urlIndex + 1);
  const urlCell = document.createElement('td');
  urlCell.className = 'url-full';
  urlCell.textContent = url;
  const statusCell = document.createElement('td');
  statusCell.className = 'url-status';
  statusCell.textContent = getPreviewStatusText(null);
  row.appendChild(indexCell);
  row.appendChild(urlCell);
  row.appendChild(statusCell);

  previewRows.set(urlIndex, { row, statusCell, baseClass });
  return row;
}

function highlightPreviewRow(urlIndex, state) {
  const entry = previewRows.get(urlIndex);
  if (!entry) return;
  const stateClass = PREVIEW_STATE_CLASS[state] || '';
  entry.row.className = [entry.baseClass, stateClass].filter(Boolean).join(' ');
  entry.statusCell.textContent = getPreviewStatusText(state);
}

function buildDomainOptions() {
  const domainMap = new Map();
  for (const r of localResults) {
    const domain = extractDomain(r.url);
    if (domain) domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
  }
  const select = filterDomain;
  // 保留第一项 "全部域名"
  select.innerHTML = '<option value="all">全部域名</option>';
  for (const [domain, count] of [...domainMap.entries()].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = `${domain} (${count})`;
    select.appendChild(opt);
  }
}

function extractDomain(url) {
  return getDisplayDomain(url);
}

function normalizeBatchDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';

  try {
    const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return text.replace(/^www\./i, '').split('/')[0].split(':')[0];
  }
}

function isDomainBlacklisted(domain) {
  const normalized = normalizeBatchDomain(domain);
  if (!normalized) return false;

  return BATCH_DOMAIN_BLACKLIST.some((blockedDomain) => {
    const blocked = normalizeBatchDomain(blockedDomain);
    return normalized === blocked || normalized.endsWith(`.${blocked}`);
  });
}

function isBatchDomainBlacklisted(url, sourceDomain) {
  return isDomainBlacklisted(extractDomain(url)) || isDomainBlacklisted(sourceDomain);
}

function filterTimeBucket(elapsedSecs) {
  const sel = filterTimeRange.value;
  if (sel === 'all') return true;
  if (elapsedSecs == null) return sel === '60+';
  if (sel === '0-5') return elapsedSecs <= 5;
  if (sel === '5-15') return elapsedSecs > 5 && elapsedSecs <= 15;
  if (sel === '15-30') return elapsedSecs > 15 && elapsedSecs <= 30;
  if (sel === '30-60') return elapsedSecs > 30 && elapsedSecs <= 60;
  if (sel === '60+') return elapsedSecs > 60;
  return true;
}

function renderStats() {
  if (localResults.length === 0) {
    statsPanel.classList.remove('visible');
    return;
  }
  statsPanel.classList.add('visible');

  const total = localResults.length;
  const success = localResults.filter((r) => r.result === 'success').length;
  const skipped = localResults.filter((r) => r.result === 'skipped').length;
  const fail = localResults.filter((r) => r.result === 'fail').length;
  const noCommentBox = localResults.filter((r) => r.result === 'no_comment_box').length;
  const manualRequired = localResults.filter((r) => r.result === 'manual_required').length;
  statsTotal.textContent = total;
  statsSuccess.textContent = success;
  statsSkipped.textContent = skipped;
  if (statsManualRequired) statsManualRequired.textContent = manualRequired;
  statsFail.textContent = fail;
  statsNoCommentBox.textContent = noCommentBox;
  // 成功率 = (成功 + 已存在) / 总数
  const validCount = success + skipped;
  const successRate = total > 0 ? Math.round((validCount / total) * 100) : 0;
  statsRate.textContent = total > 0 ? `${successRate}%` : '—';

  buildDomainOptions();

  const resultFilter = filterResult.value;
  const domainFilter = filterDomain.value;
  const kw = filterKeyword.value.trim().toLowerCase();

  const filtered = localResults.filter((r) => {
    if (resultFilter !== 'all' && r.result !== resultFilter) return false;
    if (domainFilter !== 'all' && extractDomain(r.url) !== domainFilter) return false;
    if (!filterTimeBucket(r.elapsed)) return false;
    if (kw) {
      const haystack = (r.url + ' ' + (r.aiContent || '') + ' ' + (r.errorMessage || '')).toLowerCase();
      if (!haystack.includes(kw)) return false;
    }
    return true;
  });

  statsCountLabel.textContent = `显示 ${filtered.length} / ${total} 条`;

  // 渲染表格（只重建 DOM，不重新请求）
  statsTableBody.innerHTML = '';
  for (const r of filtered) {
    const tr = document.createElement('tr');
    tr.className = `url-${r.result}`;

    const elapsedStr = r.elapsed != null ? r.elapsed + 's' : '—';
    const timeStr = r.timestamp ? formatTime(new Date(r.timestamp)) : '—';

    const indexCell = document.createElement('td');
    indexCell.textContent = r.originalIndex + 1;
    indexCell.style.color = '#9ca3af';
    indexCell.style.textAlign = 'center';
    tr.appendChild(indexCell);

    const urlCell = document.createElement('td');
    urlCell.textContent = getDisplayDomain(r.url);
    urlCell.title = r.url;
    tr.appendChild(urlCell);

    const resultCell = document.createElement('td');
    const resultBadge = document.createElement('span');
    resultBadge.className = `result-badge ${r.result}`;
    resultBadge.textContent = getResultText(r.result);
    resultCell.appendChild(resultBadge);
    tr.appendChild(resultCell);

    const errCell = document.createElement('td');
    if (r.errorMessage) {
      errCell.className = 'error-cell';
      errCell.textContent = r.errorMessage;
      errCell.title = r.errorMessage;
    } else {
      errCell.textContent = '—';
      errCell.style.color = '#d1d5db';
    }
    tr.appendChild(errCell);

    const aiCell = document.createElement('td');
    if (r.aiContent) {
      aiCell.className = 'ai-content-cell';
      aiCell.textContent = r.aiContent;
      aiCell.title = r.aiContent;
      aiCell.addEventListener('click', () => {
        aiCell.classList.toggle('expanded');
      });
    } else {
      aiCell.textContent = '—';
      aiCell.style.color = '#d1d5db';
    }
    tr.appendChild(aiCell);

    const elapsedCell = document.createElement('td');
    elapsedCell.textContent = elapsedStr;
    elapsedCell.style.fontSize = '11px';
    elapsedCell.style.color = '#9ca3af';
    elapsedCell.style.whiteSpace = 'nowrap';
    tr.appendChild(elapsedCell);

    const timeCell = document.createElement('td');
    timeCell.textContent = timeStr;
    timeCell.style.fontSize = '11px';
    timeCell.style.color = '#9ca3af';
    timeCell.style.whiteSpace = 'nowrap';
    tr.appendChild(timeCell);

    statsTableBody.appendChild(tr);
  }

  // 滚动到最新
  statsTableWrap.scrollTop = 0;
}

// ==================== 表单处理函数 ====================

/**
 * 在指定表单中查找评论相关元素
 * @param {HTMLFormElement} form - 要搜索的表单元素
 * @returns {Object} 包含表单统计和评论 textarea 的对象
 */
function findCommentForm(form) {
  if (!form) {
    console.log('[batch] findCommentForm: 表单为空');
    return { success: false, missingFields: ['form not found'] };
  }

  console.log('[batch] findCommentForm 最终使用的表单:', {
    id: form.id,
    className: form.className,
    action: form.action
  });

  // ── 步骤1：统计表单中所有输入框（用于日志）───────────────
  const formAllInputs = Array.from(form.querySelectorAll('input'));
  const formTextareas = Array.from(form.querySelectorAll('textarea'));
  console.log('[batch] 表单中的 input 数量:', formAllInputs.length, 'textarea 数量:', formTextareas.length);
  console.log('[batch] 表单中所有 input:', formAllInputs.map(i => ({
    name: i.name, id: i.id, type: i.type, className: i.className,
    placeholder: i.placeholder, valueLen: (i.value || '').length
  })));

  // ── 步骤2：找评论 textarea ───────────────────────────────
  let commentTextarea = null;
  if (formTextareas.length > 0) {
    // 优先找有 comment 关键词的
    commentTextarea = formTextareas.find(ta => {
      const n = (ta.name || '').toLowerCase();
      const i = (ta.id || '').toLowerCase();
      return n.includes('comment') || i.includes('comment');
    }) || formTextareas[0];
  }
  if (!commentTextarea) {
    // 再从全局找并验证属于当前表单
    const ta = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (ta && (ta.form === form || (ta.closest && ta.closest('form') === form))) {
      commentTextarea = ta;
    }
  }

  if (!commentTextarea) {
    console.log('[batch] 未找到评论 textarea!');
    return { success: false, missingFields: ['comment textarea not found'] };
  }

  return {
    success: true,
    form: form,
    commentTextarea: commentTextarea,
    formAllInputs: formAllInputs,
    formTextareas: formTextareas
  };
}

/**
 * 全局查找可能的评论 textarea
 * @param {Object} options - 选项
 * @param {boolean} options.allowGenericFallback - 是否允许通用回退
 * @returns {Element|null} 评论 textarea 元素
 */
function findLikelyCommentTextarea(options) {
  const allowGenericFallback = options && options.allowGenericFallback;
  const allTextareas = Array.from(document.querySelectorAll('textarea'));
  if (allTextareas.length === 0) return null;

  const commentTextareas = [];

  // 方法1: 通过标准的 WordPress/comment 选择器直接查找
  const standardSelectors = [
    '#comment',
    'textarea[name="comment"]',
    'textarea#comment',
    'textarea[id="comment"]',
    'textarea[name="comment_content"]',
    'textarea[id="comment_content"]',
    'textarea[name="comments"]',
    'textarea#comments'
  ];

  for (const selector of standardSelectors) {
    try {
      const ta = document.querySelector(selector);
      if (ta && !commentTextareas.includes(ta)) {
        commentTextareas.push(ta);
      }
    } catch (e) {
      // 忽略无效选择器
    }
  }

  // 方法2: 通过关键词匹配
  if (commentTextareas.length === 0) {
    allTextareas.forEach((ta) => {
      if (commentTextareas.includes(ta)) return;

      const name = (ta.name || '').toLowerCase();
      const id = (ta.id || '').toLowerCase();
      const placeholder = (ta.placeholder || '').toLowerCase();
      const ariaLabel = (ta.getAttribute('aria-label') || '').toLowerCase();
      const text = `${name} ${id} ${placeholder} ${ariaLabel}`;

      const keywords = [
        'comment', 'reply', 'message', 'review', 'feedback', 'opinion',
        '留言', '评论', '回复', '响应',
        'leave a comment', 'write a comment', 'post a comment',
        'cancel reply', 'enter your comment', 'type here'
      ];

      if (keywords.some((k) => text.includes(k))) {
        commentTextareas.push(ta);
      }
    });
  }

  // 通用回退：返回第一个 textarea
  if (commentTextareas.length === 0 && allowGenericFallback && allTextareas.length > 0) {
    return allTextareas[0];
  }

  return commentTextareas.length > 0 ? commentTextareas[0] : null;
}

// ==================== 工具函数 ====================
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getResultText(result) {
  switch (result) {
    case 'success': return '成功';
    case 'skipped': return '已存在';
    case 'manual_required': return '需手动处理';
    case 'no_comment_box': return '无评论框';
    case 'blocked_illegal': return '非法拦截';
    case 'fail': return '失败';
    default: return result;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
