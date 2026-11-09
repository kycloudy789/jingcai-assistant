#!/usr/bin/env node
/**
 * 云端兜底同步：从 500.com 抓开奖（官方接口对 GitHub Runner 返回 403，只能走这条）。
 *
 * 定位：**兜底**，不是主源。
 *   - 本机的 `sync-to-json.js`（官方源）优先级更高：官方记录不会被第三方覆盖。
 *   - 代码生成的记录带 `sourceType: 'third_party:500.com'`，界面会标「第三方」。
 *
 * 用法：node scripts/sync-thirdparty.js [--keep 3000] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const { prepareRecord } = require('../shared/cloud/drawStore');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'web', 'data', 'draws');
const KEEP_FIELDS = [
  'game', 'issue', 'drawDate', 'numbers', 'prizeInfo', 'specialRuleStatus',
  'ruleVersion', 'sourceUrl', 'sourceType', 'parserVersion', 'drawStatus',
  'verifiedAt', 'verifiedBy', 'salesAmount', 'poolAmount', 'rawHash',
];

const args = process.argv.slice(2);
const keepIdx = args.indexOf('--keep');
const KEEP = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 3000 : 3000;
const dryRun = args.includes('--dry-run');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SOURCE = 'third_party:500.com';
const PARSER_VERSION = 'thirdparty500@1.0.0';

function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Referer: 'https://www.500.com/', Accept: 'text/html,*/*' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          // 两个页面的编码不同：history.php 是 UTF-8，kaijiang 是 GBK。
          // 先按 ASCII 探一遍 meta charset 再决定，不能一律按 GBK 解。
          const head = buf.slice(0, 2048).toString('latin1');
          const charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
          const label = /gb/i.test(charset) ? 'gbk' : 'utf-8';
          try {
            resolve(new TextDecoder(label).decode(buf));
          } catch (err) {
            resolve(buf.toString('utf8'));
          }
        });
      }
    );
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

/**
 * 带重试的抓取。500.com 在 GitHub Runner 上偶发超时（实测一次 25s 全超），
 * 一次失败就把整条同步链判死太脆，所以重试 3 次。
 */
async function fetchGbk(url, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr || new Error('请求失败');
}

const num = (text) => Number(String(text || '').replace(/[^\d.-]/g, '')) || 0;
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;

/* ---------------- 双色球：history.php 表格 ---------------- */

function parseSsq(html) {
  const rows = (html.match(/<tr[^>]*class="t_tr1"[^>]*>[\s\S]*?<\/tr>/g) || []);
  const out = [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map((c) =>
      c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    );
    if (cells.length < 16) continue;
    const issue5 = cells[1];
    if (!/^\d{5}$/.test(issue5)) continue;
    const red = cells.slice(2, 8).map(num);
    const blue = num(cells[8]);
    if (red.length !== 6 || red.some((n) => n < 1 || n > 33) || blue < 1 || blue > 16) continue;
    // 列顺序：2(星期) 期号 红×6 蓝 快乐星期天 奖池 一等奖注数/金额 二等奖注数/金额 总投注 日期
    const drawDate = (cells[16] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) continue;

    out.push({
      issue: `20${issue5}`,
      drawDate,
      numbers: { red: red.slice().sort((a, b) => a - b), blue, kl8: [] },
      prizeInfo: {
        first: { count: num(cells[11]), amount: num(cells[12]) },
        second: { count: num(cells[13]), amount: num(cells[14]) },
        fuyun: null,
      },
      salesAmount: num(cells[15]) || null,
      poolAmount: num(cells[10]) || null,
      specialRuleStatus: 'unknown',
    });
  }
  return out;
}

/* ---------------- 快乐8：开奖页 ---------------- */

