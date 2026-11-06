# CHANGELOG

## [1.0.1] - 2026-11-06

### 新增
- 分析选号支持**统计窗口**（近 30 / 50 / 100 期），用于冷号与上期重号判定；批次记录 `window` / `sampleSize` / `dataSufficient`。
- 界面与分析结果都会显示"实际用了几期"，样本不足时明确提示"判断会偏粗"。
- AI 工具 `analysis.window` 参数；提示词升 `ai_system@1.3.0`：提到统计必须报 sampleSize，样本不足必须说明。

### 数据
- 开奖数据由 10 期/彩种补齐到 **100 期/彩种**（官方接口单次上限 100），结构统计与冷号判定才有意义。

### 测试
- 用例 303 → **307**：窗口记录、窗口取值校验、长窗口冷号更少。

## [1.0.0] - 2026-11-06

### 新增（阶段 7：统计、备份与验收）
- `shared/domain/analytics.js`（`analytics@1.0.0`）：号码频次与遗漏、和值分布与分位、奇偶结构、分区占比与断区次数、连号、个人命中分布。
- 统计页：窗口切换（近 30/50/100 期）、频次三栏、纯 CSS 条形图（零图表库）、命中分布。
- **恢复备份改为两步**：先预览「新增/覆盖/保留」，确认后才写入；合并覆盖、不删除现有数据；闸门状态变化会提前提示。
- 分类清空：号码 / 核对结果 / 候选批次 分别清空，`clearCollection` 有白名单（draws、meta 不可清）。
- 文档：`docs/phase-7-report.md`、`docs/backup-restore.md`；决策 D26。

### 变更
- 数据页把"清空全部"从备份卡移出，单独一张卡，避免误点。
- 备份导出/恢复的说明从 README 抽到独立文档，README 只留入口。

### 测试
- 用例 287 → **303**：统计 12 例（频次/遗漏/和值/奇偶/分区/连号/命中分布/汇总）、恢复预览与分类清空 4 例。

### 已知限制
- 无跨设备同步；无图表交互；`npm run publish:data` 才能把开奖样本拉到 60 期。
- 真机与跨浏览器未验证。

## [0.9.0] - 2026-11-05

### 新增（分析选号）
- `shared/domain/analysis.js`：结构画像（和值/跨度/奇偶/大小/分区/连号/AC/重号）+ 拥挤度模型 `crowd@1.0.0` + 冷号识别。
- 第 4 种策略 `analyzed`（界面「分析选号」）：600 次采样 → 结构硬约束过滤 → 按「拥挤度 + 和值偏离惩罚」取最优；组间重合 >3 个则弃用。
- 拥挤度依据公开研究（生日偏好、幸运号、连号/等差偏好、上期重号），明确标注为**推定值**，仅影响浮动奖均分。
- 批次新增 `analysis` / `crowdSummary` / `tradeoff` 字段；结果卡显示每注拥挤指数、触发因子、平均拥挤与"代价"。
- AI 工具支持 `strategy=analyzed` 与 `analysis` 权重对象；AI 按用户自然语言翻译权重，号码仍由代码生成。
- 提示词升级 `ai_system@1.2.0`：必须说明"概率不变、只影响浮动奖均分"、拥挤度是推定值、冷号不是"该回补"。
- 文档 `docs/analysis-model.md`（研究依据、权重表、校准踩坑、明确不做）+ 决策 D25。

### 校准修正（本轮踩坑）
- 生日区从"绝对个数"改为"超出随机期望的个数"，否则双色球所有组合都被判高拥挤。
- 等差判定从"≥3 项"改为"≥4 项或三连号"，避免误伤普通组合。
- 快乐8 的连号/同尾阈值随号码个数放大，否则 10 个号几乎全部被拒。

### 测试
- 用例 265 → **287**：分析模型 19 例（结构画像、拥挤度排序、因子、冷号、策略约束、可复现、组间分散、无解报错、快乐8）。

## [0.8.0] - 2026-11-05

