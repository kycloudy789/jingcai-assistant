# 竞彩助手

双色球 / 快乐8（选十）的**个人号码档案 + 官方开奖查询 + 规则判奖 + 统计**。

当前形态：**纯静态网站**，托管在 GitHub Pages，不需要服务器、域名备案、微信审核。
数据（开奖）由 GitHub Actions 每天定时抓取；你的号码记录只存在自己浏览器里。

> 仓库里还保留着早期的小程序版本（`miniprogram/` + `cloudfunctions/`），已不再作为主线，仅作历史参考。

## 能做什么

- **开奖**：双色球 / 快乐8 已核验开奖列表、奖级明细、官方公告链接
- **选号（候选组合）**：三种策略（随机 / 偏好约束 / **分析选号**）生成 1–5 注，组间不重复；批次留痕（种子 + 参数快照）可复现，开奖后回看命中；导入只生成**草稿**
- **分析选号**：按"拥挤度"挑号码——避开生日区扎堆、连号等差、上期重号，可要求带冷号；统计窗口 30–3000 期。它改的是**浮动奖被均分的风险**，不是中奖概率
- **我的号码**：手动点选或随机生成；注数与倍数分开；**按彩种分组**（双色球 / 快乐8 可单独筛选），每条显示**购买日期**；确认购买时金额按 2 元/注预填
- **判奖**：按期号解析规则版本，六奖级 + 福运奖三态；快乐8 选十全档
- **AI 助手**：自带 DeepSeek API Key（在 AI 页填，只存本机）问开奖、查自己记录、解释规则；候选闸门开启后可调用生成工具（号码由代码产出，模型只能原样转述）
- **统计**：投入 / 中奖 / 净额，按彩种拆分；开奖结构（频次、遗漏、和值、奇偶、分区、连号）+ 我的命中分布，可切近 30/50/100 期
- **数据**：CSV / JSON 导入开奖；导出备份、**恢复前先预览**（新增/覆盖/保留）、分类清空

## 明确不做

- 不购彩、不代购、不代办兑奖；不做任何收益承诺或概率暗示
- 不做号码推算；随机功能只是生成号码组合，不代表任何"更容易中"
- 不收集你的数据到服务器（没有服务器）；AI 请求直连 DeepSeek，用的是你自己的 Key
- 候选生成**不读历史频次**做加权："冷热号"对独立随机事件没有信息量，不把随机包装成推断（见 D24）

## 快速开始（本地）

```bash
npm run build:web      # 把 shared/ + web/js 打成一个 bundle（零依赖）
npm run sync:json      # 抓一次官方开奖，写入 web/data/draws
npm run serve:web      # http://127.0.0.1:5173
```

要求 Node ≥ 18。**零 npm 运行时依赖**，不需要 `npm install`。

## 部署到 GitHub Pages

完整步骤（含 Actions 权限、私有仓库限制、常见报错）：**`docs/web-deploy.md`**

一句话版本：建 Public 仓库 → push → Settings → Pages → Source 选 **GitHub Actions** → 等 `deploy-pages` 变绿。

更新开奖数据（本机执行）：`npm run publish:data` → 抓取 + 通过 GitHub API 提交 → Pages 自动重建。

AI：打开站点 → 「AI」页 → 粘贴自己的 DeepSeek Key → 保存并验证。Key 只存本机，不上传。

## 架构

```
GitHub Actions（每天 09:00 / 22:00）
  └─ scripts/sync-to-json.js  抓官方接口 → web/data/draws/{ssq,kl8}.json → 提交
GitHub Pages（静态）
  └─ web/index.html → web/dist/app.js（由 scripts/build-web.js 生成）
       ├─ 读 web/data/draws/*.json（同源，无 CORS 问题）
       ├─ 个人数据存 IndexedDB（失败降级 localStorage）
       └─ 判奖/校验全部复用 shared/ 的纯函数
```

**为什么抓取不放在浏览器**：官方接口没有 `Access-Control-Allow-Origin`，浏览器直连会失败。放在 Actions 里抓、产出静态 JSON，是最省事且免费的做法。

## 目录