function parseKl8(html) {
  const issue = (html.match(/第\s*<font[^>]*><strong>(\d{7})<\/strong>/) || [])[1];
  const dateParts = html.match(/开奖日期：(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const balls = [...html.matchAll(/<li class="ball_red">(\d{1,2})<\/li>/g)].map((m) => num(m[1]));
  if (!issue || !dateParts || balls.length !== 20) return [];

  return [
    {
      issue,
      drawDate: isoDate(dateParts[1], dateParts[2], dateParts[3]),
      numbers: { red: [], blue: null, kl8: balls.slice().sort((a, b) => a - b) },
      prizeInfo: {},
      salesAmount: null,
      poolAmount: null,
      specialRuleStatus: 'not_applicable',
    },
  ];
}

/* ---------------- 合并 ---------------- */

function readExisting(file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(payload.records) ? payload.records : [];
  } catch (err) {
    return [];
  }
}

const isOfficial = (row) =>
  Boolean(row) &&
  (row.verifiedBy === 'official_api' || /^official/.test(String(row.sourceType || '')));

function merge(game, raws, sourceUrl, dir = OUT_DIR) {
  const file = path.join(dir, `${game}.json`);
  const existing = readExisting(file);
  const map = new Map(existing.map((r) => [r.issue, r]));

  let added = 0;
  let skipped = 0;
  const errors = [];

  for (const raw of raws) {
    const prepared = prepareRecord(
      { ...raw, game, drawStatus: undefined },
      { verifiedBy: SOURCE }
    );
    if (!prepared.ok) {
      errors.push({ issue: raw.issue, message: prepared.message });
      continue;
    }
    const prev = map.get(raw.issue);
    if (isOfficial(prev)) {
      skipped += 1; // 官方数据优先，第三方不覆盖
      continue;
    }
    map.set(raw.issue, {
      ...prepared.record,
      // 补全字段（派奖 / 福运奖推导）不从开奖号码来，第三方写入时也要保留
      ...(prev && prev.promo !== undefined ? { promo: prev.promo } : {}),
      ...(prev && prev.enrichSignature !== undefined ? { enrichSignature: prev.enrichSignature } : {}),
      sourceType: SOURCE,
      sourceUrl,
      parserVersion: PARSER_VERSION,
    });
    added += 1;
  }

  const records = Array.from(map.values())
    .sort((a, b) => Number(b.issue) - Number(a.issue))
    .slice(0, KEEP)
    .map((row) => {
      const out = {};
      for (const key of KEEP_FIELDS) if (row[key] !== undefined) out[key] = row[key];
      return out;
    });

  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          schema: 'jingcai-draws@1',
          game,
          generatedAt: new Date().toISOString(),
          source: 'https://www.500.com（第三方兜底；官方数据优先）',
          sourceType: SOURCE,
          parserVersion: PARSER_VERSION,
          count: records.length,
          latestIssue: records.length ? records[0].issue : null,
          records,
        },
        null,
        1
      )
    );
  }

  return { game, fetched: raws.length, added, skipped, kept: records.length, errors };
}

async function main() {
  const results = [];

  // 双色球：用已有最新期号做区间，一次取最近 10 期，兼顾漏抓
  try {
    const existing = readExisting(path.join(OUT_DIR, 'ssq.json'));
    const latest = existing.length ? Number(existing[0].issue) : null;
    const end5 = latest ? String(latest).slice(2) : null;
    const start5 = end5 ? String(Math.max(1, Number(end5) - 10)).padStart(5, '0') : null;
    const url = latest
      ? `https://datachart.500.com/ssq/history/newinc/history.php?start=${start5}&end=${Number(end5) + 1}`
      : 'https://datachart.500.com/ssq/history/newinc/history.php?limit=10';
    const html = await fetchGbk(url);
    const raws = parseSsq(html);
    const r = merge('ssq', raws, url);
    results.push(r);
    console.log(`✓ ssq: 解析 ${r.fetched} 条，写入 ${r.added}，保留官方 ${r.skipped}，库内 ${r.kept} 期`);
  } catch (err) {
    console.warn(`! ssq 第三方同步失败: ${err.message}`);
  }

  // 快乐8：开奖页只有最新一期
  try {
    const url = 'https://kaijiang.500.com/kl8.shtml';
    const html = await fetchGbk(url);
    const raws = parseKl8(html);
    const r = merge('kl8', raws, url);
    results.push(r);
    console.log(`✓ kl8: 解析 ${r.fetched} 条，写入 ${r.added}，保留官方 ${r.skipped}，库内 ${r.kept} 期`);
    const existing = readExisting(path.join(OUT_DIR, 'kl8.json'));
    if (raws.length && existing.length > 1) {
      const gap = Number(existing[0].issue) - Number(raws[0].issue);
      if (gap > 1) {
        console.warn(`! kl8 可能漏了 ${gap - 1} 期（第三方页只给最新一期），下次本机官方同步会补齐`);
      }
    }
  } catch (err) {
    console.warn(`! kl8 第三方同步失败: ${err.message}`);
  }

  if (!results.length) {
    console.error('✗ 第三方源全部失败');
    process.exit(1);
  }
  console.log(`\n完成：${results.length} 个彩种。来源标记 ${SOURCE}，官方数据优先。`);
}

if (require.main === module) {
  main();
}

module.exports = { parseSsq, parseKl8, merge, isOfficial, SOURCE, PARSER_VERSION };
