# 数据库设计（CloudBase 云数据库）

- 版本：阶段 2
- 说明：以下为集合、字段、索引与权限建议。**本轮未在云环境实际创建**（环境未开通），脚本与控制台步骤见文末。
- 通用约定：时间戳为 ISO-8601 字符串；期号为 7 位字符串；号码为整数升序数组。

## 1. 集合一览

| 集合 | 用途 | 写入方 |
|---|---|---|
| `draw_records` | 官方开奖记录 | 云函数（official_api / owner_csv_import） |
| `draw_rules` | 规则版本与奖级表 | 控制台/脚本，仅人工 |
| `sync_logs` | 每次同步的审计日志 | 云函数 |
| `app_config` | 单用户白名单、功能开关、AI 配置 | **仅控制台人工**，禁止任何云函数写 |
| `candidate_batches` / `candidate_numbers` | 候选批次（阶段 6） | 云函数（受合规闸门） |
| `ticket_records` | 个人号码（阶段 3，已实现） | 云函数 |
| `ticket_checks` | 核对结果（阶段 4，已实现） | 云函数 |
| `ai_conversations` / `ai_messages` | AI 会话（阶段 5，已实现） | 云函数 |

## 2. `draw_records`

```jsonc
{
  "_id": "auto",
  "game": "ssq | kl8",
  "issue": "2026126",                 // 7 位字符串
  "drawDate": "2026-11-03",           // Asia/Shanghai 日期
  "numbers": {
    "red": [9,10,13,22,29,32],        // ssq：6 个；kl8：空数组
    "blue": 12,                       // ssq：1 个；kl8：null
    "kl8": []                         // kl8：20 个；ssq：空数组
  },
  "prizeInfo": {
    "first": {"count":5,"amount":9014860},
    "second": {"count":159,"amount":157816},
    "third": {"count":1412,"amount":3000},
    "fourth": {"count":61720,"amount":200},
    "fifth": {"count":1272146,"amount":10},
    "sixth": {"count":7670635,"amount":5},
    "fuyun": null                     // 特别规定期间才有
  },
  "specialRuleStatus": "unknown",     // active|inactive|unknown|not_applicable
  "ruleVersion": "ssq_2026_02_01",    // 无适用版本时 null
  "sourceUrl": "https://www.cwl.gov.cn/c/2026/11/03/671981.shtml",
  "sourceType": "official_web",       // official_web | manual_official_import
  "sourceApi": "https://.../findDrawNotice",
  "rawHash": "sha256…",
  "parserVersion": "cwl_api@1.0.0",
  "drawStatus": "verified",           // pending|parsed|conflict|verified|corrected
  "verifiedBy": "official_api",       // official_api | owner_csv_import
  "conflictInfo": null,               // 冲突时存 incoming* 字段
  "salesAmount": 342910496,
  "poolAmount": 1074322050,
  "fixedPoolAmount": null,
  "fetchedAt": "2026-11-05T01:35:00.000Z",
  "verifiedAt": "2026-11-05T01:35:00.000Z",
  "createdAt": "…",
  "updatedAt": "…",
  "note": ""
}
```

快乐8 的 `prizeInfo` 结构：

```jsonc
{ "choose10": {
    "hit10": {"count":0,"amount":null},  // 无人中 → amount 必须为 null
    "hit9": {"count":50,"amount":8000},
    "hit8": {"count":715,"amount":720},
    "hit7": {"count":8768,"amount":80},
    "hit6": {"count":68339,"amount":5},
    "hit5": {"count":336264,"amount":3},
    "hit0": {"count":308049,"amount":2} } }
```

**索引**
1. `game(ASC) + issue(DESC)` —— 唯一索引（关键）。若控制台不支持复合唯一索引，则退化为普通复合索引 + 代码内幂等（已实现），并在部署检查表标注风险。
2. `game(ASC) + drawDate(DESC)` —— 列表按年份/日期查询。
3. `drawStatus(ASC)` —— 排查冲突与待核验。

## 3. `draw_rules`

```jsonc
{
  "game": "kl8",
  "ruleVersion": "kl8_2025_12_30",
  "effectiveFromIssue": "2025350",
  "effectiveToIssue": null,
  "prizeTable": { "10": "floating", "9": 8000, "8": 720, "7": 80, "6": 5, "5": 3, "0": 2 },
  "specialRuleConditions": {},
  "sourceUrl": "https://www.scflcp.com.cn/yxgz/823144315.jhtml",
  "verifiedAt": "2026-11-04",
  "status": "active"
}
```

