(function () {
  // 只在批量任务打开的页面里工作：收到 BATCH_HANDLE 后查找评论框、生成并提交评论。
  // 昵称/邮箱/网站来自批量页配置，默认值为空
  const DEFAULT_EMAIL = '';
  const DEFAULT_PASSWORD = '';
  const DEFAULT_USERNAME = '';

  function setValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value'
    );
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    // 标准 input / change 事件（覆盖大多数场景）
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    // React 16+ / Vue 需要 InputEvent 并带 inputType
    try {
      const inputEvent = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      });
      input.dispatchEvent(inputEvent);
    } catch (_) {}

    // 某些主题在 blur 时才触发验证（如 Akismet、WP Math Latex 等插件）
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: null }));
  }

  // ──────────────────────────────────────────────────────────────
  //  处理 contenteditable div（如 wpDiscuz 评论框）
  // ──────────────────────────────────────────────────────────────
  function setValueForEditableDiv(div, value) {
    if (!div || div.getAttribute('contenteditable') !== 'true') return;
    
    console.log('[AutoComment] 填充 wpDiscuz 编辑器');
    
    // 先清空内容
    div.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    
    // 设置新内容
    div.textContent = value;
    
    // 触发输入事件
    div.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    div.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    
    // 尝试触发 keydown/keyup 事件
    try {
      div.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
      div.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
    } catch (_) {}
    
    // 触发 blur
    div.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: null }));
    
    console.log('[AutoComment] wpDiscuz 编辑器填充完成，长度:', value.length);
  }

  // ──────────────────────────────────────────────────────────────
  //  强化版填值：先聚焦 → 清空 → 按字符填入 → 触发完整事件链
  //  适用于 WordPress 中使用 React/Vue 或字符级监听的主题
  // ──────────────────────────────────────────────────────────────
  function setValueRobust(input, value) {
    console.log('进入setValueRobust方法');
    try {
      input.focus();
      input.select && input.select();
    } catch (_) {}

    // 模拟逐字输入（最高兼容性）
    console.log('开始模拟逐字输入');
    for (const ch of value) {
      if (input.value && input.value.length > 0) {
        // 用 setValue 方法清空已有内容
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (desc && desc.set) {
          desc.set.call(input, '');
        } else {
          input.value = '';
        }
      }
      const prevVal = input.value;
      // 追加字符
      const desc2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      if (desc2 && desc2.set) {
        desc2.set.call(input, prevVal + ch);
      } else {
        input.value = prevVal + ch;
      }
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    // 再触发一次完整赋值 + 事件
    console.log('再触发一次完整赋值 + 事件');
    const desc3 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (desc3 && desc3.set) {
      desc3.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value
      }));
    } catch (_) {}
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: null }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ====== AI 生成配置 ======
  // 推广网站与评论身份由 batch 页写入 chrome.storage.local
  const SITE_PROFILE_STORAGE_KEY = 'site_profile';

  // 从 chrome.storage.local 读取 batch 页保存的网站与评论身份
  function getSiteProfile() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get([SITE_PROFILE_STORAGE_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.error('读取网站配置失败：', chrome.runtime.lastError);
          resolve({});
          return;
        }
        const profile = result && result[SITE_PROFILE_STORAGE_KEY];
        resolve(profile && typeof profile === 'object' ? profile : {});
      });
    });
  }

  function readProfileText(profile, key) {
    return typeof profile[key] === 'string' ? profile[key].trim() : '';
  }

  async function getWebsiteUrl() {
    return readProfileText(await getSiteProfile(), 'website');
  }

  async function getUserProfile() {
    const profile = await getSiteProfile();
    return {
      name: readProfileText(profile, 'nickname') || DEFAULT_USERNAME,
      email: readProfileText(profile, 'email') || DEFAULT_EMAIL,
      password: DEFAULT_PASSWORD
    };
  }

  let runningBatchTaskKey = null;

  function getBatchTaskKey(batchId, urlIndex) {
    return `${batchId}:${urlIndex}`;
  }

  const submissionHelpers = window.AutoCommentSubmissionWaiter;

  // 通知批量页当前阶段（AI 生成/提交阶段不计入单页超时）
  function reportBatchPhase(batchId, urlIndex, phase) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'BATCH_PHASE', batchId, urlIndex, phase }).catch(() => {});
  }

  function sendBatchConfirm(payload) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage({ type: 'BATCH_HANDLE_CONFIRM', ...payload }).catch((err) => {
      console.warn('[content] BATCH_HANDLE_CONFIRM 发送失败:', err && err.message);
      return null;
    });
  }

  // 点击提交前落盘：页面刷新后由新页面读取并补发成功确认
  async function persistBatchSubmitContext(batchId, urlIndex, url, aiContent) {
    const ctx = submissionHelpers.createSubmitContext({ batchId, urlIndex, url, aiContent }, Date.now());
    await chrome.storage.local.set({ batchSubmitCtx: ctx });
  }

  // 原子地取走提交上下文：谁先取到谁确认，保证刷新与 10 秒超时只确认一次
  async function takeBatchSubmitContext() {
    const data = await chrome.storage.local.get(['batchSubmitCtx']);
    if (!data.batchSubmitCtx) return null;
    await chrome.storage.local.remove('batchSubmitCtx');
    return data.batchSubmitCtx;
  }

  function clearBatchSubmitContext() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.remove('batchSubmitCtx', () => {});
    }
  }

  // 提交后页面刷新：新页面加载时确认上一页的提交
  async function restoreBatchContext() {
    if (typeof chrome === 'undefined' || !chrome.storage || !submissionHelpers) return;
    const data = await chrome.storage.local.get(['batchSubmitCtx', 'batchCtx']);
    if (data.batchCtx) {
      chrome.storage.local.remove('batchCtx', () => {});
    }
    if (!data.batchSubmitCtx) return;
    const confirm = submissionHelpers.readRestoredSubmitContext(data.batchSubmitCtx, location.href, Date.now());
    if (!confirm) {
      console.log('[AutoComment] 提交上下文不属于当前页面或已过期，忽略');
      return;
    }
    // 等刷新后的页面完全加载（load 事件）再确认
    await waitForDocumentComplete();
    const ctx = await takeBatchSubmitContext();
    if (!ctx) return;
    console.log('[AutoComment] 提交后页面已加载完成，确认成功:', confirm);
    await sendBatchConfirm(confirm);
  }

  function waitForDocumentComplete() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  // 必须在点击提交之前开始监听，否则会漏掉点击时同步发出的提交请求。
  // 页面自己的 fetch/XHR 由 lib/request-tracker.js（页面主环境）通过 DOM 事件转告。
  function watchSubmitActivity() {
    const monitor = submissionHelpers.createSubmitMonitor({
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (id) => clearTimeout(id)
    });
    const onRequest = (event) => {
      let info;
      try { info = JSON.parse(event.detail); } catch (_) { return; }
      if (!info || !info.id) return;
      if (info.phase === 'start') monitor.requestStarted(info.id);
      else if (info.phase === 'end') monitor.requestEnded(info.id);
    };
    const onNavigate = () => monitor.navigated();
    window.addEventListener('autocomment:request', onRequest);
    window.addEventListener('beforeunload', onNavigate);
    window.addEventListener('pagehide', onNavigate);
    const cleanup = () => {
      window.removeEventListener('autocomment:request', onRequest);
      window.removeEventListener('beforeunload', onNavigate);
      window.removeEventListener('pagehide', onNavigate);
    };
    return {
      wait: () => monitor.wait().finally(cleanup),
      dispose: () => { monitor.dispose(); cleanup(); }
    };
  }

  // 点击提交后等待结果：
  // - 页面跳转：交给新页面在加载完成后确认
  // - 提交请求完成（或 10 秒内无任何请求/跳转）：确认成功
  // - 请求 30 秒仍未完成：记为失败
  async function waitForSubmitCompletion(watch, batchId, urlIndex, url, aiContent) {
    const reason = await watch.wait();
    console.log('[content] 提交等待结束:', reason);
    if (reason === 'navigation' || reason === 'disposed') return;
    const ctx = await takeBatchSubmitContext();
    if (!ctx) return;
    if (reason === 'max-timeout') {
      await sendBatchConfirm({ batchId, urlIndex, url: url || '', result: 'fail', aiContent, errorMessage: '提交请求 30 秒内未完成' });
      return;
    }
    await sendBatchConfirm({ batchId, urlIndex, url: url || '', result: 'success', aiContent, errorMessage: null });
  }

  // ====== 滚动触发懒加载评论 ======
  /**
   * 滚动到页面底部触发懒加载评论，然后滚动到评论区域
   */
  async function scrollToTriggerCommentLoading() {
    console.log('[AutoComment] 开始滚动触发懒加载评论...');

    // 先滚动到页面底部触发可能的懒加载
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 再向上滚动到评论区域
    const commentArea = document.querySelector(
      '#comments, .comments, #respond, .respond, .comment-respond, ' +
      '.comments-area, .comment-section, #comments-section'
    );
    if (commentArea) {
      console.log('[AutoComment] 找到评论区域，滚动到该位置');
      commentArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return !!findLikelyCommentTextarea({ allowGenericFallback: false });
  }

  // ====== 辅助函数 ======
  function isClickable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return el.offsetParent !== null &&
           style.visibility !== 'hidden' &&
           style.display !== 'none' &&
           el.disabled !== true;
  }

  // ====== 触发评论表单展开 ======
  /**
   * 查找并点击"回复"链接来展开评论表单（WordPress 等常见用法）
   */
  async function triggerCommentFormExpansion() {
    console.log('[AutoComment] 开始尝试展开评论表单...');

    const replyLinkSelectors = [
      '.comment-reply-link',
      '.reply-link',
      'a[href*="#respond"]',
      'a[href*="#comment"]',
      'a.comment-reply',
      '.respond-link',
      'a[rel="nofollow"][href*="respond"]',
      // 英文关键词
      'a:text("Reply")',
      'a:text("Respond")',
      'a:text("Leave a reply")',
      'a:text("Re")',
      // 泰语相关
      'a:text("ตอบ")',           // ตอบ = 回复
      'a:text("แสดงความคิดเห็น")', // แสดงความคิดเห็น = 发表评论
      'a:text("ความคิดเห็น")',     // ความคิดเห็น = 评论
    ];

    // 遍历所有 a 标签，查找包含回复关键词的链接
    const allLinks = Array.from(document.querySelectorAll('a'));
    const replyLinks = [];
    const replyKeywords = ['reply', 'respond', 'leave a reply', 'leave a comment', 'write a comment', 'add comment', 're', 'ตอบ', 'แสดงความคิดเห็น', 'ความคิดเห็น'];
    
    // 只在评论区域内查找回复链接，避免误点广告
    const commentAreas = [];
    const commentAreaSelectors = [
      '#comments', '.comments', '.comment-section', '#respond', '.respond',
      '.comment-respond', '#comments-section', '.comments-area', '.comment-area',
      '.wpd-thread', '#wpd-thread', '.wpdiscuz',
      // fullcirclecinema.com 等网站使用的主评论容器
      '.post-comments', '.entry-comments', '.post-comment',
      '#post-comments', '#entry-comments',
      '.comment-wrapper', '.commentlist', '#commentlist',
      '.comments-area', '.comment_content', '.comment-body'
    ];
    for (const sel of commentAreaSelectors) {
      try {
        const areas = document.querySelectorAll(sel);
        areas.forEach(area => commentAreas.push(area));
      } catch (_) {}
    }
    
    // 收集评论区域内的所有链接
    const linksInCommentArea = new Set();
    for (const area of commentAreas) {
      const links = area.querySelectorAll('a');
      links.forEach(link => linksInCommentArea.add(link));
    }
    
    for (const link of allLinks) {
      // 如果链接不在评论区域内，跳过（避免误点广告）
      if (!linksInCommentArea.has(link)) continue;
      
      const text = (link.textContent || '').toLowerCase().trim();
      const href = (link.getAttribute('href') || '').toLowerCase();
      
      // 只匹配明确的回复链接，避免误点
      const isReplyLink = 
        replyKeywords.some(kw => text.includes(kw)) ||
        (href.includes('#respond') && !href.startsWith('http'));
      
      if (isReplyLink) {
        replyLinks.push(link);
      }
    }
    
    console.log('[AutoComment] 找到回复链接数量:', replyLinks.length);
    
    // 依次尝试点击回复链接
    for (const link of replyLinks) {
      if (!isClickable(link)) continue;
      
      console.log('[AutoComment] 点击回复链接:', link.textContent.trim());
      try {
        link.click();
        
        // 等待评论表单展开
        for (let wait = 0; wait < 3000; wait += 300) {
          await new Promise(resolve => setTimeout(resolve, 300));
          const form = findCommentForm();
          if (form) {
            console.log('[AutoComment] 评论表单已展开');
            return true;
          }
          const ta = findLikelyCommentTextarea({ allowGenericFallback: false });
          if (ta) {
            console.log('[AutoComment] 找到评论 textarea');
            return true;
          }
        }
      } catch (e) {
        console.log('[AutoComment] 点击回复链接失败:', e.message);
      }
    }

    // 尝试直接定位 #respond 并点击其中的链接
    const respondArea = document.querySelector('#respond, .respond, .comment-respond, #comment-respond, .wpdiscuz');
    if (respondArea) {
      console.log('[AutoComment] 找到评论区域');
      const innerLinks = respondArea.querySelectorAll('a');
      for (const link of innerLinks) {
        if (isClickable(link)) {
          const text = (link.textContent || '').toLowerCase();
          // 跳过社交分享链接，避免误点广告
          const skipKeywords = ['share', 'facebook', 'twitter', 'email', 'print', 'pinterest', 'linkedin', 'copy link'];
          if (skipKeywords.some(kw => text.includes(kw))) continue;
          
          try {
            console.log('[AutoComment] 点击评论区域内的链接:', link.textContent.trim());
            link.click();
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const form = findCommentForm();
            if (form) {
              console.log('[AutoComment] 评论表单已展开');
              return true;
            }
          } catch (e) {}
        }
      }
    }

    console.log('[AutoComment] 未能展开评论表单');
    return false;
  }

  // ====== 完整触发评论流程 ======
  /**
   * 组合滚动 + 点击回复链接 + 等待表单加载
   */
  async function triggerCommentFormFlow() {
    // 步骤1: 先尝试直接找评论表单
    let form = findCommentForm();
    let ta = findLikelyCommentTextarea({ allowGenericFallback: false });

    if (form && ta) {
      console.log('[AutoComment] 直接找到评论表单，无需触发');
      return true;
    }

    // 步骤2: 滚动触发懒加载
    const scrolled = await scrollToTriggerCommentLoading();
    if (scrolled) {
      console.log('[AutoComment] 滚动后找到评论表单');
      return true;
    }

    // 步骤3: 点击回复链接展开表单
    const expanded = await triggerCommentFormExpansion();
    if (expanded) {
      console.log('[AutoComment] 点击回复链接后展开表单');
      return true;
    }

    // 步骤4: 再滚动一次并等待
    await scrollToTriggerCommentLoading();

    return !!findLikelyCommentTextarea({ allowGenericFallback: false });
  }

  async function initOnPageReady() {
    console.log('[AutoComment] initOnPageReady 开始');
    // 只恢复提交后的补确认上下文；正式批处理执行只由 BATCH_HANDLE 触发。
    await restoreBatchContext();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initOnPageReady();
    });
  } else {
    initOnPageReady();
  }

  function findNativeWordPressCommentForm() {
    const selectors = [
      'form#commentform',
      'form.comment-form',
      'form[name="commentform"]',
      'form[action*="wp-comments-post.php"]'
    ];

    for (const selector of selectors) {
      const form = document.querySelector(selector);
      if (form && getCommentTextareaFromForm(form)) {
        return form;
      }
    }

    return null;
  }

  function getCommentTextareaFromForm(form) {
    if (!form) return null;
    return (
      form.querySelector('textarea#comment') ||
      form.querySelector('textarea[name="comment"]') ||
      form.querySelector('textarea[id*="comment" i]') ||
      form.querySelector('textarea[name*="comment" i]') ||
      null
    );
  }

  function findLikelyCommentTextarea(options) {
    const allowGenericFallback = options && options.allowGenericFallback;
    const allTextareas = Array.from(document.querySelectorAll('textarea'));
    if (allTextareas.length === 0) return null;

    const commentTextareas = [];
    const commentForms = new Set();

    const wpNativeForm = findNativeWordPressCommentForm();
    const wpNativeTextarea = getCommentTextareaFromForm(wpNativeForm);
    if (wpNativeTextarea) {
      console.log('[AutoComment] 优先命中 WordPress 原生评论框:', {
        formId: wpNativeForm.id,
        formClass: wpNativeForm.className,
        textareaId: wpNativeTextarea.id,
        textareaName: wpNativeTextarea.name
      });
      return wpNativeTextarea;
    }

    // 方法0: 检测 wpDiscuz 可编辑 div（ contenteditable 评论框）
    const wpDiscuzEditor = findWpDiscuzEditor();
    if (wpDiscuzEditor) {
      console.log('[AutoComment] 找到 wpDiscuz 编辑器:', wpDiscuzEditor.className);
      const form = wpDiscuzEditor.closest('form');
      if (form) {
        commentForms.add(form);
      }
      // 返回一个兼容对象，模拟 textarea
      return {
        _isWpDiscuz: true,
        _realElement: wpDiscuzEditor,
        get value() { return this._realElement.textContent || ''; },
        set value(v) { this._realElement.textContent = v; },
        form: form,
        closest: wpDiscuzEditor.closest.bind(wpDiscuzEditor),
        querySelector: wpDiscuzEditor.querySelector.bind(wpDiscuzEditor),
        querySelectorAll: wpDiscuzEditor.querySelectorAll.bind(wpDiscuzEditor)
      };
    }

    // 方法1: 通过标准的 WordPress/comment 选择器直接查找
    const standardSelectors = [
      '#comment',
      'textarea[name="comment"]',
      'textarea#comment',
      'textarea[id="comment"]',
      'textarea[name="comment_content"]',
      'textarea[id="comment_content"]',
      'textarea[name="comments"]',
      'textarea#comments',
      'textarea.wpcf7-textarea'
    ];

    for (const selector of standardSelectors) {
      try {
        const ta = document.querySelector(selector);
        if (ta && !commentTextareas.includes(ta)) {
          commentTextareas.push(ta);
          const form = ta.form || (ta.closest && ta.closest('form'));
          if (form) {
            commentForms.add(form);
          }
        }
      } catch (e) {
        // 忽略无效选择器
      }
    }

    // 方法2: 通过关键词匹配
    allTextareas.forEach((ta) => {
      if (commentTextareas.includes(ta)) return; // 避免重复

      const name = (ta.name || '').toLowerCase();
      const id = (ta.id || '').toLowerCase();
      const placeholder = (ta.placeholder || '').toLowerCase();
      const ariaLabel = (ta.getAttribute('aria-label') || '').toLowerCase();
      const text = `${name} ${id} ${placeholder} ${ariaLabel}`;

      const keywords = [
        'comment',
        'comentario',
        'reply',
        'respuesta',
        'message',
        'mensaje',
        'review',
        'reseña',
        'feedback',
        'opinion',
        'opinión',
        'commenttext',
        '留言',
        '评论',
        '回复',
        '响应',
        // 泰语相关
        'ความคิดเห็น',     // ความคิดเห็น = 评论
        'แสดง',           // แสดง = 显示/发表
        'ข้อความ',        // ข้อความ = 消息/文本
        'ตอบ',            // ตอบ = 回复
        // 英语通用评论关键词
        'leave a comment',
        'write a comment',
        'post a comment',
        'cancel reply',
        'subscribe',
        // 增强：fullcirclecinema 等博客/新闻站点
        'what do you think',
        'share your thoughts',
        'type here',
        'enter your comment',
      ];
      if (keywords.some((k) => text.includes(k))) {
        commentTextareas.push(ta);
        const form = ta.form || (ta.closest && ta.closest('form'));
        if (form) {
          commentForms.add(form);
        }
      }
    });

    // 方法3: 通过表单的 class/id/keyword 检测 WordPress 和其他常见表单
    if (commentForms.size === 0) {
      const forms = Array.from(document.querySelectorAll('form'));
      forms.forEach((form) => {
        const text = (form.textContent || '').toLowerCase();
        const className = (form.className || '').toLowerCase();
        const id = (form.id || '').toLowerCase();
        const action = (form.action || '').toString().toLowerCase();

        // WordPress 和其他评论表单关键词（增强：添加泰语/葡萄牙语/西班牙语关键词）
        const keywords = [
          'deja una respuesta',
          'deja un comentario',
          'tu dirección de correo electrónico no será publicada',
          'comentario *',
          'leave a reply',
          'leave a comment',
          'post comment',
          'submit comment',
          'your name',
          'your email',
          'your comment',
          '姓名',
          '邮箱',
          '评论',
          '留言',
          '回复',
          'be first to comment',
          'cancel reply',
          'logged in as',
          // 泰语评论相关
          'ความคิดเห็น',         // ความคิดเห็น = 评论
          'แสดงความคิดเห็น',    // แสดงความคิดเห็น = 发表意见
          'ตอบกลับ',            // ตอบกลับ = 回复
          // 葡萄牙语评论相关
          'deixe um comentário',
          'deixe um comentario',
          'deixe um comentário',
          'comentário',
          'comentario',
          'seu nome',
          'seu email',
          'seu comentário',
          'seu comentario',
          'enviar comentário',
          'enviar comentario',
          'required fields',
          'campos obrigatórios',
          'campos obligatorios',
          'endereço de email',
          'endereço não será publicado',
          // 西班牙语评论相关
          'dejar un comentario',
          'tu nombre',
          'tu correo',
          'tu comentario',
          'enviar comentario',
          'campos requeridos',
          // Contact Form 7 通用关键词
          'your name',
          'your e-mail',
          'your email',
          'your message',
          'your subject',
          'subject:',
          'e-mail address',
          'email address',
          'phone',
          'tel:',
          'send',
          'submit',
          'send message',
          'send inquiry',
          'book',
          'order',
          'inquiry',
          'contact form',
          'Save my name',
          'will not be published',
          'required fields',
          'fields are marked',
          // SyncedReview 等站点的评论按钮文本
          'post comment',
          'leave a reply',
          'add comment',
          'follow-up comments',
          'new posts by email',
          'new comments',
          // fullcirclecinema 等电影/博客站点关键词
          'cancel reply',
          'you must be logged in',
          'logged in as',
          'notify me of',
          'want to join the discussion',
          'join the discussion',
          'subscribe to our'
        ];

        // WordPress 和其他表单选择器
        const formSelectors = [
          '#commentform',
          '.comment-form',
          '.commentform',
          '#respond',
          '.respond',
          '.comment-respond',
          '.wpcf7-form',
          '[class*="comment-form"]',
          '[id*="comment-form"]',
          '[class*="respond"]',
          '[id*="respond"]',
          'form[action*="comment"]',
          'form[id*="comment"]',
          'form[class*="comment"]',
          // SyncedReview 等站点
          'form[action=""]',
          'form[action="/wp-comments-post.php"]'
        ];

        const isWordPressForm = formSelectors.some(sel => {
          try {
            return document.querySelector(sel) === form;
          } catch (e) {
            return className.includes(sel.replace('#', '').replace('.', ''));
          }
        });

        const hasKeyword = keywords.some((k) => text.includes(k));
        const hasWPForm = isWordPressForm || action.includes('wp-comments-post') || action.includes('comment');

        if (hasKeyword || hasWPForm) {
          commentForms.add(form);
        }
      });
    }

    // 方法4: 在评论区域附近查找 textarea
    if (commentForms.size === 0) {
      const commentAreaSelectors = [
        '#comments',
        '.comments',
        '.comment-section',
        '#respond',
        '.respond',
        '.reply',
        '#comments-section',
        '.comments-area',
        '.comment-list',
        '.commentarea',
        '[class*="comment-area"]',
        '[id*="comment-area"]',
        // 增强：更多 WordPress 主题常见类名
        '.comment-respond',
        '#comment-respond',
        '.wp-comments-area',
        '.comments-area',
        '.comment-wrapper',
        '.entry-comments',
        '.post-comments',
        '.comment-body-wrapper',
        '#comments-area',
        // 增强：嵌套回复容器
        '.comment-inner',
        '.comment-content',
        '.comment_container',
        '#comment_container',
        '[id*="div-comment"]',
        '[class*="depth"]',
        // 葡萄牙语/西班牙语评论区域
        '.comentarios',
        '#comentarios',
        '.comentario',
        '#comentario',
        '[class*="comentario"]',
        '.deixe-comentario',
        '.deixe-um-comentario',
        '.dejar-comentario',
        '.dejar-un-comentario',
        '.comentarios-section',
        '.post-comments-area',
        // 增强：fullcirclecinema 等电影/博客站点的评论容器
        '.post-comments',
        '#post-comments',
        '.entry-comments',
        '#entry-comments',
        '.commentlist',
        '#commentlist',
        '.comment-body',
        '.commentlist-content',
        // 增强：更多评论区域变体
        '.post-comment',
        '#post-comment',
        '.article-comments',
        '.story-comments'
      ];

      for (const selector of commentAreaSelectors) {
        try {
          const areas = document.querySelectorAll(selector);
          areas.forEach(area => {
            // 在评论区域内查找所有 textarea
            const areaTextareas = area.querySelectorAll('textarea');
            areaTextareas.forEach(ta => {
              if (!commentTextareas.includes(ta)) {
                commentTextareas.push(ta);
              }
            });

            // 如果区域在表单内，获取表单
            const form = area.closest ? area.closest('form') : null;
            if (form) {
              commentForms.add(form);
            }
          });
        } catch (e) {
          // 忽略无效选择器
        }
      }
    }

    // 方法5: 检测 Disqus 评论系统
    if (commentForms.size === 0 && commentTextareas.length === 0) {
      const disqusIndicator = document.querySelector(
        '#disqus_thread, ' +
        '[id*="disqus"], ' +
        'iframe[src*="disqus"], ' +
        '.dsq-brlink, ' +
        '#disqus_thread_injection'
      );
      if (disqusIndicator) {
        console.log('[AutoComment] 检测到 Disqus 评论系统:', disqusIndicator.id || disqusIndicator.className);
        // Disqus 需要用户点击 "Join the discussion" 或类似按钮来展开评论框
        // 尝试点击展开 Disqus 评论框
        const disqusOpenBtn = document.querySelector(
          '#disqus_thread a, ' +
          '[id*="disqus"] a, ' +
          '.dsq-brlink a, ' +
          'a[href*="disqus"], ' +
          // Disqus 通用展开按钮
          '#disqus_thread button, ' +
          '.disqus-comment-count, ' +
          '[data-disqus-identifier]'
        );
        if (disqusOpenBtn && !disqusOpenBtn.hasAttribute('data-auto-comment-clicked')) {
          console.log('[AutoComment] 点击 Disqus 展开按钮');
          disqusOpenBtn.setAttribute('data-auto-comment-clicked', 'true');
          disqusOpenBtn.click();
          // 返回一个占位对象，稍后会再次检测
          return {
            _isDisqusPlaceholder: true,
            _disqusIndicator: disqusIndicator,
            value: '',
            get value() { return ''; },
            set value(v) { /* ignore */ },
            form: null,
            closest: disqusIndicator.closest.bind(disqusIndicator),
            querySelector: disqusIndicator.querySelector.bind(disqusIndicator),
            querySelectorAll: disqusIndicator.querySelectorAll.bind(disqusIndicator)
          };
        }
      }
    }

    let targetTextarea = null;

    if (commentTextareas.length > 0) {
      targetTextarea = commentTextareas[0];
    } else if (commentForms.size > 0) {
      for (const form of commentForms) {
        const formTextareas = Array.from(form.querySelectorAll('textarea'));
        if (formTextareas.length > 0) {
          targetTextarea = formTextareas[0];
          break;
        }
      }
    }

    if (!targetTextarea && allowGenericFallback) {
      targetTextarea = allTextareas[0];
    }

    return targetTextarea || null;
  }

  // ====== 通用评论提交按钮检测函数 ======
  /**
   * 输入: 无（依赖 DOM）
   * 输出: { form, button } 与当前评论框同一表单的提交控件，避免与页面上其它表单的 submit 混淆
   */
  function resolveCommentFormAndSubmitButton() {
    const ta = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (ta) {
      const form = ta.form || (ta.closest && ta.closest('form'));
      if (form) {
        const btn = findSubmitButtonInForm(form);
        if (btn) return { form, button: btn };
      }
    }
    const commentForm = findCommentForm();
    if (commentForm) {
      const btn = findSubmitButtonInForm(commentForm);
      if (btn) return { form: commentForm, button: btn };
    }
    const standalone = findStandaloneSubmitButton();
    if (standalone) {
      const form =
        standalone.form ||
        (standalone.closest && standalone.closest('form')) ||
        null;
      return { form, button: standalone };
    }
    return { form: null, button: null };
  }

  function findCommentSubmitButton() {
    return resolveCommentFormAndSubmitButton().button;
  }

  /**
   * 查找 wpDiscuz 可编辑 div 评论框
   */
  function findWpDiscuzEditor() {
    // wpDiscuz 常用选择器
    const selectors = [
      '.wpdiscuz-comment-text-wrap',
      '.wpd-form-input',
      '.wpd-form-field',
      'div[id*="wpdiscuz"]',
      'div[class*="wpdiscuz"]',
      '[contenteditable="true"]'
    ];
    
    for (const sel of selectors) {
      try {
        const editors = document.querySelectorAll(sel);
        for (const editor of editors) {
          // 检查是否是可编辑的评论框
          const isEditable = editor.getAttribute('contenteditable') === 'true' || 
                           editor.className.includes('wpdiscuz') ||
                           editor.id.includes('wpdiscuz');
          if (isEditable) {
            // 进一步验证：在评论区域附近
            const commentWrap = editor.closest('#comments, .comments, .comment-section, .wpd-thread');
            if (commentWrap || editor.querySelector('p, span, div')) {
              return editor;
            }
          }
        }
      } catch (e) {}
    }
    
    // 备用：查找所有 contenteditable 元素并筛选
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    for (const el of allEditable) {
      const className = (el.className || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const parent = el.closest('#comments, .comments, .comment-section');
      
      if ((className.includes('wpdiscuz') || id.includes('wpdiscuz') || parent) &&
          el.querySelector('p, span, div')) {
        return el;
      }
    }
    
    return null;
  }

  // 查找评论表单
  function findCommentForm() {
    // ── 方案A：直接用 WordPress 标准 form 选择器 ─────────────
    const formSelectors = [
      '#commentform',
      '.comment-form',
      '.commentform',
      'form[name="commentform"]',
      'form[id="commentform"]',
      'form[class*="comment-form"]',
      'form[id*="comment-form"]'
    ];
    for (const sel of formSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'FORM') {
          console.log('[AutoComment] 方案A找到表单:', sel);
          return el;
        }
      } catch (_) {}
    }

    // ── 方案B：先找 textarea，再用 ta.form / closest('form') ──
    const textarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (textarea) {
      if (textarea.form) {
        console.log('[AutoComment] 方案B通过 textarea.form 找到表单');
        return textarea.form;
      }
      if (textarea.closest) {
        const parentForm = textarea.closest('form');
        if (parentForm) {
          console.log('[AutoComment] 方案B通过 textarea.closest("form") 找到表单');
          return parentForm;
        }
      }
    }

    // ── 方案C：在评论区域附近找 form ─────────────────────────
    const areaSelectors = [
      '#comments', '#respond', '.comment-respond',
      '#comments-section', '.comments-area', '.comment-section'
    ];
    for (const sel of areaSelectors) {
      const area = document.querySelector(sel);
      if (area) {
        const f = area.querySelector('form') || (area.closest ? area.closest('form') : null);
        if (f) {
          console.log('[AutoComment] 方案C通过评论区域找到表单:', sel);
          return f;
        }
      }
    }

    // ── 方案D：直接找页面所有表单中含 comment/respond 关键词的 ─
    const allForms = Array.from(document.querySelectorAll('form'));
    for (const f of allForms) {
      const text = (f.textContent || '').toLowerCase();
      const cls = (f.className || '').toLowerCase();
      const fid = (f.id || '').toLowerCase();
      if (text.includes('comment') || text.includes('respond') ||
          cls.includes('comment') || fid.includes('comment') ||
          cls.includes('respond') || fid.includes('respond')) {
        console.log('[AutoComment] 方案D通过关键词找到表单:', f.id, f.className);
        return f;
      }
    }

    // ── 以下为原逻辑（备选方案）──────────────────────────────
    // 方法0: 检测 wpDiscuz
    const wpDiscuzEditor = findWpDiscuzEditor();
    if (wpDiscuzEditor) {
      const form = wpDiscuzEditor.closest('form');
      if (form) return form;
    }

    // 方法1: 通过 textarea 关联的表单
    const commentTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (commentTextarea) {
      const form = commentTextarea.form || (commentTextarea.closest && commentTextarea.closest('form'));
      if (form) return form;
    }

    // 方法2: 通过表单 class/id 查找
    const legacySelectors = [
      '#commentform',
      '.comment-form',
      '.commentform',
      '#respond',
      '.respond',
      '.comment-respond',
      'form[name="commentform"]',
      'form[id*="comment"]',
      'form[class*="comment"]',
      'form[action*="comment"]'
    ];

    for (const selector of legacySelectors) {
      const form = document.querySelector(selector);
      if (form) return form;
    }

    // 方法3: 通过关键词文本查找
    const forms = Array.from(document.querySelectorAll('form'));
    for (const form of forms) {
      const text = (form.textContent || '').toLowerCase();
      const className = (form.className || '').toLowerCase();
      const id = (form.id || '').toLowerCase();

      const keywords = [
        'comment', 'reply', 'respond', '留言', '评论', '回复',
        'post a comment', 'post comment', 'submit comment', 'leave a reply'
      ];

      if (keywords.some(k => text.includes(k) || className.includes(k) || id.includes(k))) {
        return form;
      }
    }

    // 方法4: 通过评论区域查找
    const commentAreaSelectors = [
      '#comments', '.comments', '.comment-section', '#respond',
      '.respond', '.reply', '#comments-section', '.comments-area'
    ];

    for (const selector of commentAreaSelectors) {
      const area = document.querySelector(selector);
      if (area) {
        const form = area.querySelector('form') || area.closest('form');
        if (form) return form;
      }
    }

    return null;
  }

  // 在指定表单中查找提交按钮
  function findSubmitButtonInForm(form) {
    if (!form) return null;

    // 方法1: 通过标准 WordPress 选择器直接查找
    const wpSelectors = [
      '#submit',
      '#submit-btn',
      '#publish',
      'input#submit',
      'input[type="submit"]#submit',
      '.submit',
      'input.submit',
      'button.submit',
      '[name="submit"]',
      'input[name="submit"]',
      'button[name="submit"]',
      'input[type="submit"][name="submit"]',
      'input[name="publish"]',
      'button[name="publish"]',
      '.publish',
      '#wp-submit',
      // wpDiscuz 特定选择器
      '.wpd-submit-btn',
      '.wpdiscuz-submit-btn',
      '.wpd-button',
      'button[id*="wpdiscuz"]',
      'button[class*="wpdiscuz"]',
      '#wpdtdfьи_submit',
      '.wc_comment_submit'
    ];

    for (const selector of wpSelectors) {
      try {
        const btn = form.querySelector(selector);
        if (btn) {
          console.log('[AutoComment] 通过 WordPress 选择器找到提交按钮:', selector);
          return btn;
        }
      } catch (e) {
        // 忽略无效选择器
      }
    }

    // 方法2: 查找所有可能的提交元素（表单内无 type 的 button 默认为 submit）
    const candidates = form.querySelectorAll(
      'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"], [role="submit"]'
    );

    if (candidates.length > 0) {
      // 优先返回有明确提交相关的按钮
      for (const btn of candidates) {
        const value = (btn.value || '').toLowerCase();
        const className = (btn.className || '').toLowerCase();
        const id = (btn.id || '').toLowerCase();
        const text = (btn.textContent || '').toLowerCase();

        // 检查是否包含提交相关关键词（包含西班牙语和 publish）
        const submitKeywords = [
          'submit', 'post', 'comment', 'publish', 'publicar',
          'responder', 'enviar', 'reply', 'send', 'comentar',
          'replicar', 'dejar', 'commentaire', 'comentar',
          'anzeigen', 'absenden', '回答', '返信',
          'post a comment'
        ];

        if (submitKeywords.some(k => value.includes(k) || className.includes(k) || id.includes(k) || text.includes(k))) {
          console.log('[AutoComment] 通过关键词找到提交按钮:', { value, className, id, text });
          return btn;
        }
      }

      // 如果没有找到关键词匹配，返回第一个
      console.log('[AutoComment] 找到提交按钮（第一个）:', candidates[0].tagName);
      return candidates[0];
    }

    // 方法3: 通过文本内容查找（包括 input value）
    const allButtons = form.querySelectorAll('button, input[type="button"]');
    for (const btn of allButtons) {
      const text = (btn.textContent || btn.value || '').toLowerCase().trim();
      const className = (btn.className || '').toLowerCase();
      const id = (btn.id || '').toLowerCase();

      const submitKeywords = [
        'submit', 'post', 'comment', 'reply', 'respond', 'publish',
        '提交', '评论', '发送', 'publicar', 'responder', 'enviar',
        'post comment', 'submit comment', 'post a comment'
      ];

      if (submitKeywords.some(k => text.includes(k) || className.includes(k) || id.includes(k))) {
        console.log('[AutoComment] 通过文本找到提交按钮:', { text, className, id });
        return btn;
      }
    }

    // 如果表单只有一个按钮，返回它
    if (allButtons.length === 1) {
      console.log('[AutoComment] 表单只有一个按钮，返回它');
      return allButtons[0];
    }

    // 方法4: 返回表单内的第一个提交类型输入
    const submitInputs = form.querySelectorAll('input');
    for (const input of submitInputs) {
      const type = (input.type || '').toLowerCase();
      if (type === 'submit' || type === 'image') {
        console.log('[AutoComment] 返回第一个 submit input');
        return input;
      }
    }

    return null;
  }

  // 查找独立的提交按钮（不在表单内但在评论区域附近）
  function findStandaloneSubmitButton() {
    const submitKeywords = [
      'submit', 'post', 'comment', 'publish', 'respond', 'reply',
      '提交', '评论', '发送', 'publicar', 'responder', 'enviar',
      'comentar', 'dejar', 'anzeigen', 'absenden', '回答', '返信'
    ];

    // 方法1: 通过 class/id 查找常见提交按钮选择器
    const commonSelectors = [
      '#submit',
      '#submit-btn',
      '#submit-button',
      '#publish',
      '#wp-submit',
      'input#submit',
      'input[type="submit"]#submit',
      '.submit',
      '.submit-btn',
      '.submit-button',
      '.publish',
      'input.submit',
      'button.submit',
      '.comment-submit',
      '.post-comment',
      '#post-comment',
      '.btn-submit',
      '.submit-comment',
      '.wpcf7-submit',
      '#wpcf7-submit',
      '.form-submit',
      '#form-submit'
    ];

    for (const selector of commonSelectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn) {
          console.log('[AutoComment] 通过选择器找到独立提交按钮:', selector);
          return btn;
        }
      } catch (e) {
        // 忽略无效选择器
      }
    }

    // 方法2: 直接查找所有提交按钮
    const submitButtons = document.querySelectorAll(
      'button[type="submit"], input[type="submit"], input[type="image"]'
    );

    for (const btn of submitButtons) {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      const className = (btn.className || '').toLowerCase();
      const id = (btn.id || '').toLowerCase();
      const name = (btn.name || '').toLowerCase();

      // 检查是否包含提交相关关键词
      if (submitKeywords.some(k =>
        text.includes(k) ||
        className.includes(k) ||
        id.includes(k) ||
        name.includes(k)
      )) {
        console.log('[AutoComment] 通过关键词找到独立提交按钮:', { text, className, id });
        return btn;
      }
    }

    // 方法3: 返回页面中的第一个提交按钮（在评论区域附近）
    const commentAreas = document.querySelectorAll(
      '#comments, .comments, .comment-section, #respond, .respond, .reply, .comment-respond, ' +
      '.comments-area, .commentlist, .comment-area, #comments-section, .comments-section'
    );

    for (const area of commentAreas) {
      // 在评论区域查找提交按钮
      const areaButtons = area.querySelectorAll(
        'button[type="submit"], input[type="submit"], input[type="image"]'
      );
      for (const btn of areaButtons) {
        console.log('[AutoComment] 在评论区域找到提交按钮');
        return btn;
      }

      // 在评论区域查找带有提交关键词的按钮
      const allButtons = area.querySelectorAll('button, input[type="button"]');
      for (const btn of allButtons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (submitKeywords.some(k => text.includes(k))) {
          console.log('[AutoComment] 在评论区域通过关键词找到按钮');
          return btn;
        }
      }
    }

    // 方法4: 如果只有一个提交按钮，直接返回
    if (submitButtons.length === 1) {
      console.log('[AutoComment] 页面只有一个提交按钮，返回它');
      return submitButtons[0];
    }

    return null;
  }

  // 检查按钮是否可见且可点击
  function isButtonClickable(button) {
    if (!button) return false;

    // 检查 disabled 状态
    if (button.disabled) {
      console.log('[AutoComment] 按钮被禁用');
      return false;
    }

    if (button.getAttribute('aria-disabled') === 'true') {
      console.log('[AutoComment] 按钮 aria-disabled 为 true');
      return false;
    }

    const style = window.getComputedStyle(button);
    const rect = button.getBoundingClientRect();

    // 检查是否可见
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      console.log('[AutoComment] 按钮不可见:', { display: style.display, visibility: style.visibility, opacity: style.opacity });
      return false;
    }

    // 检查尺寸
    if (rect.width === 0 || rect.height === 0) {
      console.log('[AutoComment] 按钮尺寸为0:', { width: rect.width, height: rect.height });
      return false;
    }

    // 检查是否在视口内（允许部分可见）
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

    // 至少部分可见即可
    const isPartiallyVisible = !(rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth);

    if (!isPartiallyVisible) {
      console.log('[AutoComment] 按钮不在视口内，尝试立即滚动（避免 smooth 未完成导致坐标错误）');
      try {
        button.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
        return true;
      } catch (e) {
        console.log('[AutoComment] 滚动失败:', e.message);
        return false;
      }
    }

    return true;
  }

  // 点击提交按钮并处理结果
  async function clickCommentSubmitButton() {
    console.log('[AutoComment] ===== 开始自动提交评论 =====');
    console.log('[AutoComment] 当前URL:', window.location.href);

    // 列出页面上所有按钮供调试
    const allButtons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[class*="submit"], input[type="image"]');
    console.log('[AutoComment] 页面中所有按钮/链接:', Array.from(allButtons).map(b => ({
      tagName: b.tagName,
      type: b.type,
      id: b.id,
      className: b.className,
      name: b.name,
      value: b.value,
      text: b.textContent ? b.textContent.trim().substring(0, 50) : ''
    })));

    const resolved = resolveCommentFormAndSubmitButton();
    const form = resolved.form;
    const button = resolved.button;
    console.log('[AutoComment] resolveCommentFormAndSubmitButton:', {
      formId: form ? form.id : null,
      formClass: form ? form.className : null,
      buttonTag: button ? button.tagName : null,
      buttonId: button ? button.id : null
    });

    if (!button) {
      console.log('[AutoComment] 未找到任何提交按钮');
      return { success: false, error: '未找到评论提交按钮' };
    }

    return await performClick(button);
  }

  // 执行点击操作
  async function performClick(button) {
    console.log('[AutoComment] 找到提交按钮:', {
      tagName: button.tagName,
      type: button.type,
      id: button.id,
      className: button.className,
      name: button.name,
      value: button.value,
      text: button.textContent ? button.textContent.trim().substring(0, 50) : '',
      disabled: button.disabled
    });

    // 获取评论文本框内容用于确认
    const commentTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (commentTextarea) {
      console.log('[AutoComment] 评论文本框内容:', commentTextarea.value ? commentTextarea.value.substring(0, 100) + '...' : '(空)');
    }

    if (!isButtonClickable(button)) {
      console.log('[AutoComment] 提交按钮不可见或被禁用');
      return { success: false, error: '提交按钮不可见或被禁用' };
    }

    function tryRequestSubmit(formEl, submitter) {
      if (!formEl) return false;
      if (typeof formEl.requestSubmit === 'function') {
        try {
          formEl.requestSubmit(submitter);
          return true;
        } catch (err) {
          console.log('[AutoComment] requestSubmit 失败:', err.message);
        }
      }
      return false;
    }

    try {
      // 长页面若用 smooth，滚动未完成时 getBoundingClientRect 会算错坐标，合成点击落空
      button.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 80));

      console.log('[AutoComment] 尝试点击提交按钮...');

      const rect = button.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);

      const pointerOpts = {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        view: window
      };

      try {
        if (typeof PointerEvent !== 'undefined') {
          button.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
          await new Promise(resolve => setTimeout(resolve, 20));
        }

        button.dispatchEvent(new MouseEvent('mousedown', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        }));
        await new Promise(resolve => setTimeout(resolve, 40));

        button.dispatchEvent(new MouseEvent('mouseup', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        }));
        await new Promise(resolve => setTimeout(resolve, 20));

        if (typeof PointerEvent !== 'undefined') {
          button.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
          await new Promise(resolve => setTimeout(resolve, 20));
        }

        button.dispatchEvent(new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        }));


        console.log('[AutoComment] 提交按钮点击成功 (pointer/mousedown→mouseup→click)');
        return { success: true, button: button };
      } catch (e) {
        console.log('[AutoComment] 合成事件失败，尝试 button.click():', e.message);
        try {
          button.click();
            console.log('[AutoComment] button.click() 点击成功');
          return { success: true, button: button };
        } catch (e2) {
          console.log('[AutoComment] button.click() 也失败:', e2.message);

          const formEl = button.form || button.closest('form');
          if (tryRequestSubmit(formEl, button)) {
                console.log('[AutoComment] form.requestSubmit(submitter) 成功');
            return { success: true, button: button };
          }
          try {
            if (formEl) {
              console.log('[AutoComment] 降级 form.submit()（无 submit 事件）');
              formEl.submit();
                    return { success: true, button: button };
            }
          } catch (e3) {
            console.log('[AutoComment] 表单提交也失败:', e3.message);
          }

          return { success: false, error: '点击按钮失败: ' + e2.message };
        }
      }
    } catch (e) {
      console.log('[AutoComment] 直接点击失败:', e.message);

      try {
        const event = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });
        button.dispatchEvent(event);
        console.log('[AutoComment] 使用 dispatchEvent 点击成功');
        return { success: true, button: button };
      } catch (e2) {
        console.log('[AutoComment] dispatchEvent 点击也失败:', e2.message);

        const formEl = button.form || button.closest('form');
        if (tryRequestSubmit(formEl, button)) {
            console.log('[AutoComment] form.requestSubmit(submitter) 成功');
          return { success: true, button: button };
        }
        try {
          if (formEl) {
            console.log('[AutoComment] 尝试 form.submit()');
            formEl.submit();
                return { success: true, button: button };
          }
        } catch (e3) {
          console.log('[AutoComment] 表单提交失败:', e3.message);
        }

        return { success: false, error: '点击按钮失败: ' + e.message };
      }
    }
  }

  function tryFillCommentTextareaWithPromotion(promotionText) {
    if (!promotionText) {
      console.log('[AutoComment] 没有推广文案可填充');
      return false;
    }

    const targetTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (!targetTextarea) {
      console.log('[AutoComment] 未找到评论文本框，无法填充文案');
      return false;
    }

    console.log('[AutoComment] 找到评论文本框:', {
      name: targetTextarea.name,
      id: targetTextarea.id,
      className: targetTextarea.className,
      currentValue: targetTextarea.value ? targetTextarea.value.substring(0, 50) + '...' : '(空)'
    });

    // 如果文本框已有内容，可以选择覆盖或跳过
    const currentValue = (targetTextarea.value || '').trim();
    // 如果当前文本与缓存文案相同，说明已填充过，直接跳过
    if (currentValue === promotionText) {
      console.log('[AutoComment] 文本框内容已与缓存文案一致，跳过');
      return false;
    }
    // 如果文本框有内容但与缓存文案不同（可能是页面刷新后回填了旧评论内容），
    // 则用缓存文案覆盖
    if (currentValue && currentValue !== promotionText) {
      console.log('[AutoComment] 文本框内容与缓存文案不一致，将用缓存覆盖旧内容');
    }

    setValueRobust(targetTextarea, promotionText);
    console.log('[AutoComment] 成功填入推广文案，长度:', promotionText.length);
    return true;
  }

  async function findCommentTargetsForBatchUsingManualFlow(timeoutMs = 12000) {
    const start = Date.now();
    let hasTriggeredFlow = false;
    let lastForm = null;
    let lastTextarea = null;

    while (Date.now() - start < timeoutMs) {
      lastForm = findCommentForm();
      lastTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });

      if (lastForm && lastTextarea) {
        console.log('[content] BATCH_HANDLE 手动按钮同款找框成功:', {
          formId: lastForm.id,
          formClass: lastForm.className,
          textareaName: lastTextarea.name,
          textareaId: lastTextarea.id
        });
        return { form: lastForm, textarea: lastTextarea };
      }

      if (!hasTriggeredFlow) {
        hasTriggeredFlow = true;
        console.log('[content] BATCH_HANDLE 使用手动按钮同款流程触发评论表单展开...');
        await triggerCommentFormFlow();
      }

      await new Promise(resolve => setTimeout(resolve, 800));
    }

    console.log('[content] BATCH_HANDLE 手动按钮同款找框超时:', {
      hasForm: !!lastForm,
      hasTextarea: !!lastTextarea
    });
    return { form: lastForm, textarea: lastTextarea };
  }

  // ============================================================
  //  确保评论表单所有必填字段都被正确填入，并在提交前验证
  // ============================================================
  async function ensureAllCommentFormFieldsFilled(commentText, skipCommentValidation = false) {
    const userProfile = await getUserProfile();
    const WEBSITE = await getWebsiteUrl();
    const USERNAME = userProfile.name || '';
    const EMAIL = userProfile.email || '';

    console.log('[AutoComment] ===== ensureAllCommentFormFieldsFilled 开始 =====');
    console.log('[AutoComment] 将填入 - Name:', USERNAME, '| Email:', EMAIL, '| Website:', WEBSITE, '| skipComment:', skipCommentValidation);

    // ── 前置检查：配置缺失则直接报错，不静默失败 ─────────────────
    if (!USERNAME || !EMAIL) {
      const missing = [];
      if (!USERNAME) missing.push('姓名（Name）');
      if (!EMAIL) missing.push('邮箱（Email）');
      console.error('[AutoComment] 请先在批量页填写评论' + missing.join('和'));
      return { success: false, missingFields: ['name config missing', 'email config missing'] };
    }

    // ── 步骤1：找到表单 ──────────────────────────────────────
    let form = null;

    // 方法A：直接用 WordPress 标准 form 选择器
    const formSelectors = [
      '#commentform',
      '.comment-form',
      '.commentform',
      'form[name="commentform"]',
      'form[id="commentform"]',
      'form[class*="comment-form"]',
      'form[id*="comment-form"]'
    ];
    for (const sel of formSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'FORM') {
          form = el;
          console.log('[AutoComment] 通过选择器找到表单:', sel);
          break;
        }
      } catch (_) {}
    }

    // 方法B：先找 textarea，再用 ta.form / closest('form')
    if (!form) {
      const textarea = findLikelyCommentTextarea({ allowGenericFallback: true });
      if (textarea) {
        console.log('[AutoComment] 找到评论 textarea:', {
          name: textarea.name,
          id: textarea.id,
          className: textarea.className,
          tagName: textarea.tagName,
          formAttr: textarea.form ? textarea.form.id || textarea.form.className : 'null'
        });
        // textarea.form 在大多数现代浏览器中会返回关联的表单元素
        if (textarea.form) {
          form = textarea.form;
          console.log('[AutoComment] 通过 textarea.form 找到表单');
        } else if (textarea.closest) {
          const parentForm = textarea.closest('form');
          if (parentForm) {
            form = parentForm;
            console.log('[AutoComment] 通过 textarea.closest("form") 找到表单');
          }
        }
      }
    }

    // 方法C：在评论区域附近找 form
    if (!form) {
      const areaSelectors = [
        '#comments', '#respond', '.comment-respond',
        '#comments-section', '.comments-area', '.comment-section'
      ];
      for (const sel of areaSelectors) {
        const area = document.querySelector(sel);
        if (area) {
          const f = area.querySelector('form') || (area.closest ? area.closest('form') : null);
          if (f) {
            form = f;
            console.log('[AutoComment] 通过评论区域找到表单:', sel);
            break;
          }
        }
      }
    }

    // 方法D：直接找页面所有表单中含 comment/respond 关键词的
    if (!form) {
      const allForms = Array.from(document.querySelectorAll('form'));
      for (const f of allForms) {
        const text = (f.textContent || '').toLowerCase();
        const cls = (f.className || '').toLowerCase();
        const fid = (f.id || '').toLowerCase();
        if (text.includes('comment') || text.includes('respond') ||
            cls.includes('comment') || fid.includes('comment') ||
            cls.includes('respond') || fid.includes('respond')) {
          form = f;
          console.log('[AutoComment] 通过关键词找到表单:', f.id, f.className);
          break;
        }
      }
    }

    if (!form) {
      console.log('[AutoComment] 未能找到评论表单!');
      return { success: false, missingFields: ['form not found'] };
    }

    console.log('[AutoComment] 最终使用的表单:', {
      id: form.id,
      className: form.className,
      action: form.action
    });

    // ── 步骤2：统计表单中所有输入框（用于日志）───────────────
    const formAllInputs = Array.from(form.querySelectorAll('input'));
    const formTextareas = Array.from(form.querySelectorAll('textarea'));
    console.log('[AutoComment] 表单中的 input 数量:', formAllInputs.length, 'textarea 数量:', formTextareas.length);
    console.log('[AutoComment] 表单中所有 input:', formAllInputs.map(i => ({
      name: i.name, id: i.id, type: i.type, className: i.className,
      placeholder: i.placeholder, valueLen: (i.value || '').length
    })));

    // ── 步骤3：找评论 textarea ───────────────────────────────
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
      console.log('[AutoComment] 未找到评论 textarea!');
      return { success: false, missingFields: ['comment textarea not found'] };
    }

    // ── 步骤4：找 Name 输入框 ─────────────────────────────────
    // 直接选择器 + closest 验证（不依赖 formInputs 集合，避免遗漏嵌套字段）
    let nameInput = null;
    const nameSelectors = [
      '#author', 'input[name="author"]',
      'input[id*="author" i]', 'input[class*="author" i]',
      'input[name="name"]', 'input[name="your-name"]',
      'input[id="name"]', 'input[id="author-name"]',
      'input[placeholder*="name" i]', 'input[placeholder*="姓名" i]',
      'input[placeholder*="昵称" i]', 'input[placeholder*="名字" i]'
    ];
    for (const sel of nameSelectors) {
      try {
        const el = form.querySelector(sel);
        if (el && el.tagName === 'INPUT' && el.closest('form') === form) {
          nameInput = el;
          console.log('[AutoComment] 通过选择器找到 nameInput:', sel, { name: nameInput.name, id: nameInput.id, type: nameInput.type });
          break;
        }
      } catch (_) {}
    }
    if (nameInput) {
      console.log('[AutoComment] 找到 nameInput:', { name: nameInput.name, id: nameInput.id, type: nameInput.type });
    } else {
      console.log('[AutoComment] 未找到 nameInput!');
    }

    // ── 步骤5：找 Email 输入框 ───────────────────────────────
    let emailInput = null;
    const emailSelectors = [
      '#email', 'input[name="email"]', 'input[type="email"]',
      'input[id="mail"]', 'input[name="mail"]',
      'input[id*="email" i]', 'input[class*="email" i]',
      'input[name="your-email"]', 'input[name="your_mail"]',
      'input[placeholder*="email" i]', 'input[placeholder*="邮箱" i]',
      'input[placeholder*="mail" i]', 'input[placeholder*="e-mail" i]'
    ];
    for (const sel of emailSelectors) {
      try {
        const el = form.querySelector(sel);
        if (el && el.tagName === 'INPUT' && el.closest('form') === form) {
          emailInput = el;
          console.log('[AutoComment] 通过选择器找到 emailInput:', sel, { name: emailInput.name, id: emailInput.id, type: emailInput.type });
          break;
        }
      } catch (_) {}
    }
    if (emailInput) {
      console.log('[AutoComment] 找到 emailInput:', { name: emailInput.name, id: emailInput.id, type: emailInput.type });
    } else {
      console.log('[AutoComment] 未找到 emailInput!');
    }

    // ── 步骤6：找 Website 输入框 ─────────────────────────────
    let websiteInput = null;
    const urlSelectors = [
      '#url', 'input[name="url"]', 'input[type="url"]',
      'input[id="website"]', 'input[name="website"]',
      'input[placeholder*="website" i]', 'input[placeholder*="网站" i]',
      'input[placeholder*="url" i]'
    ];
    for (const sel of urlSelectors) {
      try {
        const el = form.querySelector(sel);
        if (el && el.tagName === 'INPUT' && el.closest('form') === form) {
          websiteInput = el;
          console.log('[AutoComment] 通过选择器找到 websiteInput:', sel);
          break;
        }
      } catch (_) {}
    }
    if (websiteInput) {
      console.log('[AutoComment] 找到 websiteInput:', { name: websiteInput.name, id: websiteInput.id, type: websiteInput.type });
    } else {
      console.log('[AutoComment] 未找到 websiteInput（可选）');
    }

    // ── 步骤7：填入所有字段 ─────────────────────────────────
    console.log('[AutoComment] 开始填入字段...');

    if (nameInput) {
      setValueRobust(nameInput, USERNAME);
    }
    if (emailInput) {
      setValueRobust(emailInput, EMAIL);
    }
    if (websiteInput && WEBSITE) {
      setValue(websiteInput, WEBSITE);
    }
    if (commentText && commentTextarea) {
      // 检测是否是 wpDiscuz 编辑器
      if (commentTextarea._isWpDiscuz) {
        setValueForEditableDiv(commentTextarea._realElement, commentText);
      } else {
        setValue(commentTextarea, commentText);
      }
    }

    // ── 步骤8：等待 DOM 更新后验证 ───────────────────────────
    await new Promise(resolve => setTimeout(resolve, 150));

    const missingFields = [];
    const validationLog = {};

    // 验证 comment（预检查时跳过，因为文案尚未生成）
    // 注意：如果是 wpDiscuz，需要从 _realElement 获取 textContent
    const cv = commentTextarea._isWpDiscuz 
      ? (commentTextarea._realElement.textContent || '').trim()
      : (commentTextarea.value || '').trim();
    validationLog.comment = { filled: cv.length > 0, length: cv.length, isWpDiscuz: !!commentTextarea._isWpDiscuz };
    if (!skipCommentValidation && (!cv || cv.length < 5)) {
      missingFields.push('comment');
    }

    // 验证 name（某些网站不强制要求姓名，不影响提交）
    if (nameInput) {
      const nv = (nameInput.value || '').trim();
      validationLog.name = { filled: nv.length > 0, value: nv.substring(0, 20) };
    } else {
      validationLog.name = { found: false, optional: true };
    }

    // 验证 email（某些网站（如 Jetpack、Disqus）不强制要求邮箱，不影响提交）
    if (emailInput) {
      const ev = (emailInput.value || '').trim();
      validationLog.email = { filled: ev.length > 0, value: ev.substring(0, 20) };
    } else {
      validationLog.email = { found: false, optional: true };
    }

    // 验证 website（可选，不影响提交）
    if (websiteInput) {
      validationLog.website = { filled: !!(websiteInput.value || '').trim() };
    }

    console.log('[AutoComment] 字段验证结果:', validationLog);
    console.log('[AutoComment] 缺失字段:', missingFields);
    console.log('[AutoComment] ===== ensureAllCommentFormFieldsFilled 结束 =====');

    return { success: missingFields.length === 0, missingFields };
  }

  // 收集当前页面内容，交给插件后台调用 OpenRouter 生成评论
  async function generatePromotionCopy() {
    const descriptionMeta =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[name="Description"]');

    let summary = '';
    if (document.body) {
      summary = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const MAX_LEN = 4000;
      if (summary.length > MAX_LEN) {
        summary = summary.slice(0, MAX_LEN) + ' …';
      }
    }

    const profile = await getSiteProfile();
    const reply = await chrome.runtime.sendMessage({
      type: 'OPENROUTER_GENERATE',
      pageContext: {
        url: window.location.href || '',
        title: document.title || '',
        description: descriptionMeta ? descriptionMeta.content || '' : '',
        summary
      },
      siteProfile: {
        website: readProfileText(profile, 'website'),
        description: readProfileText(profile, 'description')
      }
    });

    if (!reply || !reply.ok) {
      throw new Error((reply && reply.error) || '生成失败：插件后台无响应');
    }
    console.log('AI 生成的网站推广文案：\n', reply.text);
    return reply.text;
  }

  // 监听批量页发来的消息
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
      // 就绪检测：batch.js 发 PING 确认 content.js 已注入
      if (message && message.type === 'PING') {
        _sendResponse({ ok: true });
        return;
      }
      // 批量处理模式：收到任务后自动执行评论流程（改为 async，等待执行结果再响应）
      if (message && message.type === 'BATCH_HANDLE') {
        console.log('[content] 收到 BATCH_HANDLE >>>', { batchId: message.batchId, urlIndex: message.urlIndex, url: message.url, time: new Date().toISOString() });
        const taskKey = getBatchTaskKey(message.batchId, message.urlIndex);
        if (runningBatchTaskKey === taskKey) {
          console.warn('[content] 同一批处理任务正在执行，忽略重复 BATCH_HANDLE:', taskKey);
          _sendResponse({ ok: false, error: 'duplicate_batch_task_running', urlIndex: message.urlIndex });
          return;
        }
        handleBatchTask(message.batchId, message.urlIndex, message.url)
          .then(() => {
            console.log('[content] BATCH_HANDLE 处理完成, 发送响应 {ok:true}');
            _sendResponse({ ok: true, urlIndex: message.urlIndex });
          })
          .catch((err) => {
            console.error('[content] BATCH_HANDLE 处理异常:', err);
            _sendResponse({ ok: false, error: String(err) });
          });
        return true;
      }
    });
  }

  // ==================== 批量处理任务函数 ====================
  /**
   * 批量模式：自动完成评论流程并上报结果
   */
  function getMetaContent(selector) {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '') : '';
  }

  function evaluateCurrentPageForIllegalSite(url) {
    const filter = window.AutoCommentIllegalSiteFilter;
    if (!filter || typeof filter.evaluatePage !== 'function') {
      console.warn('[content] 非法网站过滤器未加载，跳过页面检测');
      return { blocked: false };
    }

    const pageText = document.body ? document.body.innerText : '';
    return filter.evaluatePage(url || location.href, {
      title: document.title || '',
      description: getMetaContent('meta[name="description"], meta[property="og:description"]'),
      keywords: getMetaContent('meta[name="keywords"]'),
      text: pageText
    });
  }

  async function reportIllegalSiteAndClose(batchId, urlIndex, url, check) {
    const reason = (check && check.reason) || '非法网站拦截：命中赌博/色情规则';
    console.warn('[content] 检测到非法网站，上报 blocked_illegal 并关闭网页:', { batchId, urlIndex, url, reason });
    await writePendingResult(batchId, urlIndex, url, 'blocked_illegal', null, reason);

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'BATCH_HANDLE_CONFIRM',
        batchId,
        urlIndex,
        url: url || location.href || '',
        aiContent: '',
        result: 'blocked_illegal',
        errorMessage: reason
      }).then((response) => {
        console.log('[content] blocked_illegal BATCH_HANDLE_CONFIRM 响应:', response);
        resolve(response);
      }).catch((err) => {
        if (err.message && err.message.includes('message channel closed')) {
          console.log('[content] 消息通道已关闭（标签页可能已关闭），忽略错误');
        } else {
          console.warn('[content] blocked_illegal 发送消息失败:', err);
        }
        resolve(null);
      });
    });

    setTimeout(() => {
      window.close();
    }, 700);
  }

  async function handleBatchTask(batchId, urlIndex, url, originalIndex) {
    console.log('[content] handleBatchTask 开始 >>>', { batchId, urlIndex, url, time: new Date().toISOString() });
    const taskKey = getBatchTaskKey(batchId, urlIndex);
    if (runningBatchTaskKey === taskKey) {
      console.warn('[content] handleBatchTask 跳过重复执行:', taskKey);
      return;
    }
    runningBatchTaskKey = taskKey;
    try {
      console.log('[content] 1/6 等待页面加载...');
      await waitForPageReady();
      const illegalCheck = evaluateCurrentPageForIllegalSite(url);
      if (illegalCheck.blocked) {
        await reportIllegalSiteAndClose(batchId, urlIndex, url, illegalCheck);
        return;
      }
      console.log('[content] 2/6 检查是否已处理过...');
      const existingResult = await checkExistingBatchResult(batchId, url, urlIndex);
      if (existingResult) {
        console.log('[content] 该URL已处理过，跳过AI生成，直接上报:', existingResult);
        await reportAlreadyCommented(batchId, urlIndex, url, existingResult.aiContent);
        return;
      }
      console.log('[content] 3/6 确认评论表单存在...');
      reportBatchPhase(batchId, urlIndex, 'finding');
      // 先尝试触发评论表单展开（如果表单是隐藏的需要点击回复链接）
      let form = findCommentForm();
      let ta = findLikelyCommentTextarea({ allowGenericFallback: false });
      if (!form || !ta) {
        console.log('[content] 评论表单未展开，尝试触发展开...');
        await triggerCommentFormFlow();
        // 等待表单展开后再检查
        await new Promise(resolve => setTimeout(resolve, 1500));
        form = findCommentForm();
        ta = findLikelyCommentTextarea({ allowGenericFallback: false });
      }
      // 如果仍然找不到评论框，检测是否有 Disqus，需要额外等待 iframe 加载
      if (!form || !ta) {
        const hasDisqus = document.querySelector('#disqus_thread, [id*="disqus"], iframe[src*="disqus"]');
        if (hasDisqus) {
          console.log('[content] 检测到 Disqus，额外等待 iframe 加载...');
          // 尝试点击展开按钮
          const disqusBtn = document.querySelector('#disqus_thread a, [id*="disqus"] a, .dsq-brlink a, #disqus_thread button');
          if (disqusBtn && !disqusBtn.hasAttribute('data-auto-comment-clicked')) {
            disqusBtn.setAttribute('data-auto-comment-clicked', 'true');
            disqusBtn.click();
          }
          // 等待 Disqus iframe 完全加载（最常需要的时间）
          await new Promise(resolve => setTimeout(resolve, 5000));
          form = findCommentForm();
          ta = findLikelyCommentTextarea({ allowGenericFallback: true });
          if (ta) {
            console.log('[content] Disqus iframe 加载后找到评论框');
          }
        }
      }
      // 最终检查：仍然找不到评论框则先触发流程再继续（与浮窗按钮行为一致）
      if (!form || !ta) {
        console.log('[content] 未找到评论框，尝试触发展开流程...');
        await triggerCommentFormFlow();
        await new Promise(resolve => setTimeout(resolve, 2000));
        form = findCommentForm();
        ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      }
      if (!form || !ta) {
        console.log('[content] 常规批处理找框未完成，切换到手动按钮同款找框逻辑...');
        const manualTargets = await findCommentTargetsForBatchUsingManualFlow(12000);
        form = manualTargets.form;
        ta = manualTargets.textarea;
      }
      // 确认找到评论框后再生成 AI 文案，避免浪费 OpenRouter 调用
      if (!form || !ta) {
        console.log('[content] 未找到评论框，跳过AI生成，结束任务');
        throw new Error('__NO_COMMENT_BOX__');
      }
      const manualCheckBeforeAi = detectManualRequiredChallenge(form);
      if (manualCheckBeforeAi.found) {
        await reportManualRequiredAndClose(batchId, urlIndex, url, null);
        return;
      }
      console.log('[content] 4/6 生成AI文案...');
      reportBatchPhase(batchId, urlIndex, 'generating');
      const aiContent = await generatePromotionCopy();
      console.log('[content] AI文案生成完成，长度:', aiContent ? aiContent.length : 0, aiContent ? aiContent.substring(0, 80) + '...' : 'null');
      console.log('[content] 5/6 填充表单字段...');
      reportBatchPhase(batchId, urlIndex, 'filling');
      const manualFillResult = tryFillCommentTextareaWithPromotion(aiContent);
      console.log('[content] BATCH_HANDLE 手动按钮同款填充结果:', manualFillResult);
      // AI 生成完成后再次确认评论框存在（表单可能通过3懒加载在生成期间加载好）
      form = findCommentForm();
      ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      if (!form || !ta) {
        console.log('[content] AI生成后未找到评论框，再次触发展开...');
        await triggerCommentFormFlow();
        await new Promise(resolve => setTimeout(resolve, 2000));
        form = findCommentForm();
        ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      }
      if (!form || !ta) {
        console.log('[content] AI生成后常规找框仍未完成，再次使用手动按钮同款找框逻辑...');
        const manualTargets = await findCommentTargetsForBatchUsingManualFlow(12000);
        form = manualTargets.form;
        ta = manualTargets.textarea;
      }
      // 如果 AI 生成后仍然找不到评论框，记录警告但尝试填充（表单可能只是隐藏了）
      if (!form || !ta) {
        console.warn('[content] AI生成后仍未找到评论框，尝试继续填充（表单可能只是隐藏）');
      }
      // 预检查只验证姓名/邮箱/网站字段是否存在，不验证comment（尚未生成）
      const fillResult = await ensureAllCommentFormFieldsFilled('', true);
      if (!fillResult.success) {
        throw new Error('表单字段缺失: ' + (fillResult.missingFields || []).join(', '));
      }
      const refillResult = await ensureAllCommentFormFieldsFilled(aiContent);
      if (!refillResult.success) {
        throw new Error('表单填充失败: ' + (refillResult.missingFields || []).join(', '));
      }

      const manualCheckBeforeSubmit = detectManualRequiredChallenge(form);
      if (manualCheckBeforeSubmit.found) {
        await reportManualRequiredAndClose(batchId, urlIndex, url, aiContent);
        return;
      }

      // 提交前落盘上下文：页面刷新后新页面据此确认成功
      await persistBatchSubmitContext(batchId, urlIndex, url, aiContent);

      console.log('[content] 7/7 点击提交按钮...');
      reportBatchPhase(batchId, urlIndex, 'submitting');
      const submitWatch = watchSubmitActivity();
      const clickResult = await clickCommentSubmitButton();
      console.log('[content] 点击结果:', clickResult);
      if (!clickResult.success) {
        submitWatch.dispose();
        throw new Error(clickResult.error || '提交按钮点击失败');
      }

      await waitForSubmitCompletion(submitWatch, batchId, urlIndex, url, aiContent);
      console.log('[content] handleBatchTask 完成 <<<', { batchId, urlIndex });
    } catch (err) {
      console.warn('[content] handleBatchTask 捕获错误:', err.message);
      clearBatchSubmitContext();

      // 特殊错误：未找到评论框
      if (err.message === '__NO_COMMENT_BOX__') {
        console.log('[content] 未找到评论框，上报并关闭标签页');
        await writePendingResult(batchId, urlIndex, url, 'no_comment_box', null, '未找到评论框');
        // 使用 BATCH_HANDLE_CONFIRM 触发 background -> batch 的 BATCH_CONFIRMED 流程
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'BATCH_HANDLE_CONFIRM',
            batchId,
            urlIndex,
            url: url || '',
            aiContent: '',
            result: 'no_comment_box',
            errorMessage: '未找到评论框'
          }).then((response) => {
            console.log('[content] no_comment_box BATCH_HANDLE_CONFIRM 响应:', response);
            resolve(response);
          }).catch((err) => {
            if (err.message && err.message.includes('message channel closed')) {
              console.log('[content] 消息通道已关闭（标签页可能已关闭），忽略错误');
            } else {
              console.warn('[content] no_comment_box 发送消息失败:', err);
            }
            resolve(null);
          });
        });
        // 关闭当前标签页
        setTimeout(() => {
          window.close();
        }, 1000);
        return;
      }
      
      await writePendingResult(batchId, urlIndex, url, 'fail', null, err.message || String(err));
      await reportBatchResult(batchId, urlIndex, 'fail', null, err.message || String(err), url);
      // 不主动关闭窗口，等待超时自动关闭
    } finally {
      if (runningBatchTaskKey === taskKey) {
        runningBatchTaskKey = null;
      }
    }
  }

  /**
   * 等待页面关键元素加载
   */
  function waitForPageReady() {
    return new Promise((resolve) => {
      // 等待评论框或页面加载完毕
      const maxWait = 20000;
      const start = Date.now();
      const check = () => {
        if (Date.now() - start > maxWait) {
          console.log('[content] waitForPageReady 超时，继续执行');
          resolve(); // 超时也继续
          return;
        }
        // 检查是否有评论相关元素（包括 textarea、#respond、评论区域等）
        const hasCommentArea =
          document.querySelector(
            'textarea[name*="comment" i], textarea[name*="reply" i], textarea[name*="message" i], ' +
            'textarea[name*="comentario" i], textarea[name*="comentário" i], ' +
            '#comment, #comments, .comment-form, #respond, .respond, .comment-respond, ' +
            '#comments-area, .comments-area, .comentarios, #comentarios, .comentario, ' +
            '.comment-list, .comment-section, .post-comments-area, ' +
            '[contenteditable="true"][class*="comment"], [contenteditable="true"][class*="comentario"]'
          ) ||
          document.querySelector('form[action*="comment"]');

        // 检测 Disqus 评论系统
        const hasDisqus = document.querySelector(
          '#disqus_thread, [id*="disqus"], iframe[src*="disqus"], .dsq-brlink'
        );

        if (hasDisqus) {
          console.log('[content] waitForPageReady 检测到 Disqus，尝试展开...');
          // 尝试点击 Disqus 展开按钮
          const disqusBtn = document.querySelector(
            '#disqus_thread a, [id*="disqus"] a, .dsq-brlink a, ' +
            '#disqus_thread button, [data-disqus-identifier]'
          );
          if (disqusBtn && !disqusBtn.hasAttribute('data-auto-comment-clicked')) {
            disqusBtn.setAttribute('data-auto-comment-clicked', 'true');
            disqusBtn.click();
            console.log('[content] 已点击 Disqus 展开按钮，等待加载...');
            setTimeout(check, 2000); // 等待 Disqus 加载 iframe
            return;
          }
        }

        if (hasCommentArea) {
          console.log('[content] waitForPageReady 检测到评论区域，等待2秒让JS渲染完');
          setTimeout(resolve, 2000); // 额外等2秒让JS渲染完
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * 检查 URL 是否已在 batchResults 中处理过
   */
  async function checkExistingBatchResult(batchId, url, urlIndex) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['batchResults'], (data) => {
        const results = data.batchResults || [];
        // 只要这个 URL 之前成功处理过（不限 batchId），就跳过 AI 生成
        const match = results.find(r => r.url === url && r.result === 'success');
        resolve(match || null);
      });
    });
  }

  /**
   * 上报"已存在评论"状态：跳过 AI 生成，直接写结果并通知 background
   */
  async function reportAlreadyCommented(batchId, urlIndex, url, aiContent) {
    await writePendingResult(batchId, urlIndex, url, 'skipped', aiContent, 'already_commented');
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'BATCH_HANDLE_CONFIRM',
          batchId,
          urlIndex,
          url: url || '',
          aiContent: aiContent || '',
          result: 'skipped',
          errorMessage: 'already_commented'
        }).then(resolve).catch(resolve);
      });
    }
  }

  const MANUAL_REQUIRED_MESSAGE = '检测到验证码/反垃圾验证，请手动填写后提交';
  const MANUAL_REQUIRED_KEYWORDS = [
    'captcha',
    'aiowps-captcha',
    'captcha-answer',
    'anti-spam',
    'antispam',
    'spam',
    'verification',
    'verify',
    'human',
    'robot',
    'answer in digits',
    'enter an answer',
    'answer:',
    'math',
    'equation',
    'security question',
    '验证码',
    '反垃圾',
    '验证'
  ];
  const MANUAL_REQUIRED_WIDGET_SELECTORS = [
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '[data-sitekey]',
    '[name="g-recaptcha-response"]',
    '[name="h-captcha-response"]',
    '[name="cf-turnstile-response"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[title*="reCAPTCHA"]',
    'iframe[title*="captcha"]'
  ];

  function detectManualRequiredChallenge(form) {
    const targetForm = form || findCommentForm();
    if (!targetForm) return { found: false };

    const widget = findManualRequiredWidget(targetForm);
    if (widget) {
      console.log('[AutoComment] 检测到需手动处理的人机验证组件:', {
        tag: widget.tagName,
        className: widget.className,
        src: widget.getAttribute && widget.getAttribute('src'),
        title: widget.getAttribute && widget.getAttribute('title')
      });
      return { found: true, field: widget, message: MANUAL_REQUIRED_MESSAGE };
    }

    const candidateFields = Array.from(targetForm.querySelectorAll('input, textarea, select'))
      .filter((field) => isEmptyField(field) && isVisibleFormField(field));

    for (const field of candidateFields) {
      const text = getFieldContextText(field, targetForm).toLowerCase();
      const isRequiredManualField =
        isRequiredField(field) ||
        isLikelyManualChallengeField(field, targetForm, text);
      if (isRequiredManualField && MANUAL_REQUIRED_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()))) {
        console.log('[AutoComment] 检测到需手动处理的验证/反垃圾字段:', {
          name: field.name,
          id: field.id,
          type: field.type,
          placeholder: field.placeholder,
          context: text.slice(0, 180)
        });
        return { found: true, field, message: MANUAL_REQUIRED_MESSAGE };
      }
    }

    return { found: false };
  }

  function findManualRequiredWidget(root) {
    for (const selector of MANUAL_REQUIRED_WIDGET_SELECTORS) {
      try {
        const node = root.querySelector(selector);
        if (node) return node;
      } catch (_) {}
    }
    return null;
  }

  function isLikelyManualChallengeField(field, form, contextText) {
    const name = (field.name || '').toLowerCase();
    const id = (field.id || '').toLowerCase();
    const className = (field.className || '').toLowerCase();
    const type = (field.type || '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button') return false;

    const text = `${name} ${id} ${className} ${contextText || ''}`;
    if (text.includes('aiowps-captcha') || text.includes('captcha-answer')) return true;
    if (text.includes('answer in digits') || text.includes('enter an answer')) return true;
    if (text.includes('equation') && (text.includes('captcha') || text.includes('='))) return true;

    const container = field.closest && field.closest('p, div, label, section');
    const containerText = ((container && container.textContent) || '').toLowerCase();
    return (
      containerText.includes('please enter an answer in digits') ||
      (containerText.includes('captcha') && containerText.includes('answer')) ||
      (containerText.includes('=') && containerText.includes('answer'))
    );
  }

  function isRequiredField(field) {
    return !!(field && (field.required || field.getAttribute('aria-required') === 'true'));
  }

  function isEmptyField(field) {
    if (!field) return false;
    const tag = (field.tagName || '').toLowerCase();
    const type = (field.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return !field.checked;
    if (tag === 'select') return !field.value;
    return !(field.value || '').trim();
  }

  function isVisibleFormField(field) {
    if (!field || field.disabled) return false;
    const type = (field.type || '').toLowerCase();
    if (type === 'hidden') return false;
    const style = window.getComputedStyle(field);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getFieldContextText(field, form) {
    const parts = [
      field.name,
      field.id,
      field.className,
      field.type,
      field.placeholder,
      field.getAttribute('aria-label'),
      field.getAttribute('title'),
      field.getAttribute('autocomplete')
    ];

    if (field.id && typeof CSS !== 'undefined' && CSS.escape) {
      try {
        const label = form.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) parts.push(label.textContent);
      } catch (_) {}
    }

    const closestLabel = field.closest && field.closest('label');
    if (closestLabel) parts.push(closestLabel.textContent);

    const previous = field.previousElementSibling;
    if (previous && (previous.textContent || '').length < 120) parts.push(previous.textContent);

    const next = field.nextElementSibling;
    if (next && (next.textContent || '').length < 120) parts.push(next.textContent);

    return parts.filter(Boolean).join(' ');
  }

  async function reportManualRequiredAndClose(batchId, urlIndex, url, aiContent) {
    console.log('[content] 检测到需手动处理，上报 manual_required 并关闭网页:', { batchId, urlIndex, url });
    await writePendingResult(batchId, urlIndex, url, 'manual_required', aiContent || null, MANUAL_REQUIRED_MESSAGE);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'BATCH_HANDLE_CONFIRM',
          batchId,
          urlIndex,
          url: url || '',
          aiContent: aiContent || '',
          result: 'manual_required',
          errorMessage: MANUAL_REQUIRED_MESSAGE
        }).then(resolve).catch(resolve);
      });
    }

    setTimeout(() => {
      window.close();
    }, 500);
  }

  /**
   * 将待确认结果写入 storage（页面刷新前同步落盘，batch.js 轮询可立即读到）
   */
  async function writePendingResult(batchId, urlIndex, url, result, aiContent, errorMessage) {
    console.log('[content] writePendingResult >>>', { batchId, urlIndex, url, result, aiContentLen: aiContent ? aiContent.length : 0, errorMessage });
    if (typeof chrome === 'undefined' || !chrome.storage) {
      console.warn('[content] writePendingResult: chrome.storage 不可用');
      return;
    }
    try {
      const data = await new Promise((resolve) => {
        chrome.storage.local.get(['batchResults', 'batchReportedUrls'], (d) => resolve(d));
      });
      const results = Array.isArray(data.batchResults) ? data.batchResults : [];
      const entry = {
        batchId,
        urlIndex,
        url: url || '',
        result,
        aiContent,
        errorMessage,
        timestamp: Date.now()
      };
      const existingIndex = results.findIndex((item) => item.batchId === batchId && item.urlIndex === urlIndex);
      if (existingIndex >= 0) {
        results[existingIndex] = { ...results[existingIndex], ...entry };
      } else {
        results.push(entry);
      }
      if (results.length > 100) results.shift();
      const reported = Array.isArray(data.batchReportedUrls) ? data.batchReportedUrls : [];
      const urlKey = `${batchId}:${urlIndex}`;
      if (!reported.includes(urlKey)) {
        reported.push(urlKey);
        if (reported.length > 500) reported.shift();
      }
      await new Promise((resolve) => {
        chrome.storage.local.set({ batchResults: results, batchReportedUrls: reported }, resolve);
      });
      console.log('[content] writePendingResult <<< 写入完成, 当前results长度:', results.length);
    } catch (e) {
      console.error('[content] writePendingResult 错误:', e);
    }
  }

  // 结果统一走 BATCH_HANDLE_CONFIRM：background 落盘后通知 batch 页关闭标签并继续下一个
  async function reportBatchResult(batchId, urlIndex, result, aiContent, errorMessage, pageUrl) {
    await sendBatchConfirm({ batchId, urlIndex, url: pageUrl || '', result, aiContent: aiContent || null, errorMessage: errorMessage || null });
  }
})();
