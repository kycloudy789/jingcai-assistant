# 开奖数据来源与采集方案

- 最近核实：2026-11-05（**已实际抓取验证，非推断**）
- 适用：双色球（ssq）、快乐8（kl8，只取开奖号码，玩法仅做选十）
- 结论：不存在带文档的官方开奖 API，但**存在由中国福彩网自身页面调用的公开 JSON 接口**。采用"官方 JSON 接口（主）+ CSV 手动导入（兜底）+ 人工核验（最终）"三层结构。

## 0. 对早期判断的更正（重要）

阶段 1 曾记录"`www.cwl.gov.cn/ygkj/wqkjgg/{ssq|kl8}/` 是服务端渲染 HTML，含开奖号码"。**该判断错误。** 实测该页面 HTML（59,729 字节）内**不含任何期号与号码**，数据由前端脚本异步加载。抓取原始 HTML 解析号码的做法不可行，已放弃。

真正的数据入口是页面内联定义的 `frontAppContext` 指向的 JSON 接口（见下）。

## 1. 来源优先级

| 优先级 | 来源 | 用途 | 核实情况 |
|---|---|---|---|
| 1 | 中国福彩网公开 JSON 接口（`/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice`） | 主数据源、增量同步 | **已实测可用**，返回期号/日期/号码/各奖级注数与金额/销售额/奖池 |
| 2 | 省级福彩官网公告页 | 交叉核验 | 未实测（后续按需） |
| 3 | 本人导入官方公告 CSV | 兜底、补历史、修正 | 模板与导入云函数已就绪 |
| — | 第三方聚合站/私有接口 | **不使用** | 授权与稳定性不可控 |

## 2. 接口事实（实测记录，改动前必须重新验证）

```
GET https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice
参数：name=ssq|kl8  issueCount=N  issueStart=2026001  issueEnd=2026999
      dayStart / dayEnd  pageNo  pageSize  week  systemType=PC
```

| 实测项 | 结果 | 代码中的应对 |
|---|---|---|
| 是否需要 Referer/UA | 不需要 Referer；普通 UA 可返回 200 | 仍带 UA 便于识别来源；超时 15s |
| `pageSize` | 双色球有效；**快乐8 完全忽略** | 所有查询必须带 `issueCount` 或期号区间 |
| 不带 `issueCount` 的快乐8 | 返回全部 2115 期，**5.28 MB** | 云函数限制响应体 6MB 并中止，防止 OOM |
| `pageNo` | 双色球有效；**快乐8 无效** | 禁止用翻页遍历快乐8历史；按年度区间取 |
| 年度区间取数 | 快乐8 2026 年 294 期 ≈ 730KB；双色球 2026 年 126 期 ≈ 100KB | `mode=year` 一次一年 |
| `issueCount` 上限 | 代码内限制 100 期/次 | `MAX_ISSUE_COUNT` |
| 期号起点 | 双色球 total 2084（约 2003 起）；快乐8 total 2115（2020 起） | 不做期号推算 |

### 2.1 响应字段映射

| 接口字段 | 说明 | 映射 |
|---|---|---|
| `code` | 期号，7 位字符串 | `issue`（保持字符串） |
| `date` | `2026-11-03(二)` | `drawDate` = `2026-11-03`（星期丢弃） |
| `red` | 双色球 6 红 / 快乐8 20 个，逗号分隔两位数 | `numbers.red` / `numbers.kl8`（整数升序数组） |
| `blue` | 双色球蓝球；快乐8 为空串 | `numbers.blue` |
| `sales` | 销售额 | `salesAmount` |
| `poolmoney` | 奖池；快乐8 为浮动奖奖池 | `poolAmount` |
| `gdjc` | 快乐8 固定奖奖池 | `fixedPoolAmount` |
| `prizegrades[].type` | 双色球 `1..6`；快乐8 `x10z10`…`x10z0` 等 | 双色球 → `prizeInfo.first..sixth`；快乐8 只取 `x10z*` → `prizeInfo.choose10` |
| `prizegrades[].typenum` / `typemoney` | 注数 / 单注金额（字符串） | `{count, amount}` |
| `fyjCount` / `fyjMoney` | 双色球福运奖注数 / 单注金额 | `prizeInfo.fuyun`，并用于判定 `specialRuleStatus` |
| `detailsLink` | 相对路径 | `sourceUrl` = `https://www.cwl.gov.cn` + 该路径 |

### 2.2 两个必须防的坑

1. **快乐8 "中 10" 无人中时返回 `typenum="0"`、`typemoney="0"`**。
   这不是"单注奖金 0 元"，而是"当期无人中、无公告金额"。系统映射为 `{count: 0, amount: null}`，前端显示"浮动奖（当期无人中或未公告）"。若误当 0 元，会把中奖算成没奖。
2. **双色球一等奖存在单注封顶**。
   实测 2026119 期为 2 注 × 10,000,000 元。任何"固定按奖池比例推算"的做法都是错的，必须读 `prizegrades.typemoney`。

## 3. 字段与状态