### 新增（阶段 6：候选组合）
- `shared/domain/candidates.js`：`random` / `balanced` / `preference` 三策略；确定性种子（mulberry32 + FNV-1a），同参数同种子必得同结果；默认 3 注、上限 5、组间去重；`verifyBatch` 自检、`reviewBatch` 开奖回看。
- 选号页：闸门开关（默认关闭）、策略选择、注数/期号/种子、必含/排除、结果展示、导入为草稿、历史批次（含命中回看）、删除批次。
- 批次留痕：`algorithmVersion` / `randomSeed` / `parameterSnapshot` / `targetIssue` / `complianceState`，可完整重放。
- AI 工具 `generate_candidates`：**仅在闸门开启时注册**；号码由代码产出，模型只能原样转述；每次生成都落库留痕（失败会返回 `saved:false`）。
- 提示词升级 `ai_system@1.1.0`：开启时要求原样引用 + 必须声明"不代表更容易中奖"；关闭时禁止以任何文本形式给号码。

### 变更
- 本地库 IndexedDB 版本 1 → 2，新增 `candidates` 对象仓库（老数据自动保留）。
- 备份格式 `jingcai-web@1` → `@2`（含 `candidates`），仍兼容导入 `@1`。
- 导出/恢复同时覆盖候选批次。
- 闸门判定新增 `self_attested_personal_use`：只有调用方显式传 `acceptSelfAttested` 才认，云函数保持严格模式（D23）。

### 明确未做
- 小程序侧 `generateCandidates` 云函数（主线已迁静态站）。
- 按历史频次加权的"冷热选号"（拒绝伪预测，D24）。
- 服务端强制闸门（静态站无服务端，详见 `docs/phase-6-report.md` 第 6 节）。

### 测试
- 用例 243 → **265**：候选域模型 18、闸门与 AI 工具 14、Web 仓库层 8。

## [0.7.0] - 2026-11-05

### 新增
- **AI 助手回到 Web 版**：用户在「AI」页自填 DeepSeek Key，只存本机 localStorage，浏览器直连 `api.deepseek.com`（已实测支持 CORS）。
  - 复用 `shared/ai/tools.js`、`shared/cloud/aiTools.js`、`shared/ai/orchestrator.js`，判奖与校验逻辑零复制。
  - 新增 `web/js/localdb.js`：把本地存储包装成云数据库接口，工具执行器原样可用。
  - 上限不变：3 轮 / 单轮 4 个 / 总量 8 个 / 900 tokens / 输入 1000 字。
- **随机多注**：注数（1–5）与倍数分离，按注数生成互不相同的号码；每注独立存为草稿，可逐注确认/作废。
  - 新增 `web/js/bets.js`（纯函数，含去重与边界处理）。
- 多注标签切换编辑目标；保存按钮显示"N 注为草稿"。

### 变更
- `AI_AUTH_FAILED` 的文案改为通用表述（不再提"云端环境变量"），云函数与静态站共用。
- 核对结果同时写 `hit` 与 `hitDetails`，兼容复用执行器的字段名。

### 测试
- 用例 210 → **225**：新增 Web AI 9 例（无 Key 拒绝、Key 裁剪、工具调用回填、localdb 取数、401 不泄露 Key、网络错误映射、模型名白名单）、号码生成 6 例（范围/去重/注数边界）。

## [0.6.0] - 2026-11-05

### 重大变更（架构）
- 主线从微信小程序改为**纯静态网站**，部署到 GitHub Pages；小程序代码保留备查（D20）。
- 开奖数据改由 GitHub Actions 定时抓取官方接口，写成 `web/data/draws/*.json` 提交入库；页面同源读取，规避官方接口无 CORS 的限制。
- 个人数据改为浏览器本地存储：IndexedDB，失败降级 localStorage；新增导出/恢复备份。

### 新增
- `web/`：开奖 / 我的号码 / 统计 / 数据 四个视图，纯原生 JS + CSS，无框架无构建依赖。
- `scripts/build-web.js`：零依赖 CommonJS 打包器，把 `shared/` 与 `web/js/` 打成单文件 bundle。
- `scripts/sync-to-json.js`：抓取 + 校验 + 合并 + 截断，输出静态 JSON；抓取失败保留旧文件不阻塞发布。
- `scripts/serve-web.js`：本地预览静态站。
- `.github/workflows/deploy-pages.yml`（构建 + 测试 + 发布）、`sync-draws.yml`（每日两次抓取并提交）。
- `docs/web-deploy.md`：Pages 部署全流程、Actions 权限、私有仓库限制、排错表。
- 决策 D20。

### 修复
- 本地存储增加超时与降级：无痕模式或禁用 IndexedDB 时不再空白页，回落到 localStorage。
- 首次渲染不再等待数据库：先出骨架再加载数据。