种子数据：`npm run seed:rules`（生成 `data/seed/draw_rules.ndjson`）。代码内置同一份注册表（`shared/rules/registry.js`），DB 版本用于运营调整与审计，两者不一致时以 DB 为准且记录差异（阶段 4 实现）。

**索引**：`game + effectiveFromIssue`。

## 3.5 `ticket_records`（阶段 3 已实现）

```jsonc
{
  "_id": "auto",
  "ownerOpenId": "oXXXX…",             // 服务端写入，前端不可指定
  "game": "ssq | kl8",
  "playType": "single | choose10",
  "issue": "2026127",
  "numbers": { "red": [1,5,9,12,20,33], "blue": 7, "kl8": [] },
  "displayText": "01 05 09 12 20 33 | 07",
  "numberKey": "ssq:1,5,9,12,20,33|7", // 组合去重/查重用
  "recordSource": "manual | candidate_import",
  "candidateId": null,
  "purchaseStatus": "draft | confirmed | void",
  "purchaseAt": null,                  // 确认购买时写入
  "actualCost": null,                  // 元；用户录入，系统不推算
  "multiple": 1,
  "note": "",
  "idempotencyKey": "1699...-ab12",    // 客户端生成，防连点重复创建
  "createdAt": "…", "updatedAt": "…",
  "confirmedAt": null, "voidedAt": null, "voidReason": ""
}
```

**不可违反的规则（已由 `shared/domain/tickets.js` 强制，并有单测）**
1. 新建一律 `draft`，`actualCost` / `purchaseAt` 必须为 `null`。
2. `draft → confirmed` 必须显式调用 `confirm` 且提供实际金额（可为 0，如赠票）。
3. `confirmed` 后 `numbers` / `issue` / `game` 冻结；只允许改 `note` / `actualCost` / `multiple`。
4. `void` 记录只读。
5. 物理删除仅限 `draft` / `void`；`confirmed` 必须先作废。

**索引**
1. `ownerOpenId + createdAt(DESC)` —— 列表主查询。
2. `ownerOpenId + purchaseStatus` —— 状态筛选与计数。
3. `ownerOpenId + idempotencyKey` —— 幂等去重（建议唯一）。
4. `ownerOpenId + game + issue` —— 按期/彩种查（阶段 4 判奖用）。

## 4. `sync_logs`

```jsonc
{
  "game": "ssq|kl8|mixed",
  "mode": "incremental|issue|year|csv_import",
  "startedAt": "…", "finishedAt": "…",
  "sourceUrl": "…",
  "sourceType": "manual_official_import",   // CSV 导入时有值
  "parserVersion": "cwl_api@1.0.0",
  "fetchedCount": 30, "parsedCount": 30,
  "inserted": 3, "unchanged": 27, "conflicts": 0, "errorCount": 0,
  "status": "success|no_change|partial|failed",
  "error": null,
  "createdAt": "…"
}
```

**索引**：`createdAt(DESC)`。

## 4.5 `ticket_checks`（阶段 4 已实现）

```jsonc
{
  "_id": "auto",
  "ticketId": "…",
  "ownerOpenId": "oXXXX…",
  "game": "ssq | kl8",
  "issue": "2026127",
  "drawRecordId": "…",                 // 对应 draw_records._id
  "drawHash": "sha256…",               // 对应 draw_records.rawHash
  "ruleVersion": "ssq_2026_02_01",
  "hitDetails": { "red": 4, "blue": true, "numbers": [1,2,3,4], "blueNumber": 7 },
  "prizeLevel": "5",                   // ssq: 1–6 / fuyun；kl8: 10/9/8/7/6/5/0；待定 null
  "unitPrize": 10,
  "quantity": 1,                       // 来自票面倍数
  "totalPrize": 10,
  "checkStatus": "checked",            // checked | not_winner | pending_manual_review
  "pendingReason": null,               // FUYUN_STATUS_UNKNOWN | PRIZE_AMOUNT_PENDING | NO_RULE_VERSION
  "isWinner": true,
  "idempotencyKey": "ticketId|drawId|ruleVersion|drawHash",
  "recheckOf": null,                   // 重算时指向上一版核对记录
  "checkedAt": "…", "createdAt": "…", "updatedAt": "…"
}
```

