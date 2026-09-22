# AutoComment

Chrome (Manifest V3) 扩展：导入一批博客文章 URL，逐页识别评论框，用你自己的 OpenRouter 模型生成与文章相关的评论，填写昵称/邮箱/网站并（可选）自动提交。

插件完全在本地运行，不依赖任何私有后端，没有账号、积分或付费功能。

## 安装

1. 下载或克隆本仓库。
2. 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择仓库根目录。
4. 点击工具栏中的 AutoComment 图标，打开批量页面。

## 配置

批量页面顶部的「模型与网站配置」：

| 字段 | 说明 |
| --- | --- |
| OpenRouter API Key | 在 <https://openrouter.ai/keys> 创建 |
| OpenRouter 模型 ID | 例如 `openai/gpt-4o-mini`、`anthropic/claude-sonnet-5`，完整列表见 <https://openrouter.ai/models> |
| 推广网站 URL | 评论表单「网站」字段填写的地址，也会提供给模型作为参考 |
| 网站介绍 | 简述网站内容，模型只在相关时自然提及 |
| 评论昵称 / 评论邮箱 | 填入评论表单 |

填好 Key 和模型 ID 后点击 **测试连接**：插件会保存当前配置，并通过后台向 OpenRouter 发送一条测试消息，显示实际使用的模型、耗时和模型回复。401 / 402 / 429 等错误会原样显示 OpenRouter 返回的信息。

所有配置只保存在本机 `chrome.storage.local`，不会同步到其他设备。

## CSV 格式

只读取第一列，其他列忽略。首行等于 `url`（不区分大小写）时视为表头。

```csv
url
https://blog.example.com/some-post
example.org/another-post
```

- 没有协议的地址自动补 `https://`
- 无效地址跳过，重复地址去重，导入时会提示数量

## 执行行为

- 任务严格串行：同一时间只打开一个标签页。
- 每页流程：等待加载 → 非法站点检测 → 查找评论框 → 检测验证码 → 调用 OpenRouter 生成评论 → 填写表单 → 提交。
- 提交完成的判定：点击提交后，若页面刷新，由刷新后的页面确认成功；若 10 秒内没有刷新，同样按已提交确认。两条路径只会确认一次。
- 确认后关闭当前标签页，再打开下一个 URL。
- 「单页超时」覆盖找评论框、生成等所有阶段，超时记为失败。
- 结果表可按结果、站点、耗时、关键词筛选，并导出 CSV（首列为完整 URL，可直接再次导入）。

## 隐私与安全

- 只有扩展后台（`background.js`）会访问网络，且只访问 `https://openrouter.ai/api/v1/chat/completions`。
- 发送给 OpenRouter 的内容：当前页面 URL、标题、描述、截断后的正文摘要，以及你填写的网站 URL 和介绍。OpenRouter 及下游模型提供方如何处理这些数据，请参阅它们的隐私政策。
- API Key 只放在请求的 `Authorization` 头里，不会返回给页面脚本，也不会写入结果或导出文件；错误信息中若回显 Key 会被替换。
- 局限：`chrome.storage.local` 并未加密，能访问你浏览器配置目录的程序可以读到 Key。建议在 OpenRouter 为本插件单独创建 Key 并设置额度上限。
- 自动提交评论前请确认目标站点的评论规则，避免发布垃圾内容。

## 开发

```bash
npm test
```

测试使用 Node.js 内置测试运行器，无需安装依赖。
