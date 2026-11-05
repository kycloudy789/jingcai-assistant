#!/usr/bin/env node
/**
 * 抓取官方开奖 → 生成静态站可用的 JSON（web/data/draws/{ssq,kl8}.json）。
 * 供 GitHub Actions 定时执行；也可本地手动跑。
 *
 * 用法：node scripts/sync-to-json.js [--count 60] [--keep 300]
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

const KEEP_FIELDS = [
  'game',
  'issue',
  'drawDate',
  'numbers',
  'prizeInfo',
  'specialRuleStatus',
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

async function syncGame(game) {
  const url = buildQueryUrl({ game, mode: 'incremental', issueCount: Math.min(COUNT, 100) });
  const payload = await fetchJson(url);
  if (!payload || Number(payload.state) !== 0 || !Array.isArray(payload.result)) {
    throw new Error(`官方返回异常: state=${payload && payload.state}`);
  }

  const fresh = [];
  const errors = [];
  for (const raw of payload.result) {
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
  for (const row of fresh) {
    const prev = map.get(row.issue);
    if (!prev) added += 1;
    else if (JSON.stringify(prev.numbers) !== JSON.stringify(row.numbers)) updated += 1;
    map.set(row.issue, row);
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
        sourceApi: url.split('?')[0],
        parserVersion: PARSER_VERSION,
        count: records.length,
        latestIssue: records.length ? records[0].issue : null,
        records,
      },
      null,
      1
    )
  );

  return { game, fetched: payload.result.length, kept: records.length, added, updated, errors };
}

async function main() {
  const results = [];
  let failed = 0;

  for (const game of ['ssq', 'kl8']) {
    try {
      const r = await syncGame(game);
      results.push(r);
      console.log(
        `✓ ${game}: 抓取 ${r.fetched} 期，新增 ${r.added}，更新 ${r.updated}，库内 ${r.kept} 期` +
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