### 测试
- 用例 206 → **210**：新增 web bundle 4 例（bundle 可执行、包含全部共享模块、判奖与校验行为一致），并用无头浏览器实测页面渲染与数据加载。

## [0.5.1] - 2026-11-05

### 新增
- 云函数 `initDb`：一键创建 8 个集合、写入 `app_config`（把调用者的 OpenID 加入白名单）、灌入规则种子；幂等、不覆盖已有白名单。
- 设置页新增「数据库初始化」卡片：一键初始化 + 展示仍需手工创建的索引清单。
- `docs/getting-started.md` 重写为 11 步，补充「云开发入口在哪」「建集合在控制台而不是调试面板」等易卡点说明。

### 修复
- 假 CloudBase（测试替身）读取不存在的集合时会自动建集合，与真实行为不符；已改为仅在写入时创建，并支持 `_id` 指定与 `createCollection`。

### 测试
- 用例 202 → **206**（新增 initDb 3 例：首次创建、重复幂等、非白名单拒绝）。

## [0.5.0] - 2026-11-05

### 新增（阶段 5：DeepSeek AI 助手）
- `shared/ai/prompt.js`：版本化系统提示词 `ai_system@1.0.0`（11 条硬规则：只依据工具数据、不编数字、不暗示提升中奖机会、未开放功能不得给未来号码）。
- `shared/ai/tools.js`：7 个只读工具 schema + 参数白名单校验。
- `shared/ai/orchestrator.js`：工具循环编排（3 轮 / 单轮 4 个 / 总量 8 个 / 超限不带工具再总结）。
- `shared/ai/deepseek.js`：请求体构造、响应解析、HTTP 错误码映射。
- `shared/cloud/aiTools.js`：只读查询执行器，身份服务端注入。
- 云函数 `aiChat`：会话管理、密钥读取、编排、消息与用量落库。
- 页面：AI 对话（建议问题、工具使用痕迹、错误分型提示、新对话）。
- 文档：`docs/getting-started.md`（首次上手手册）、`docs/phase-5-report.md`；决策 D18、D19。

### 变更
- 快乐8 单注价格经用户确认为 2 元，`suggestCost` 现对两个彩种都给出建议值（仍不自动写入）。
- `project.config.json` 写入真实 AppID。

### 测试
- 用例 155 → **202**，全部通过。新增：工具校验 11、编排 7、执行器 13、aiChat 8、DeepSeek 协议 7，并扩展 `fake-cloud` 支持假 `https`。

## [0.4.0] - 2026-11-05

### 新增（阶段 4：判奖引擎）
- `shared/rules/judge.js`：纯函数判奖引擎。双色球六奖级 + 福运奖三态；快乐8 选十 10/9/8/7/6/5/0；浮动奖只读当期公告，缺失即"待公告"。
- `shared/rules/probability.js`：组合数、双色球 1/17,721,088、快乐8 超几何分布（仅用于如实说明量级）。
- 云函数 `checkTickets`：只判 `confirmed` + `verified`；幂等键 `ticketId|drawId|ruleVersion|drawHash`；开奖更正后新增核对并 `recheckOf` 留痕；回写展示用 `checkSummary`。
- 页面：号码详情新增核对结果卡（中奖/未中/待人工核验 + 命中号码 + 规则版本 + 单票核对）；我的号码新增核对徽标与「一键核对」。
- 文档：`docs/db-schema.md` 新增 `ticket_checks`；`docs/phase-4-report.md`；决策 D16、D17。

### 变更
- 核对不写回 `purchaseStatus`（`checked` 只是结果态），避免"已核对但未购买"这类非法组合。

### 测试
- 用例 113 → **155**，全部通过。新增判奖表 32 例（福运奖三态、快乐8 无人中 10 中 10、旧期无规则、期号错配）+ 云函数 9 例（幂等、force 更新、更正留痕、草稿不参与）。

## [0.3.0] - 2026-11-05

