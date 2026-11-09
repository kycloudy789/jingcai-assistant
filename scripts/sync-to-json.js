#!/usr/bin/env node
/**
 * 抓取官方开奖 → 生成静态站可用的 JSON（web/data/draws/{ssq,kl8}.json）。
 * 供 GitHub Actions 定时执行；也可本地手动跑。
 *
 * 用法：
 *   node scripts/sync-to-json.js                  # 抓最新 60 期，合并后保留 300 期
 *   node scripts/sync-to-json.js --count 100 --keep 300
 *   node scripts/sync-to-json.js --backfill 300   # 额外回溯历史，把库补到 300 期
 *
 * 回溯实现（实测）：
 *   双色球 —— 支持 pageNo 翻页（pageSize 100 生效），逐页往前。
 *   快乐8 —— 忽略 pageNo，必须用 issueStart/issueEnd 区间，按 100 期一段往前切。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const { buildQueryUrl, mapRecord, PARSER_VERSION } = require('../shared/adapters/cwl');
const { prepareRecord } = require('../shared/cloud/drawStore');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'web', 'data', 'draws');
const SAMPLE_SRC = path.join(ROOT, 'data', 'samples', 'draws_template.csv');
const SAMPLE_OUT_DIR = path.join(ROOT, 'web', 'data', 'samples');

const args = process.argv.slice(2);
const readNum = (flag, fallback) => {
  const i = args.indexOf(flag);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const COUNT = readNum('--count', 60);
const KEEP = readNum('--keep', 300);
const BACKFILL = readNum('--backfill', 0);

const KEEP_FIELDS = [
  'game',
  'issue',
  'drawDate',
  'numbers',
  'prizeInfo',
  'specialRuleStatus',
  'specialRuleSource',
  'specialRuleReason',
  'promo',
  'enrichSignature',
  'ruleVersion',
  'sourceUrl',
  'sourceType',
  'parserVersion',
  'drawStatus',
  'verifiedAt',
  'salesAmount',
  'poolAmount',
  'fixedPoolAmount',
  'rawHash',
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
          'X-Requested-With': 'XMLHttpRequest',
          Connection: 'close',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let snippet = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (snippet.length < 160) snippet += c;
          });
          res.on('end', () => {
            reject(new Error(`HTTP ${res.statusCode}${snippet ? ` ${snippet.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`));
          });
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('响应不是合法 JSON'));
          }
        });
      }
    );
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

function readExisting(file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(payload.records) ? payload.records : [];
  } catch (err) {
    return [];
  }
}

const { sha256Raw } = (() => {
  const crypto = require('crypto');
  return {
    sha256Raw: (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'),
  };
})();

function assertPayload(payload, label) {
  if (!payload || Number(payload.state) !== 0 || !Array.isArray(payload.result)) {
    throw new Error(`${label} 官方返回异常: state=${payload && payload.state}`);
  }
  return payload.result;
}

/** 抓最新 N 期 */
async function fetchLatest(game, count) {
  const url = buildQueryUrl({ game, mode: 'incremental', issueCount: Math.min(count, 100) });
  const payload = await fetchJson(url);
  return { raws: assertPayload(payload, 'latest'), requests: 1 };
}

/**
 * 回溯历史。
 * 双色球：pageNo 翻页，每页 100。
 * 快乐8：issue 区间，每段 100 期，跨年时回到上一年 999。
 */
async function fetchBackfill(game, want, latestIssue) {
  const raws = [];
  let requests = 0;

  if (game === 'ssq') {
    const pages = Math.ceil(want / 100);
    for (let p = 1; p <= pages; p += 1) {
      const url = buildQueryUrl({ game, mode: 'page', pageNo: p });
      const payload = await fetchJson(url);
      requests += 1;
      const list = assertPayload(payload, `page${p}`);
      raws.push(...list);
      if (list.length < 100) break;
    }
    return { raws, requests };
  }

  // 快乐8 忽略 pageNo，只能用 issue 区间。策略：
  //   1. 从锚点期号往前切 100 期一段；
  //   2. 切到本年 001 后，下一年先用 001-999 探测（接口会返回该年最新的 100 期）；
  //   3. 用实际返回的最小期号继续往前，而不是靠"999 减 100"凭空猜。
  let year = Number(String(latestIssue).slice(0, 4));
  let end = Number(String(latestIssue).slice(4));
  let remaining = want;

  while (remaining > 0 && year >= 2020) {
    const size = Math.min(100, remaining);
    const start = end >= 999 ? 1 : Math.max(1, end - size + 1);
    const issueStart = `${year}${String(start).padStart(3, '0')}`;
    const issueEnd = `${year}${String(end).padStart(3, '0')}`;
    const url = buildQueryUrl({ game, mode: 'issue', issueStart, issueEnd });
    const payload = await fetchJson(url);
    requests += 1;

    const list = payload && Number(payload.state) === 0 && Array.isArray(payload.result) ? payload.result : [];
    if (list.length) {
      raws.push(...list);
      const minIssue = list.reduce((acc, r) => Math.min(acc, Number(r.code)), Number(list[0].code));
      remaining -= list.length;
      end = Number(String(minIssue).slice(4)) - 1;
      if (end < 1) {
        year -= 1;
        end = 999;
      }
    } else {
      // 这一段确实没有数据（例如某年没有这么多期），退到上一年重试
      year -= 1;
      end = 999;
    }
  }

  return { raws, requests };
}

