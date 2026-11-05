# 部署到 GitHub Pages（免费，无需服务器）

- 目标：把这个工具变成一个**纯静态网站**，用 GitHub 的免费额度托管 + 定时抓开奖数据。
- 结果：手机/电脑浏览器打开一个网址就能用，不需要服务器、域名、备案、微信审核。
- 适用：个人自用。数据存在你自己的浏览器里。

---

## 0. 为什么能「没有后端」

| 能力 | 实现方式 |
|---|---|
| 页面托管 | GitHub Pages（静态文件，免费） |
| 开奖数据 | GitHub Actions 每天定时抓取官方接口 → 写成 `web/data/draws/*.json` 提交到仓库 → 页面同源读取 |
| 个人号码 / 核对结果 | 浏览器本地存储（IndexedDB，失败自动降级 localStorage） |
| 判奖计算 | 前端复用 `shared/rules/judge.js`（与小程序版同一份代码） |

**关键判断**：官方接口没有 CORS 头，浏览器不能直连。所以把「抓取」放在 GitHub Actions 里跑，产出静态 JSON——Actions 就是那个"免费服务器"。

代价（必须接受）：
- 数据只在当前浏览器，换设备/清缓存会丢 → 用「数据」页导出备份。
- 开奖数据最多滞后一个定时周期（每天 2 次），可手动触发。
- 没有 AI 助手（静态站不能安全存放 API Key）。

## 1. 建仓库并推送

1. 打开 <https://github.com/new>
2. 仓库名随意，例如 `jingcai-assistant`
3. **Visibility 选 Public**（免费账号的 Pages 只支持公开仓库；私有仓库需要付费计划）
4. 不要勾选 README / .gitignore（本地已有）
5. 创建后，在项目目录执行：

```bash
cd D:\codex\号码管理助手
git init
git add .
git commit -m "feat: 静态站版本"
git branch -M main
git remote add origin https://github.com/<你的用户名>/jingcai-assistant.git
git push -u origin main
```

> 仓库里**不能有密钥**。本项目不含任何 key；`.env` 已在 `.gitignore` 里。

## 2. 开启 Pages

1. 仓库页 → **Settings** → 左侧 **Pages**
2. **Build and deployment → Source** 选 **GitHub Actions**（不要选 "Deploy from a branch"）
3. 保存后不用做别的，`deploy-pages` 工作流会在下次 push 时自动跑

推送后去 **Actions** 标签页，应该看到两个工作流：

| 工作流 | 触发 | 作用 |
|---|---|---|
| `deploy-pages` | push / 手动 | 打包前端 + 跑测试 + 发布到 Pages |
| `sync-draws` | 定时（每天 09:00 / 22:00 北京时间）/ 手动 | 抓官方开奖写 JSON 并提交 |

等 `deploy-pages` 变绿，页面地址是：

```
https://<你的用户名>.github.io/jingcai-assistant/
```

## 3. 首次打开

1. 打开上面的网址
2. 页面会自动尝试加载仓库里的开奖 JSON
3. 如果显示「还没有开奖数据」，点 **重新加载开奖**；仍为空就去 Actions 手动跑一次 `sync-draws`

然后就能：录号码 → 确认已购买 → 一键核对 → 看统计。

## 4. 日常维护

| 想做什么 | 怎么做 |
|---|---|
| 立刻刷新开奖数据 | 仓库 Actions → `sync-draws` → **Run workflow** |
| 改代码后发布 | 本地改完 `git push`，Pages 自动重新部署（会自动跑测试，测试挂了不会发布） |
| 换设备 | 旧设备「数据」页导出 JSON → 新设备「恢复备份」 |
| 本地预览 | `npm run build:web && npm run serve:web`，打开 <http://127.0.0.1:5173> |
| 手动更新一次数据 | `npm run sync:json` 然后 `git add web/data && git commit && git push` |

## 5. 常见问题

**Actions 报 `Resource not accessible by integration`**
→ Settings → Actions → General → Workflow permissions → 选 **Read and write permissions** → Save。

**Pages 一直 404**
→ 确认 Source 选的是 **GitHub Actions**；再看 `deploy-pages` 是否成功；首次部署生效通常 1–2 分钟。

**`sync-draws` 失败但页面照常**
→ 脚本设计为：抓取失败时保留已有 JSON 并正常退出，不阻塞站点。偶发网络问题下次定时会补上。

**页面提示"本地数据库不可用"**
→ 无痕/隐私模式会禁用 IndexedDB。代码已自动降级到 localStorage；若两者都被禁用，请用普通窗口打开。

**数据会不会丢**
→ 清浏览器数据、换设备、换浏览器都会丢本地记录。重要数据请定期在「数据」页导出备份（JSON 可读、可恢复）。

**能不能私有仓库**
→ 免费账号的 Pages 不支持私有仓库。若必须私有，两个选择：升级 GitHub Pro，或改用 Cloudflare Pages（免费支持私有仓库，构建命令同样是 `node scripts/build-web.js`，输出目录 `web`）。

**数据更新频率**
→ 当前每天 2 次（UTC 01:00 / 14:00）。想更勤改 `.github/workflows/sync-draws.yml` 的 cron——但请克制，官方站点不需要高频访问。

## 6. 上线前自检（可选但建议）

```bash
npm run build:web        # 打包，产物 web/dist/app.js
node --test tests/*.test.js   # 210 个用例应全绿
npm run sync:json        # 抓一次数据
npm run serve:web        # 本地打开确认能加载
```

## 7. 这个方案的边界

- 不做购彩、代购、兑奖代办；判奖结果仅供核对，兑奖以官方终端与法定机构认定为准。
- 开奖数据来自中国福彩网公开接口，无稳定性承诺；失败时保留旧数据，不会伪造。
- 浮动奖（双色球一/二等奖、快乐8 中 10）金额只读当期公告，缺失就显示「待公告」。
- 旧期（双色球 2026014 前、快乐8 2025350 前）没有规则版本，不自动判奖。