**不变量**
1. 只有 `purchaseStatus=confirmed` 的票会产生核对记录。
2. 只使用 `drawStatus=verified|corrected` 的开奖数据。
3. `idempotencyKey` 相同的核对不重复插入（`force` 时原地更新）。
4. 开奖数据更正后：新增一条，`recheckOf` 指向旧的，**不覆盖历史**。
5. 浮动奖未公告时 `totalPrize` 必须为 `null`，不得填 0。

**索引**
1. `idempotencyKey`（唯一）—— 幂等去重。
2. `ticketId + checkedAt(DESC)` —— 取某票最新核对。
3. `ownerOpenId + checkedAt(DESC)` —— 个人核对历史。

> `ticket_records.checkSummary` 是 `ticket_checks` 的**展示缓存**（列表徽标用），每次由 `checkTickets` 重算覆盖，不参与任何判定。判奖唯一依据是 `ticket_checks` 与 `shared/rules/judge.js`。

## 4.8 `ai_conversations` / `ai_messages`（阶段 5 已实现）

`ai_conversations`

```jsonc
{ "_id": "auto", "ownerOpenId": "oXXXX…", "title": "最新一期双色球", "createdAt": "…", "updatedAt": "…" }
```

`ai_messages`

```jsonc
{
  "_id": "auto",
  "sessionId": "…",
  "ownerOpenId": "oXXXX…",
  "role": "user | assistant",
  "content": "…",
  "toolNames": ["get_latest_draw"],
  "toolSummary": [{ "name": "get_latest_draw", "ok": true }],
  "modelName": "deepseek-flash",
  "promptVersion": "ai_system@1.0.0",
  "usage": { "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120 },
  "rounds": 2,
  "stoppedReason": null,
  "createdAt": "…"
}
```

**不变量**
1. 只存 `ownerOpenId` 与会话内容，**绝不存 API Key、请求头或完整环境变量**。
2. 读取历史时强制 `ownerOpenId` 过滤；拿别人的 sessionId 会自动新建会话。
3. `promptVersion` 必填，便于回溯某次回答用的是哪版提示词。

**索引**：`ownerOpenId + updatedAt(DESC)`；`sessionId + createdAt(ASC)`。

## 4.9 `candidate_batches`（阶段 6；Web 版为浏览器本地库）

> 小程序版未创建此集合（主线已迁到静态站，见 decisions.md D20）。
> 静态站里它存在 IndexedDB 的 `candidates` 对象仓库，**不在云端**。

```jsonc
{
  "_id": "b_xxx",
  "ownerOpenId": "local",
  "game": "ssq",                    // ssq | kl8
  "strategy": "random",             // random | balanced | preference
  "count": 3,
  "targetIssue": "2026127",         // 可为 null，导入时必填
  "algorithmVersion": "candidate@1.0.0",
  "randomSeed": 3472741477,         // uint32；用于复现
  "seedGenerated": false,           // true = 种子由系统生成
  "parameterSnapshot": { "include": [], "exclude": [], "blueFixed": null },
  "complianceState": "self_attested_personal_use",
  "createdAt": "…",
  "groups": [
    { "index": 0, "numbers": { "red": [4,6,13,15,26,33], "blue": 12, "kl8": [] },
      "key": "4,6,13,15,26,33|12", "displayText": "04 06 13 15 26 33 + 12" }
  ],
  "importedAt": null,
  "importedTicketIds": [],
  // 仅 analyzed 策略：
  "analysis": {
    "avoidPatterns": true, "avoidRepeat": true, "includeCold": 1,
    "maxCrowdIndex": 92, "sumRange": [75, 130], "oddRange": [2, 4],
    "coldNumbers": [11, 27], "crowdModelVersion": "crowd@1.0.0",
    "sampleCount": 600, "previousIssue": "2026126"
  },
  "crowdSummary": [{ "index": 0, "crowdIndex": 42, "level": "medium_low", "reasons": ["…"] }],
  "tradeoff": { "avgCrowdIndex": 44.7, "sumRange": [104, 117], "withHighNumber": 3, "withConsecutive": 0 }
}
```

