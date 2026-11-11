/**
 * 只同步"开奖号码"（最快通道）。
 *
 * 设计取舍：奖级明细可以延后，号码不能落后。
 * 官方接口在 GitHub 上 403，500.com 的 HTML 页偶发超时，但它的静态 XML 列表
 * 一次请求就能拿到全部期号 + 号码 + 开奖日期，稳定且小。
 *
 * 行为：
 *   - 只**新增**缺失的期次，已有记录（含官方奖级明细）一个字段都不覆盖；
 *   - 新增记录没有 prizeInfo：浮动奖会显示"待公告"，固定奖照常判；
 *   - 幂等：同一期重复跑不会产生变更。
 *
 * 用法：
 *   node scripts/sync-numbers.js            # 补最近 45 天 + 比库内更新的所有期
 *   node scripts/sync-numbers.js --days 90
 *   node scripts/sync-numbers.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { GAME } = require('../shared/constants/games');
const { parseList, listUrl, SOURCE, PARSER_VERSION } = require('../shared/adapters/kaijiang-xml');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'web', 'data', 'draws');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 45 : 45;
const keepIdx = args.indexOf('--keep');
const KEEP = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 3000 : 3000;

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
  'verifiedBy',
  'salesAmount',
  'poolAmount',
  'fixedPoolAmount',
  'rawHash',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fetchText(url, { attempts = 3, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Referer: 'https://kaijiang.500.com/', Accept: 'text/xml,*/*' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(url, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchText(url, { attempts: 1 });
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr || new Error('请求失败');
}

function readExisting(file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { payload, records: Array.isArray(payload.records) ? payload.records : [] };
  } catch (err) {
    return { payload: null, records: [] };
  }
}

function emptyPrizeInfo(game) {
  if (game === GAME.SSQ) {
    return { first: null, second: null, third: null, fourth: null, fifth: null, sixth: null, fuyun: null };
  }
  return { choose10: {} };
}

function buildRecord(game, row, url) {
  const record = {
    game,
    issue: row.issue,
    drawDate: row.drawDate,
    numbers: row.numbers,
    prizeInfo: emptyPrizeInfo(game),
    specialRuleStatus: game === GAME.SSQ ? 'unknown' : 'not_applicable',
    specialRuleSource: 'pending_enrich',
    ruleVersion: null,
    sourceUrl: url,
    sourceType: SOURCE,
    parserVersion: PARSER_VERSION,
    drawStatus: 'verified',
    verifiedAt: new Date().toISOString(),
    verifiedBy: SOURCE,
    salesAmount: null,
    poolAmount: null,
    fixedPoolAmount: null,
  };
  record.rawHash = sha256(
    [game, row.issue, row.drawDate, JSON.stringify(row.numbers), PARSER_VERSION].join('|')
  );
  return record;
}

async function syncGame(game) {
  const url = listUrl(game);
  const xml = await fetchWithRetry(url);
  const rows = parseList(game, xml);
  if (!rows.length) throw new Error('XML 里没有解析出任何期次');

  const file = path.join(OUT_DIR, `${game}.json`);
  const { payload, records } = readExisting(file);
  const map = new Map(records.map((r) => [String(r.issue), r]));
  const latestExisting = records.length ? String(records[0].issue) : '0000000';

  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const added = [];

  for (const row of rows) {
    if (map.has(row.issue)) continue;
    // 只补"比库内最新更晚"或"最近 N 天"的期，避免把老历史一次性灌进来
    const isNewer = Number(row.issue) > Number(latestExisting);
    const isRecent = row.drawDate >= cutoff;
    if (!isNewer && !isRecent) continue;
    const record = buildRecord(game, row, url);
    map.set(row.issue, record);
    added.push(record);
  }

  const merged = Array.from(map.values())
    .sort((a, b) => Number(b.issue) - Number(a.issue))
    .slice(0, KEEP)
    .map((row) => {
      const out = {};
      for (const key of KEEP_FIELDS) if (row[key] !== undefined) out[key] = row[key];
      return out;
    });

  const result = {
    game,
    parsed: rows.length,
    added: added.length,
    latest: merged.length ? merged[0].issue : null,
    latestDate: merged.length ? merged[0].drawDate : null,
    addedIssues: added.map((r) => r.issue).sort((a, b) => Number(b) - Number(a)),
    kept: merged.length,
  };

  if (!dryRun) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const next = payload || { schema: 'jingcai-draws@1', game };
    next.schema = next.schema || 'jingcai-draws@1';
    next.game = game;
    next.generatedAt = new Date().toISOString();
    next.source = next.source || 'https://www.cwl.gov.cn';
    next.numbersSource = 'https://kaijiang.500.com（号码快通道）';
    next.parserVersion = PARSER_VERSION;
    next.count = merged.length;
    next.latestIssue = result.latest;
    next.records = merged;
    fs.writeFileSync(file, JSON.stringify(next, null, 1));
  }

  return result;
}

(async () => {
  const games = [GAME.SSQ, GAME.KL8];
  let failed = 0;
  for (const game of games) {
    try {
      const r = await syncGame(game);
      console.log(
        `✓ ${game}: 解析 ${r.parsed} 期，新增 ${r.added} 期${
          r.added ? `（${r.addedIssues.join('、')}）` : ''
        }，库内 ${r.kept} 期，最新 ${r.latest}（${r.latestDate}）`
      );
    } catch (err) {
      failed += 1;
      console.warn(`! ${game} 号码同步失败: ${err.message}`);
    }
  }
  if (dryRun) console.log('[dry-run] 未写盘');
  if (failed === games.length) {
    console.error('✗ 两个彩种都失败');
    process.exitCode = 1;
  }
})();
