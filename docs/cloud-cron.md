# 让开奖数据准点更新（可选）

> 结论先说：**本站没有服务器**，所有"自动更新"都靠 GitHub Actions。而 GitHub 的免费定时器
> 会把 cron 往后推（实测：写的是每小时一次，实际一天只跑 5 次，延迟 5–8 小时）。
> 于是开奖（21:15 / 21:30）之后，仓库里的数据往往要等到**次日早上**才更新。
>
> 号码本身不会错，只是晚。要"当晚就更新"，必须有一个准点的外部定时器去**主动触发**。

下面这个 Cloudflare Worker 就是干这件事的：它按分钟级准点，调用 GitHub 的
`workflow_dispatch` 接口，等于替你按了一下「运行」。

## 它解决什么

| 方式 | 准点性 |
|---|---|
| GitHub `schedule`（现状） | 差，被推迟 5–8 小时 |
| 本机 Windows 计划任务（21:50） | 准，但要开机 |
| **Cloudflare Worker Cron（本文）** | **准，且不用开机** |

## 需要什么

1. 一个 Cloudflare 账号（免费套餐够用，Cron Triggers 免费）。
2. 一个 GitHub **fine-grained token**，权限只要两项：
   - `Actions: Read and write`（触发工作流）
   - `Contents: Read`（读仓库）
   仅限 `kycloudy789/jingcai-assistant` 这一个仓库，有效期自定。

> Token 只存在 Cloudflare 的加密变量里，不会进代码、不会进浏览器。

## 部署（约 5 分钟）

### 1. 建 Worker

Cloudflare 控制台 → Workers & Pages → Create → Worker，命名随意（如 `jingcai-cron`）。

### 2. 贴代码

把默认代码替换成：

```js
export default {
  async scheduled(event, env, ctx) {
    const url = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/actions/workflows/sync-draws.yml/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'jingcai-cron',
      },
      body: JSON.stringify({ ref: env.BRANCH || 'main' }),
    });
    // 204 表示已受理；其他状态打到日志里方便排查
    console.log('dispatch', res.status);
  },
};
```

### 3. 设三个变量

Settings → Variables and Secrets：

| 名称 | 类型 | 值 |
|---|---|---|
| `OWNER` | 文本 | `kycloudy789` |
| `REPO` | 文本 | `jingcai-assistant` |
| `GH_TOKEN` | **Secret** | 你的 fine-grained token |
| `BRANCH` | 文本（可选） | `main` |

### 4. 设 Cron

Settings → Triggers → Cron Triggers，加两条（UTC）：

```
40 13 * * *     # 北京 21:40，双色球 21:15、快乐8 21:30 都已开完
55 13 * * *     # 北京 21:55，兜底一次（公告偶尔延迟）
```

### 5. 验证

Cron Triggers 页面点「Send test event」，或在 GitHub 仓库的 Actions 里看到
一次 `workflow_dispatch` 触发的 `sync-draws`，状态 success，就通了。

## 注意

- 触发只是"让工作流立刻开始跑"，抓数仍然走公开的 500.com / 17500.cn。
  GitHub Runner 访问中国福彩网是 403（网宿 WAF 按 IP 拦），这是既有限制，不因本方案改变。
- 因此**奖级明细**可能仍然要等本机同步才补齐；号码（期号/开奖日）是准点的。
- 不想用了：删掉 Worker 即可，本站不依赖它，只是回到 GitHub 自己的节奏。

## 不装 Worker 的替代方案

电脑开着时，本机计划任务（`npm run task:install`，每天 21:50）会立刻更新，
而且抓的是官方数据（能顺带补齐奖级明细与派奖）。它和云端是互补关系，不冲突。