```text
web/                     静态站（Pages 发布目录）
├── index.html
├── style.css
├── js/app.js            界面与交互
├── js/repo.js           领域操作（接 shared/ 纯逻辑）
├── js/store.js          本地存储（IndexedDB → localStorage 降级）
├── data/draws/*.json     定时生成的开奖数据
└── dist/app.js           打包产物（由 build:web 生成，已入库便于直接打开）

shared/                  唯一事实来源（前后端共用，纯函数）
├── constants/games.js   彩种、状态枚举、免责声明
├── validators/          号码校验、开奖记录校验
├── rules/registry.js    规则版本、奖级表、单价
├── rules/judge.js       判奖引擎（唯一判定入口）
├── domain/tickets.js    号码状态机、字段冻结、统计准入
├── domain/candidates.js 候选四策略（确定性种子、组间去重、批次回看）
├── domain/analysis.js   结构画像 + 拥挤度模型（crowd@1.0.0）
├── domain/analytics.js  开奖结构统计 + 命中分布（analytics@1.0.0）
├── security/access.js   单用户鉴权 + 候选闸门
├── parsers/csv.js       CSV 解析/导出
└── adapters/cwl.js      官方接口映射（含实测坑位说明）

scripts/                 build-web / sync-to-json / serve-web / sync-shared / verify-judge ...
tests/                   node:test（307 用例）
docs/                    部署、数据源、决策、各阶段报告
miniprogram/ cloudfunctions/   早期小程序版（保留备查）
```

## 开发约定

- 改 `shared/` 后：`npm run build:web`（Web 用）+ `npm run sync:shared`（小程序史遗留，测试会校验）
- 期号一律 7 位字符串；号码内部是整数升序数组，`01` 只在界面出现
- 金额 `null` → 显示「待公告」，**禁止补 0 或估算**
- 判奖只认 `shared/rules/judge.js`；界面层不得自行推断奖级或金额
- 「已购买」后号码冻结；改号必须作废后重建
- 候选生成必须可复现：同 `(game, strategy, count, seed, params)` 必得同结果，改算法就升 `algorithmVersion`
- 候选导入只能产出 `draft`，金额/购买时间必须为空
- 提交前：`node --test tests/*.test.js` + `npm run compliance:grep`

## 已知限制

| 限制 | 说明 |
|---|---|
| 数据在单机 | 换设备/清缓存会丢，用「数据」页导出备份 |
| 开奖滞后 | GitHub 机器抓福彩网被 WAF 拦（403，实测），自动更新改由本机 `npm run publish:data` 完成 |
| 浮动奖 | 双色球一/二等、快乐8 中 10 只读当期公告，缺失显示待公告 |
| 旧期不判奖 | 双色球 < 2026014、快乐8 < 2025350 无规则版本 |
| 福运奖 | 官方未明确是否执行时转人工（配置项可改，见 `docs/data-source-plan.md`） |
| AI 密钥 | 存在浏览器 localStorage，同一浏览器的脚本/扩展理论上可读；请用可吊销的 Key，用完可点「清除密钥」 |
| AI 费用 | 由你自己的 DeepSeek 账户承担；单次对话最多 3 轮工具调用、900 tokens |
| 候选闸门 | 默认关闭，需在「选号」页本人确认开启；开启状态存在本机，**不是服务端强制**（D23） |
| 拥挤度 | 基于公开研究推导的**推定值**：福彩不公布每注号码的投注分布。它只影响浮动奖均分，不改变中奖概率（见 `docs/analysis-model.md`） |
| 数据来源 | 官方接口在云端被 WAF 拦，云端兜底用 500.com；这类记录在列表里标「第三方同步」，号码结构校验过但**不是官方原文** |
| 统计样本 | 仓库为**全量历史**（双色球 2085 期、快乐8 2118 期）；结构统计与冷号判定都会显示"实际用了几期"，不足时明确标"样本偏小" |
| 自动更新 | 云端 Actions 每天 **21:50**（官方 403 时用 500.com 兜底）；本机 `publish:data` 会用官方数据覆盖升级来源 |
| 图表 | 纯 CSS 条形，没有交互缩放与导出图片（零依赖约束） |
| 恢复语义 | 合并覆盖，不删除现有记录；想完全回到备份状态需先清空 |

## 文档

| 文档 | 内容 |
|---|---|
| `docs/web-deploy.md` | **部署到 GitHub Pages 全流程 + 排错** |
| `docs/analysis-model.md` | **分析选号模型**：研究依据、权重表、校准踩坑、明确不做 |
| `docs/backup-restore.md` | **备份与恢复**：文件里有什么、预览怎么读、三个必知行为 |
| `docs/phase-7-report.md` | 统计与备份的验收报告 + 已知问题 |
| `docs/data-source-plan.md` | 官方接口实测记录、字段映射、两个坑、状态机 |
| `docs/decisions.md` | D1–D28 决策记录 |
| `docs/db-schema.md` | 小程序版数据库设计（Web 版用本地存储，字段同名） |
| `docs/phase-1~7-report.md` | 各阶段交付与真实测试输出 |
| `docs/getting-started.md` | 小程序版上手手册（历史） |

免责声明：本工具仅用于个人记录与核对，不构成任何购彩建议；兑奖以官方销售终端打印的彩票及法定兑奖机构认定为准。