async function syncGame(game, rawList, requestCount, apiUrl) {
  const fresh = [];
  const errors = [];
  for (const raw of rawList) {
    const mapped = mapRecord(game, raw, { fetchedAt: new Date().toISOString() });
    if (!mapped.ok) {
      errors.push({ issue: raw && raw.code, message: mapped.message });
      continue;
    }
    const prepared = prepareRecord(mapped.record, { rawHash: sha256Raw(raw) });
    if (!prepared.ok) {
      errors.push({ issue: raw && raw.code, message: prepared.message });
      continue;
    }
    fresh.push(prepared.record);
  }

  const file = path.join(OUT_DIR, `${game}.json`);
  const existing = readExisting(file);
  const map = new Map();
  for (const row of existing) map.set(row.issue, row);
  let added = 0;
  let updated = 0;
  // 补全字段（派奖、福运奖推导）不由官方接口产生，重新抓到时必须从旧记录带过来，
  // 否则每次同步都会把 promo 抹掉，判奖又退回到少算派奖。
  const CARRY = ['promo', 'enrichSignature', 'specialRuleSource', 'specialRuleReason'];
  for (const row of fresh) {
    const prev = map.get(row.issue);
    if (!prev) added += 1;
    else if (JSON.stringify(prev.numbers) !== JSON.stringify(row.numbers)) updated += 1;
    const merged = { ...row };
    for (const key of CARRY) {
      if (prev && prev[key] !== undefined) merged[key] = prev[key];
    }
    map.set(row.issue, merged);
  }

  const records = Array.from(map.values())
    .sort((a, b) => Number(b.issue) - Number(a.issue))
    .slice(0, KEEP)
    .map((row) => {
      const out = {};
      for (const key of KEEP_FIELDS) if (row[key] !== undefined) out[key] = row[key];
      return out;
    });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schema: 'jingcai-draws@1',
        game,
        generatedAt: new Date().toISOString(),
        source: 'https://www.cwl.gov.cn',
        sourceApi: apiUrl,
        parserVersion: PARSER_VERSION,
        count: records.length,
        latestIssue: records.length ? records[0].issue : null,
        records,
      },
      null,
      1
    )
  );

  return { game, fetched: rawList.length, requests: requestCount, kept: records.length, added, updated, errors };
}

async function main() {
  const results = [];
  let failed = 0;

  for (const game of ['ssq', 'kl8']) {
    try {
      const latest = await fetchLatest(game, COUNT);
      let raws = latest.raws;
      let requests = latest.requests;

      if (BACKFILL > 0) {
        const anchor = raws.length ? raws[0].code : null;
        if (anchor) {
          // 回溯请求数按总量算，重叠部分交给后面的去重（少算会差一整页）
          const more = await fetchBackfill(game, BACKFILL, anchor);
          raws = raws.concat(more.raws);
          requests += more.requests;
        }
      }

      // 去重（同一期可能被最新与回溯都抓到）
      const byIssue = new Map();
      for (const raw of raws) {
        if (raw && raw.code) byIssue.set(String(raw.code), raw);
      }

      const apiUrl = buildQueryUrl({ game, mode: 'incremental', issueCount: 1 }).split('?')[0];
      const r = await syncGame(game, Array.from(byIssue.values()), requests, apiUrl);
      results.push(r);
      console.log(
        `✓ ${game}: 请求 ${r.requests} 次，抓取 ${r.fetched} 期，新增 ${r.added}，更新 ${r.updated}，库内 ${r.kept} 期` +
          (r.errors.length ? `，跳过 ${r.errors.length} 条` : '')
      );
    } catch (err) {
      failed += 1;
      const file = path.join(OUT_DIR, `${game}.json`);
      const hasCache = fs.existsSync(file);
      console.warn(`! ${game} 同步失败: ${err.message}${hasCache ? '（保留已有文件）' : '（且无历史文件）'}`);
      if (!hasCache) failed += 1;
    }
  }

  // 顺带把 CSV 模板放进站点，供「数据」页下载
  try {
    fs.mkdirSync(SAMPLE_OUT_DIR, { recursive: true });
    fs.copyFileSync(SAMPLE_SRC, path.join(SAMPLE_OUT_DIR, 'draws_template.csv'));
  } catch (err) {
    console.warn(`! 复制 CSV 模板失败: ${err.message}`);
  }

  const totalKept = results.reduce((n, r) => n + r.kept, 0);
  console.log(`\n完成：${results.length} 个彩种，共 ${totalKept} 期。`);

  // 全部失败且没有缓存才算硬失败，避免偶发网络问题让 Actions 变红
  if (results.length === 0) process.exit(1);
}

main();
