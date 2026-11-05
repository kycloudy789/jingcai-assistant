# 竞彩助手

双色球 / 快乐8（选十）的**个人号码档案 + 官方开奖查询 + 规则判奖 + 统计**。

当前形态：**纯静态网站**，托管在 GitHub Pages，不需要服务器、域名备案、微信审核。
数据（开奖）由 GitHub Actions 每天定时抓取；你的号码记录只存在自己浏览器里。

> 仓库里还保留着早期的小程序版本（`miniprogram/` + `cloudfunctions/`），已不再作为主线，仅作历史参考。

## 能做什么

- **开奖**：双色球 / 快乐8 已核验开奖列表、奖级明细、官方公告链接
- **我的号码**：点选录入、草稿 → 已购买状态机、号码冻结、作废/删除
- **判奖**：按期号解析规则版本，六奖级 + 福运奖三态；快乐8 选十全档
- **统计**：投入 / 中奖 / 净额，按彩种拆分
- **数据**：CSV / JSON 导入开奖，个人数据导出与恢复备份

## 明确不做

- 不购彩、不代购、不代办兑奖；不做任何收益承诺或概率暗示
- 不做号码推算；候选号码生成能力在 Web 版中**不提供**
- 不收集你的数据到服务器（没有服务器）

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
├── parsers/csv.js       CSV 解析/导出
└── adapters/cwl.js      官方接口映射（含实测坑位说明）

scripts/                 build-web / sync-to-json / serve-web / sync-shared / verify-judge ...
tests/                   node:test（210 用例）
docs/                    部署、数据源、决策、各阶段报告
miniprogram/ cloudfunctions/   早期小程序版（保留备查）
```

## 开发约定

- 改 `shared/` 后：`npm run build:web`（Web 用）+ `npm run sync:shared`（小程序史遗留，测试会校验）
- 期号一律 7 位字符串；号码内部是整数升序数组，`01` 只在界面出现
- 金额 `null` → 显示「待公告」，**禁止补 0 或估算**
- 判奖只认 `shared/rules/judge.js`；界面层不得自行推断奖级或金额
- 「已购买」后号码冻结；改号必须作废后重建
- 提交前：`node --test tests/*.test.js` + `npm run compliance:grep`

## 已知限制

| 限制 | 说明 |
|---|---|
| 数据在单机 | 换设备/清缓存会丢，用「数据」页导出备份 |
| 开奖滞后 | 每天 2 次定时；可手动 Run workflow |
| 浮动奖 | 双色球一/二等、快乐8 中 10 只读当期公告，缺失显示待公告 |
| 旧期不判奖 | 双色球 < 2026014、快乐8 < 2025350 无规则版本 |
| 福运奖 | 官方未明确是否执行时转人工（配置项可改，见 `docs/data-source-plan.md`） |
| 无 AI | 静态站不能安全存放 API Key |

## 文档

| 文档 | 内容 |
|---|---|
| `docs/web-deploy.md` | **部署到 GitHub Pages 全流程 + 排错** |
| `docs/data-source-plan.md` | 官方接口实测记录、字段映射、两个坑、状态机 |
| `docs/decisions.md` | D1–D20 决策记录 |
| `docs/db-schema.md` | 小程序版数据库设计（Web 版用本地存储，字段同名） |
| `docs/phase-1~5-report.md` | 各阶段交付与真实测试输出 |
| `docs/getting-started.md` | 小程序版上手手册（历史） |

免责声明：本工具仅用于个人记录与核对，不构成任何购彩建议；兑奖以官方销售终端打印的彩票及法定兑奖机构认定为准。
