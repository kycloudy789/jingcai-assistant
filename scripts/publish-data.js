#!/usr/bin/env node
/**
 * 本机发布开奖数据：本地抓官方（本机能通）→ 通过 GitHub API 推送。
 *
 * 为什么需要它：GitHub 托管的 Actions 机器访问中国福彩网会被 WAF 按 IP 拦截
 * （实测 HTTP 403「网宿云安全平台检测到您当前的访问行为存在异常」），
 * 因此在「本机抓 + API 推」是最稳的免费方案。
 *
 * 用法：
 *   node scripts/publish-data.js                 # 抓 60 期并推送
 *   node scripts/publish-data.js --count 20      # 只抓 20 期
 *   node scripts/publish-data.js --dry-run       # 只抓不改仓库
 *   node scripts/publish-data.js --backfill 300  # 顺便把历史补到 300 期
 *
 * 行为：数据没有实际变化时**不会产生空提交**（每天定时跑也不会刷屏）。
 *
 * 前置：本机已 `gh auth login`（用 GitHub API，不依赖 github.com:443 的 git 通道）。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const countIdx = args.indexOf('--count');
const count = countIdx >= 0 ? Number(args[countIdx + 1]) || 60 : 60;
const backfillIdx = args.indexOf('--backfill');
const backfill = backfillIdx >= 0 ? Number(args[backfillIdx + 1]) || 0 : 0;
const keepIdx = args.indexOf('--keep');
const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 3000 : 3000;

const PUSH_PATHS = ['web/data/draws', 'web/data/samples'];

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function repoInfo() {
  const remote = run('git remote get-url origin').trim();
  const m = remote.match(/github\.com[:/]([^/]+)\/([^.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`无法从 origin 解析仓库：${remote}`);
  return { owner: m[1], repo: m[2] };
}

async function api(base, pathname, init, token) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'jingcai-publish',
      ...(init && init.headers),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`${init && init.method ? init.method : 'GET'} ${pathname} → ${res.status} ${body && body.message ? body.message : ''}`);
  return body;
}

function listFiles() {
  return execSync(`git ls-files ${PUSH_PATHS.join(' ')}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

(async () => {
  console.log(`[1/3] 抓取官方开奖（${count} 期）…`);
  run(`node scripts/sync-to-json.js --count ${count} --backfill ${backfill} --keep ${keep}`, {
    stdio: 'inherit',
  });

  if (dryRun) {
    console.log('[dry-run] 已跳过推送。');
    return;
  }

  const { owner, repo } = repoInfo();
  const token = run('gh auth token').trim();
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  console.log(`[2/3] 推送数据到 ${owner}/${repo} …`);

  const head = await api(base, '/git/ref/heads/main', null, token);
  const parentSha = head.object.sha;
  const parentCommit = await api(base, `/git/commits/${parentSha}`, null, token);

  const files = listFiles();

  // 先比对：本地文件与远端同一路径的 blob sha 完全一致时，说明数据没变，直接跳过
  const treeRes = await api(base, `/git/trees/${parentCommit.tree.sha}?recursive=1`, null, token);
  const remoteSha = new Map((treeRes.tree || []).map((e) => [e.path, e.sha]));

  const crypto = require('crypto');
  const blobSha = (buf) =>
    crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

  const pending = [];
  for (const file of files) {
    const buf = fs.readFileSync(path.join(ROOT, file));
    const local = blobSha(buf);
    if (remoteSha.get(file) === local) continue;
    pending.push({ file, buf });
  }

  if (!pending.length) {
    console.log('[2/3] 数据无变化，跳过提交（不产生空 commit）。');
    return;
  }

  const blobs = [];
  for (const { file, buf } of pending) {
    const blob = await api(base, '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    }, token);
    blobs.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  console.log(`\n  上传 ${blobs.length} 个文件（共 ${files.length} 个，其余未变）`);

  // 基于现有树，只覆盖数据目录，避免影响其它文件
  const tree = await api(base, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: blobs }),
  }, token);

  const commit = await api(base, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `chore(data): 同步开奖数据 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      tree: tree.sha,
      parents: [parentSha],
    }),
  }, token);

  await api(base, '/git/refs/heads/main', {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  }, token);

  console.log(`[3/3] 已推送 ${commit.sha.slice(0, 7)}，Pages 会在 1–2 分钟内自动重建。`);
})().catch((err) => {
  console.error(`\n✗ 发布失败：${err.message}`);
  process.exit(1);
});