### 新增（阶段 3：个人号码管理）
- `shared/domain/tickets.js`：草稿构造、编辑白名单、`draft→confirmed` 确认购买、作废、删除条件、判奖/统计准入。
- 云函数 `ticketService`（create/update/confirm/void/delete）与 `queryTickets`（list/detail/summary）；全部按 OpenID 归属隔离。
- 页面：我的号码（状态分栏 + 计数 + 分页）、录入号码（双色球 33+16 / 快乐8 1–80 网格、随机一注、清空）、号码详情（确认已购买面板、已购买后改备注金额、作废、删除）。
- `shared/rules/registry.js` 增加 `suggestCost()`：仅对已核对单价（双色球 2 元/注）给建议值，快乐8 不给数字。
- `scripts/set-appid.js` + `npm run set:appid`：一条命令写入 AppID（校验格式）。
- `tests/helpers/fake-cloud.js`：内存版 CloudBase，让云函数可在本地被真实调用测试。

### 变更
- `ticket_records` 设计落入 `docs/db-schema.md`（字段、4 个索引、5 条不变量）。
- 决策新增 D14（写操作合并为 `ticketService`）、D15（金额只认用户录入）。

### 测试
- 用例 81 → **113**，全部通过。新增域模型 19 例 + 服务层 11 例（幂等、越权隔离、号码冻结、删除守卫、非白名单拒绝）。

## [0.2.0] - 2026-11-05

### 新增（阶段 2：开奖数据接入）
- `shared/adapters/cwl.js`：中国福彩网官方 JSON 接口适配器，含查询构造（`incremental`/`issue`/`year`）、响应外壳校验、内容指纹、两个实测坑位处理。
- `shared/validators/draws.js`：开奖记录校验（期号/日期防进位/号码/金额/状态）。
- `shared/rules/registry.js`：规则版本注册表与按期号解析（`ssq_2026_02_01`、`kl8_2025_12_30`）。
- `shared/parsers/csv.js`：零依赖 CSV 解析/导出（引号、转义、BOM、CRLF）。
- `shared/cloud/`：云函数鉴权外壳 `base.js`、幂等入库与冲突标记 `drawStore.js`（不进小程序包）。
- 云函数：`syncDraws`（同步+日志）、`queryDraws`（列表/详情/元信息）、`importDraws`（CSV 兜底，支持 dryRun）。
- 前端：开奖列表（彩种/年份/分页/下拉刷新/同步按钮）、开奖详情（奖级表、来源链接、核验状态、规则版本）、首页接入真实最新开奖。
- 脚本：`import-draws`（CSV 校验→NDJSON）、`seed-rules`（规则种子）、`verify-pipeline`（真实数据端到端自检）。
- 文档：`docs/db-schema.md`（集合/索引/权限/初始化）、`docs/phase-2-report.md`。

### 变更
- **更正阶段 1 的错误判断**：往期公告页并非服务端渲染，HTML 内不含号码，数据来自官方前端 JSON 接口（`decisions.md` D10）。
- `sync-shared.js` 支持按目标过滤：`shared/cloud/**` 只同步到云函数；新增多余文件清理。
- 首页开奖区域由占位文案改为真实数据 + 明确的"未同步"空状态。

### 测试
- 用例 31 → **81**，全部通过；新增真实官方数据 fixture（双色球 4 期含单注封顶样例、快乐8 4 期含"中 10 无人中"样例）。
- `npm run verify:pipeline` 对 ssq / kl8 各 5 期真实数据跑通，幂等验证通过。

## [0.1.0] - 2026-11-04

### 新增
- 阶段 0 文档基线：环境检查报告、实施计划、决策记录、合规清单、数据源方案。
- 小程序骨架（原生 JS，零构建）：首页、开奖、我的号码、AI 助手 4 个 tab，设置页、未授权页、空状态组件。
- `shared/` 共享层：彩种常量与状态枚举、号码校验、访问控制与合规闸门、统一返回结构。
- `authCheck` 云函数：OpenID 白名单校验（`app_config` 优先，`OWNER_OPENID` 回退，fail-closed），下发功能开关与合规闸门状态。
- 工具脚本：`sync-shared.js`（共享码同步/校验）、`check-copy.js`（禁用词扫描）。
- 测试：31 个用例（号码校验、鉴权、合规闸门、返回结构、共享码一致性），全部通过。

### 说明
- 除 `authCheck` 外的云函数尚未实现，前端以明确空状态呈现，不显示任何示例数据。
- AI 号码推荐/候选生成默认关闭，且必须 `wxComplianceStatus=approved` 才可能开启。
- `project.config.json` 的 AppID 为占位值，需替换后方可部署。