```jsonc
{
  "game": "ssq",
  "issue": "2026126",
  "drawDate": "2026-11-03",
  "numbers": { "red": [9,10,13,22,29,32], "blue": 12, "kl8": [] },
  "prizeInfo": { "first": {"count":5,"amount":9014860}, "second": {"count":159,"amount":157816}, "...": "..." },
  "specialRuleStatus": "unknown",        // active | inactive | unknown | not_applicable
  "ruleVersion": "ssq_2026_02_01",       // 由 issue 解析，采集器不赋值
  "sourceUrl": "https://www.cwl.gov.cn/c/2026/11/03/671981.shtml",
  "sourceType": "official_web",
  "sourceApi": "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice",
  "rawHash": "sha256(原始 JSON 单项)",
  "parserVersion": "cwl_api@1.0.0",
  "drawStatus": "verified",              // pending | parsed | conflict | verified | corrected
  "verifiedBy": "official_api",          // official_api | owner_csv_import
  "fetchedAt": "2026-11-05T01:35:00.000Z",
  "verifiedAt": "2026-11-05T01:35:00.000Z"
}
```

### 3.1 `verified` 的确切含义

`verified` = **来自官方接口 + 通过格式/范围/期号/日期校验**。
它**不**代表"已与第二个来源交叉核对"。跨站核对尚未实现，因此不得对外宣称双重核验。

### 3.2 福运奖状态判定（决策 D11）

| 条件 | 结果 |
|---|---|
| 该期 `fyjMoney > 0` | `active` |
| 期号 < 2026014 | `not_applicable` |
| 其余（含字段为空） | `unknown`（默认，转人工） |
| 其余 + 配置 `fuyunEmptyMeansInactive=true` | `inactive` |

默认选 `unknown` 的理由：奖池曾达 15 亿后回落到 10 亿时，特别规定**仍在执行**，仅凭奖池金额无法反推是否执行；空字段也可能因公告延迟而缺失。宁可转人工，不可错判。

**启用 `inactive` 的前提**：你已核对连续若干期官方公告，确认"该字段为空 ⇔ 未执行特别规定"。确认后把 `app_config.fuyunEmptyMeansInactive` 置为 `true`，即可让"恰好 3 红"的票据自动判为不中奖。

## 4. 校验规则（不通过则不写 verified）

双色球：恰好 6 个红球 ∈[1,33] 互不重复升序；恰好 1 个蓝球 ∈[1,16]。
快乐8：恰好 20 个号码 ∈[1,80] 互不重复升序。
通用：
1. `game + issue` 唯一；重复抓取做幂等 upsert，内容一致只更新 `fetchedAt`。
2. 内容不一致 → `conflict`，保留旧号码并把新数据存入 `conflictInfo`，**不静默覆盖**。
3. 开奖日期必须为合法日历日（拒绝 `2026-02-31`，防 Date 自动进位）且不晚于当前 +1 天。
4. 解析失败 → 不写任何默认号码，记 `sync_logs` 失败。
5. 金额缺失 → `null`，前端显示"待官方公告"，**禁止估算或补 0**。

## 5. 状态机

```
pending ─解析成功→ parsed ─全部校验通过→ verified ─官方更正→ corrected
   │                  │
   └解析失败──────────┴─内容冲突→ conflict（仅人工处理，不参与判奖）
```

## 6. 同步策略

| 模式 | 参数 | 用途 |
|---|---|---|
| `incremental` | `issueCount`（默认 30，上限 100） | 日常增量，覆盖约 10 天（快乐8 每日开奖） |
| `issue` | `issueStart`/`issueEnd` | 补某一期、指定区间 |
| `year` | `issueStart=YYYY` | 补一整年历史（双色球 ~126 期，快乐8 ~294 期） |

- 手动：开奖页「同步最新」。
- 定时：建议每日 22:30 与次日 09:00 各一次（阶段 7 配置触发器）；避开 21:15–21:30 开奖直播时段。
- 失败：保留旧数据，`sync_logs` 记失败原因，前端显示上次成功时间。

## 7. CSV 导入（兜底）

模板：`data/samples/draws_template.csv`（含 2 条官方公开数据样例，已标注来源）。

```bash
node scripts/import-draws.js my-draws.csv --out data/import/draws.ndjson
```

脚本会逐行校验、列出被跳过的行与原因，并输出可直接在云开发控制台导入 `draw_records` 的 NDJSON。导入记录 `verifiedBy=owner_csv_import`，与接口来源可区分。

## 8. 失败与人工兜底

| 故障 | 表现 | 处理 |
|---|---|---|
| 站点不可达/超时 | `FETCH_FAILED` | 保留旧数据；提示可用 CSV 导入 |
| 接口改版/字段变化 | 解析错误集中出现 | `parserVersion` 升版本；保留错误样本；CSV 兜底 |
| 奖金未公布 | 号码有、金额空 | `verified` 但金额 `null`，判奖显示待公告 |
| 与公告不一致 | 内容冲突 | `conflict`，不判奖，人工裁定 |
| 休市/延期 | 期号跳空 | 不做期号+1 推算，等待官方数据 |

## 9. 合规与访问纪律

- 低频访问：单次同步 ≤ 1 请求；年度补数据按年串行，不并发。
- 不绕过验证码/登录；不伪造 Referer 规避风控。
- 存 `sourceUrl` 与 `rawHash`，可回溯到官方页面。
- 接口为官方站点自用接口，**无稳定性承诺**；这也是保留 CSV 兜底的根本原因。
