# 用 Claude API 运行 SuperX（fork 新增功能）

这个 fork 在原有的三种 Grok 连接方式之外，新增了第四种：**Claude API Key**。它使用你自己的 Claude API 额度，比如 Claude Max 订阅每月附带的 $100 API 额度。

## 使用前提

- 额度要在 **Claude Console**（platform.claude.com）里，也就是"账单 → 促销额度"中能看到的那一笔。Claude Pro/Max 的聊天用量不能给第三方插件使用。
- Max 订阅的月度 API 额度**不能留到下个周期**，到期作废。额度用完后，如果没有添加付款方式或开启自动充值，Anthropic 会直接停止请求，不会扣你的卡。

## 设置步骤

1. 在 Claude Console 中，进入**持有额度的那个组织**，在"API Keys"页面创建一个 Key（以 `sk-ant-` 开头）。建议单独为 SuperX 创建一个，方便查看用量。
2. 打开 SuperX **设置 → 连接方式**，选择 **Claude API Key**，粘贴 Key 后保存。Key 用 AES-GCM 加密后只保存在本机。
3. 根据需要调整：
   - **Claude 模型**：默认 Haiku 5.5（最便宜）。可以换成 Sonnet 5.5 或 Opus 5.5，回答更强但更贵。
   - **思考强度**：低 / 中（默认）/ 高。
   - **每次核查最多网页搜索次数**：默认 3 次。每次搜索约 $0.01，另外再算 Token 费用。
   - **每个周期的花费上限**：默认 $100，填 0 表示不限制。
   - **每月重置日**：默认 15 号，请填成你的额度过期日。

## 触发方式

选 Claude 时，**默认只有点击帖子上的 SuperX 按钮才会核查**，刷到帖子不会自动核查。想要自动核查的话，可以勾选"也允许自动核查"。你保存的 Grok 触发设置不受影响，切回 Grok 时照常生效。

草稿核查（发帖或回复编辑框旁边的 SuperX 按钮）本来就是手动触发的，Claude 模式下照常可用。

## 花费估算

- 每次请求结束后，SuperX 会根据返回的 Token 数和搜索次数，按官方价格估算花费，并累计到"本周期已用"。
- 累计金额达到上限后，新的 Claude 请求会被拦下，提示"已达到本周期的 Claude 花费上限"。
- 这只是**估算**，实际用量和余额以 Claude Console 为准。
- 粗略参考：Haiku 5.5 每次核查约 $0.02～0.03，大部分花在搜索上；Sonnet 5.5 约 $0.07；Opus 5.5 约 $0.12。

## 和 Grok 的区别

- Claude 能搜索网页，但**没有 X 搜索**，也基本打不开 x.com 的帖子页面。所以它核查的是你屏幕上显示的帖子文字和图片（插件从页面读取后交给 Claude），再用网页搜索找证据。
- 原帖被折叠（"显示更多"）或图片读取失败时，Claude 会在回答里说明哪一部分没能读到。

## 技术说明

- 新文件 `extension/claude-transport.js`：负责把共用的核查提示词转换成 Claude Messages API 的请求格式，解析流式返回，并估算花费。
- `extension/api-provider.js` 新增了 `runClaudeStage`。重试、保留部分答案、语言检查和历史记录等逻辑都和 Grok 共用。
- 请求直接从扩展的后台发往 `https://api.anthropic.com/v1/messages`，所以 `manifest.json` 增加了这个域名的访问权限。
- 测试：`tests/claude-provider.test.js`，以及 `tests/background.test.js` 末尾的两项 Claude 测试。
