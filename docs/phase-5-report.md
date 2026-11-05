# 阶段 5 报告：DeepSeek AI 助手

- 日期：2026-11-05
- 范围：只读工具白名单、调用编排、DeepSeek 接入、会话存储、AI 对话页
- 结论：**代码与测试在本地全部完成（202 用例全绿）**；真实 API 联调待用户在云端配置 `DEEPSEEK_API_KEY`

## 1. 能力边界

AI 能做的事 = 7 个只读工具，没有第 8 个：

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `get_latest_draw` | 最新一期**已核验**开奖 | 只读 verified/corrected；否则明确说没有 |
| `get_draws` | 按期号或最近 N 期 | N ≤ 20；期号必须 7 位 |
| `get_my_tickets` | 本人号码记录 | 身份服务端注入；返回前剥离 `ownerOpenId` |
| `get_my_ticket_stats` | 本人统计 | 金额只算已填写；奖金**只从 `ticket_checks` 汇总** |
| `get_number_stats` | 频次/遗漏 | 窗口 30/50/100；必须说明样本数 |
| `get_ticket_check` | 某条记录的核对结果 | 不是本人的票 → NOT_FOUND |
| `get_rule_info` | 规则版本与奖级表 | 旧期无版本时明确拒绝 |

**没有**写库、删库、改奖级、改开奖数据、任意 SQL 的工具。模型即使请求 `run_sql`，也会被白名单拒绝（有测试）。

## 2. 防失控参数

| 项 | 值 | 目的 |
|---|---|---|
| 工具轮次 | 3 轮 | 防止反复查询 |
| 单轮工具数 | 4 | 防止一次并发炸开 |
| 总工具调用 | 8 | 成本上限 |
| 单次超时 | 25s | 不拖死云函数 |
| 输出 tokens | 900 | 控制费用 |
| 输入长度 | 1000 字 | 控制提示词成本 |
| 历史消息 | 最近 10 条 | 控制上下文 |
| 轮次用尽 | 不带工具再请求一次总结 | 避免用户收到空回复 |

## 3. 交付物

| 类别 | 文件 | 说明 |
|---|---|---|
| 提示词 | `shared/ai/prompt.js` | 版本化 `ai_system@1.0.0`，11 条硬规则 |
| 工具定义 | `shared/ai/tools.js` | 7 个 schema + 参数白名单校验 |
| 编排 | `shared/ai/orchestrator.js` | 纯逻辑循环，可被假模型测试 |
| 协议层 | `shared/ai/deepseek.js` | 请求体构造、响应解析、HTTP 错误映射 |
| 执行器 | `shared/cloud/aiTools.js` | 只读查询，身份注入，异常转 `ok:false` |
| 云函数 | `cloudfunctions/aiChat` | 会话管理、密钥读取、调用编排、消息落库 |
| 页面 | `pages/assistant` | 对话、建议问题、工具使用痕迹、错误分型提示 |
| 文档 | `docs/db-schema.md` | `ai_conversations` / `ai_messages` |
| 决策 | `docs/decisions.md` | D18（只读+身份注入）、D19（成本上限） |

## 4. 测试结果（真实输出）

```
$ npm test
1..202
# tests 202
# pass 202
# fail 0
```

本轮新增 47 例：

- **工具校验 11 例**：仅 7 个只读工具、schema 结构、未知工具拒绝、彩种/期号/窗口/状态枚举、limit 夹取、字符串参数解析、伪造 `userId` 被丢弃。
- **编排 7 例**：一轮工具后作答、无工具直接答、轮次用尽后不带工具总结、工具抛错不中断、业务拒绝仍回传、预算截断、assistant 消息结构规范化。
- **执行器 13 例**：只取已核验、无数据如实拒绝、归属隔离、状态过滤、`ownerOpenId` 剥离、核对结果三态、统计口径（金额 4+6=10、未填不算；奖金只认核对 6000、他人不计）、频次与遗漏口径、旧期规则拒绝。
- **aiChat 8 例**：缺密钥降级、AI 关闭、普通问答落库两条消息、工具调用后作答（含工具结果回填断言）、401 统一错误码且不泄露响应体、输入过长、空消息、他人 sessionId 自动新建。
- **协议 7 例**：内容/工具调用解析、空 choices、错误体、HTTP 状态映射、输入边界、模型名白名单、请求体构造。

## 5. 关键实现点

1. **密钥永不落地**：只从 `process.env.DEEPSEEK_API_KEY` 读；错误信息里只说"配置有问题"，不回声 key；消息记录里不存请求头。
2. **错误分型**：`AI_NOT_CONFIGURED` / `AI_AUTH_FAILED` / `AI_QUOTA` / `AI_RATE_LIMIT` / `AI_TIMEOUT` / `AI_UPSTREAM`，前端分别给人话提示，而不是"未知错误"。
3. **AI 故障不影响主功能**：aiChat 失败只影响对话，开奖浏览与判奖结果完全独立。
4. **会话隔离**：拿别人的 `sessionId` 会被判定不存在并新建自己的会话（有测试）。
5. **模型名配置化**：`app_config.modelName`，只接受 `deepseek-*` 形式，默认 `deepseek-flash`。
6. **工具痕迹可见**：每条回答下方显示"已查询：get_latest_draw"，用户能判断结论来自哪个数据查询。

## 6. 未验证项

| 项 | 原因 |
|---|---|
| 真实 DeepSeek 调用（模型是否按预期调工具、中文措辞） | 需 `DEEPSEEK_API_KEY`（U5） |
| 云函数出网到 `api.deepseek.com` | 云环境未开通（U2） |
| 长对话下的页面滚动与输入法遮挡 | 需真机（U1） |

## 7. 已知问题

1. 模型可能选择不调工具直接回答"我无法查询"——这是可接受的保守行为，但体验上不如主动调用。目前靠 system prompt 强制"问最新开奖必须调 get_latest_draw"。
2. 没有"清空全部会话"的批量接口，只有前端「新对话」（换 sessionId）。数据保留在原会话里，阶段 7 会补删除能力。
3. Token 用量只记录不设总额度告警，阶段 7 可加日限额。

## 8. 下一阶段（阶段 6）计划

**前置：合规闸门。** 候选号码生成属微信审核高风险，`wxComplianceStatus !== 'approved'` 时只能开发环境可用。

1. `generateCandidates` 云函数：random / balanced / preference 三策略，默认 3 组且组间不重复。
2. 候选批次留痕：`targetIssue`、`algorithmVersion`、`parameterSnapshot`、`randomSeed`，开奖后不可改。
3. 候选导入 → 只生成 `draft`，不自动确认购买。
4. 每次调用都重新校验服务端开关；前端入口仅作展示。
5. 测试：组间去重、约束过严时报错而非硬凑、关闭时 `FEATURE_DISABLED`。