**不变量**
1. `groups` 组间必须互不相同（`verifyBatch` 会校验，重复即拒）。
2. 导入只生成 `purchaseStatus: 'draft'` 的 `ticket_records`，`actualCost`/`purchaseAt` 为 `null`。
3. `algorithmVersion` 不匹配的批次拒绝导入（避免用旧算法结果冒充当前规则）。
4. `complianceState` 记录生成当时的闸门状态，便于回溯"这批是在什么授权下生成的"。
5. `analysis.coldNumbers` 与 `sampleCount` 一并入库：没有它就无法复现"为什么挑了这几注"。
6. `crowdSummary[].crowdIndex` 是**推定值**（见 `docs/analysis-model.md`），不得当作实测投注人数。

**索引**：无需额外索引（按 `createdAt` 内存排序即可；本地数据量级为几十到几百条）。

## 5. `app_config`

固定文档 `_id = "global"`（单文档配置）：

```jsonc
{
  "_id": "global",
  "ownerWhitelist": ["oXXXX…"],          // 唯一所有者 OpenID
  "wxComplianceStatus": "not_checked",   // not_checked|pending|approved|rejected
  "candidateGenerationEnabled": false,
  "aiFutureNumberFeatureEnabled": false,
  "productionFeaturePolicy": "compliance-gated",
  "syncEnabled": true,
  "fuyunEmptyMeansInactive": false,      // 见 data-source-plan 3.2
  "aiEnabled": true,
  "modelName": "deepseek-flash",
  "updatedAt": "…"
}
```

## 6. 权限设置（关键）

云开发数据库权限只有四档，选择如下：

| 集合 | 客户端读 | 客户端写 | 说明 |
|---|---|---|---|
| `draw_records` | **不可读** | 不可写 | 全部经 `queryDraws` 云函数 |
| `draw_rules` | 不可读 | 不可写 | 经云函数读取 |
| `sync_logs` | 不可读 | 不可写 | — |
| `app_config` | **不可读** | 不可写 | 白名单泄露即等于给出攻击面 |
| 其余（阶段 3+） | 不可读 | 不可写 | 统一"仅创建者可读写"也不要选，因为需要的是"仅云函数" |

控制台操作：数据库 → 集合 → 权限设置 → **"所有用户不可读写"**（即仅管理端/云函数可访问）。
理由：前端隐藏页不构成安全边界（主方案 14.1），一旦客户端可读 `draw_records`，非白名单用户拿到 AppID 即可直接拉数据。

## 7. 初始化步骤（用户执行）

1. 云开发控制台 → 数据库 → 新建集合：`draw_records`、`draw_rules`、`sync_logs`、`app_config`、`ticket_records`、`ticket_checks`、`ai_conversations`、`ai_messages`（也可用 `initDb` 一键创建）。
2. 每个集合权限设为"所有用户不可读写"。
3. `draw_records` 建索引：`game ASC, issue DESC`（唯一）；`game ASC, drawDate DESC`；`drawStatus ASC`。
4. `ticket_records` 建索引：`ownerOpenId ASC, createdAt DESC`；`ownerOpenId ASC, purchaseStatus ASC`；`ownerOpenId ASC, idempotencyKey ASC`（唯一）。
5. `ticket_checks` 建索引：`idempotencyKey ASC`（唯一）；`ticketId ASC, checkedAt DESC`；`ownerOpenId ASC, checkedAt DESC`。
6. `sync_logs` 建索引：`createdAt DESC`。
7. 导入规则：`npm run seed:rules` → 控制台导入 `draw_rules`。
8. 新建 `app_config` 文档，`_id` 填 `global`，内容按第 5 节，先用 `ownerWhitelist: []`，把 `authCheck` 返回的 OpenID 填进去。
9. 上传部署九个云函数（均选"云端安装依赖"）：
   `authCheck`、`initDb`、`syncDraws`、`queryDraws`、`importDraws`、`ticketService`、`queryTickets`、`checkTickets`、`aiChat`。
   部署后在「设置」页点「一键初始化数据库」，可自动完成第 1–7 步中的集合、配置与规则种子；索引仍需手工补建。

## 8. 数据量与成本估算

| 彩种 | 期数（全量） | 单条大小 | 合计 |
|---|---|---|---|
| 双色球 | ~2084 | ~0.8 KB | ~1.7 MB |
| 快乐8 | ~2115 | ~2.4 KB | ~5.1 MB |

合计约 7 MB，远低于免费额度。同步日志按每日 2 条计，一年约 730 条，可忽略。
