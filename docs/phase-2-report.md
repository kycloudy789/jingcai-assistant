# 阶段 2 报告：开奖数据接入

- 日期：2026-11-05
- 范围：开奖数据结构、官方适配器、CSV 兜底导入、校验与冲突处理、同步日志、开奖列表/详情页
- 结论：**数据链路已用真实官方数据端到端验证通过**；云环境部署与页面渲染仍未验证（开发者工具未安装、CloudBase 未开通）

## 1. 重要更正

阶段 1 断言"往期公告页是服务端渲染 HTML，含号码"——**错误**。
实测该页 HTML 内无任何期号/号码，数据由前端脚本请求
`https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice` 获得（JSON）。
已据此改写适配器与 `docs/data-source-plan.md`，并在 `docs/decisions.md` 记为 D10。

## 2. 交付物

| 类别 | 文件 | 说明 |
|---|---|---|
| 适配器 | `shared/adapters/cwl.js` | 官方接口映射、查询构造、响应外壳校验、内容指纹 |
| 校验 | `shared/validators/draws.js` | 记录级校验（期号/日期/号码/金额/状态） |
| 规则 | `shared/rules/registry.js` | 规则版本注册表、按期号解析、奖级表查询 |
| CSV | `shared/parsers/csv.js` | 零依赖 CSV 解析/导出（引号、BOM、CRLF） |
| 云函数 | `cloudfunctions/syncDraws` | 抓取→映射→校验→幂等入库→写日志 |
| 云函数 | `cloudfunctions/queryDraws` | 列表/详情/元信息（最新期号、上次同步） |
| 云函数 | `cloudfunctions/importDraws` | CSV 兜底导入（支持 dryRun 预览） |
| 云端公共 | `shared/cloud/base.js`、`shared/cloud/drawStore.js` | 鉴权外壳、幂等入库、冲突标记、日志 |
| 前端 | `pages/draws`、`pages/draw-detail`、`pages/home` | 列表（彩种/年份/分页/下拉刷新/同步）、详情（奖级表、来源、核验状态）、首页最新开奖 |
| 脚本 | `scripts/import-draws.js`、`seed-rules.js`、`verify-pipeline.js` | 本地校验转换、规则种子、端到端自检 |
| 文档 | `docs/db-schema.md` | 集合、字段、索引、**权限必须设为"仅云函数可读写"** |
| 测试 | `tests/cwl-adapter.test.js`、`csv.test.js`、`rules.test.js`、`draw-store.test.js` | 81 个用例 |

## 3. 测试结果（真实输出）

```
$ npm test
1..81
# tests 81
# pass 81
# fail 0
```

```
$ node scripts/verify-pipeline.js ssq 5
[1/5] 请求官方接口: ...findDrawNotice?name=ssq&...&issueCount=5
      返回 5 条
[2/5] 映射与校验
      通过 5/5
[3/5] 首次入库
      新增 5 / 未变 0 / 冲突 0 / 错误 0
[4/5] 重复同步（幂等性）
      新增 0 / 未变 5 / 冲突 0
      库内条数 5 → 幂等 ✓
[5/5] 展示渲染
      2026126 2026-11-03  09 10 13 22 29 32 | 12  规则=ssq_2026_02_01
      2026125 2026-11-01  04 06 10 15 26 27 | 11  规则=ssq_2026_02_01
      2026124 2026-10-29  03 11 17 22 23 29 | 09  规则=ssq_2026_02_01

✓ 端到端自检通过（真实官方数据）
```

```
$ node scripts/verify-pipeline.js kl8 5
      返回 5 条 / 通过 5/5 / 新增 5 / 重复同步 新增 0 未变 5 → 幂等 ✓
      2026294 2026-11-04  03 07 10 16 21 25 29 33 35 43 45 52 58 60 64 68 69 72 76 80
✓ 端到端自检通过（真实官方数据）
```

## 4. 关键实现点

1. **快乐8 接口坑位已封堵**：不带 `issueCount` 会返回 2115 期 / 5.28MB。`buildQueryUrl` 只允许三种模式，`issueCount` 上限 100；云函数对响应体设 6MB 上限并在超限时中止。
2. **`typenum=0` 不等于奖金 0 元**：快乐8 "中 10" 无人中时官方返回 `0/0`，映射为 `{count:0, amount:null}`，单测锁定。
3. **不静默覆盖**：同 `game+issue` 内容变化 → `drawStatus=conflict`，旧号码保留，新数据存 `conflictInfo`，单测锁定。
4. **幂等**：重复同步 `inserted=0, unchanged=n`，端到端实测通过。
5. **福运奖不猜**：默认 `unknown`，仅在官方带出 `fyjMoney>0` 时判 `active`；配置项 `fuyunEmptyMeansInactive` 由用户核对公告后自行开启。
6. **日期防进位**：`2026-02-31` 会被 `Date` 自动进位为 3 月，已做反校验并拒绝。
7. **小程序端不含云依赖**：`shared/cloud/**` 同步时排除，测试断言小程序包内无 `wx-server-sdk` 字符串。

## 5. 未验证项

| 项 | 原因 |
|---|---|
| 云函数在 CloudBase 运行时是否可出网访问 `www.cwl.gov.cn` | 环境未开通（U2）。若被出网策略拦截，`syncDraws` 会返回 `FETCH_FAILED`，此时改用 CSV 导入 |
| 数据库索引与权限是否按 `db-schema.md` 配置成功 | 同上 |
| 页面在开发者工具中的渲染效果 | 工具未安装（U1） |
| 云函数 `require('./shared/...')` 打包路径 | 结构符合云函数规范，但未实际部署验证 |

## 6. 已知问题

1. `queryDraws` 的 `year` 过滤依赖期号字符串区间（`2026001`–`2026999`），跨年递进期号（如 2026999 之后若出现 2027001）不受影响，但若官方改用非 7 位期号会失效——已有校验，非法期号直接拒绝。
2. 跨站交叉核验未实现，`verified` 仅代表"官方单源 + 校验通过"（D12）。
3. 快乐8 历史回填需按年串行（每年 1 请求，约 294 期），全量约 7 个请求；未做批量编排。
4. 开奖列表未做本地缓存，每次进入都请求云端（数据量小，可接受）。

## 7. 下一阶段（阶段 3）计划

1. `ticket_records` 集合与 CRUD 云函数：`saveTicket` / `updateTicketDraft` / `confirmTicket` / `voidTicket` / `deleteTicket`。
2. 双色球与快乐8选十的号码选择面板（点击选号、手动输入、清空、随机一注）。
3. 状态机 `draft → confirmed`，`confirmed` 后号码字段冻结（服务端拒绝改号），仅可改金额/倍数/备注。
4. 我的号码列表（彩种/期号/状态筛选）、详情、作废、删除（二次确认）。
5. 测试：主方案 16.4 全表 + 幂等（连点不重复创建）。
