/**
 * 只同步"开奖号码"（最快通道，多源兜底）。
 *
 * 设计取舍：奖级明细可以延后，号码不能落后。
 * 官方接口在 GitHub 上 403，所以号码走第三方；单源一跳闸就停更，
 * 因此这里按顺序试多个独立源，任何一个成功就够：
 *
 *   1. 500.com 静态 XML（全量，约 0.4MB，最快）
 *   2. 17500.cn 明文 txt（全量，独立站点，约 0.5–1MB）
 *
 * 多源之间如果同一期号码不一致，**以先试到的源为准并告警**，
 * 不静默采信任何一个（号码错一个，判奖就全错）。
 *
 * 行为：
 *   - 只新增缺失期次，已有记录（含官方奖级明细）一个字段都不覆盖；
 *   - 新增记录没有 prizeInfo：浮动奖显示"待公告"，固定奖照常判；
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
const kaijiang = require('../shared/adapters/kaijiang-xml');
const txt17500 = require('../shared/adapters/txt17500');

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

function fetchText(url, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'text/xml,text/plain,*/*' } },
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

async function fetchWithRetry(url, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchText(url);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr || new Error('请求失败');
}

/** 每个彩种的源列表（顺序 = 优先级） */
function sourcesFor(game) {
  const list = [];
  const xmlUrl = kaijiang.listUrl(game);
  if (xmlUrl) {
    list.push({
      id: '500-xml',
      url: xmlUrl,
      parse: (text) => kaijiang.parseList(game, text),
      sourceType: kaijiang.SOURCE,
      parserVersion: kaijiang.PARSER_VERSION,
    });
  }
  const txtUrl = txt17500.listUrl(game);
  if (txtUrl) {
    list.push({
      id: '17500-txt',
      url: txtUrl,
      parse: (text) => txt17500.parseText(game, text),
      sourceType: txt17500.SOURCE,
      parserVersion: txt17500.PARSER_VERSION,
    });
  }
  return list;
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

function buildRecord(game, row, source) {
  const record = {
    game,
    issue: row.issue,
    drawDate: row.drawDate,
    numbers: row.numbers,
    prizeInfo: emptyPrizeInfo(game),
    specialRuleStatus: game === GAME.SSQ ? 'unknown' : 'not_applicable',
    specialRuleSource: 'pending_enrich',
    ruleVersion: null,
    sourceUrl: source.url,
    sourceType: source.sourceType,
    parserVersion: source.parserVersion,
    drawStatus: 'verified',
    verifiedAt: new Date().toISOString(),
    verifiedBy: source.sourceType,
    salesAmount: null,
    poolAmount: null,
    fixedPoolAmount: null,
  };
  record.rawHash = sha256(
    [game, row.issue, row.drawDate, JSON.stringify(row.numbers), source.parserVersion].join('|')
  );
  return record;
}

function sameNumbers(a, b) {
  return JSON.stringify(a.red) === JSON.stringify(b.red) && a.blue === b.blue &&
    JSON.stringify(a.kl8) === JSON.stringify(b.kl8);
}

async function collect(game) {
  const sources = sourcesFor(game);
  const usable = [];
  const conflicts = [];

  for (const source of sources) {
    try {
      const text = await fetchWithRetry(source.url);
      const rows = source.parse(text);
      if (!rows.length) throw new Error('解析出 0 期');
      console.log(`    · ${source.id}: ${rows.length} 期`);
      usable.push({ source, rows });
    } catch (err) {
      console.warn(`    · ${source.id} 失败: ${err.message}`);
    }
  }

  // 多源合并：先到的源优先，后面只补它没有的期；同一期号码不一致要报警
  const byIssue = new Map(); // issue -> { row, source }
  for (const { source, rows } of usable) {
    for (const row of rows) {
      const prev = byIssue.get(row.issue);
      if (!prev) {
        byIssue.set(row.issue, { row, source });
      } else if (!sameNumbers(prev.row.numbers, row.numbers)) {
        conflicts.push({ issue: row.issue, keep: prev.source.id, other: source.id });
      }
    }
  }

  return { byIssue, sources: usable.map((u) => u.source.id), conflicts };
}

async function syncGame(game) {
  const file = path.join(OUT_DIR, `${game}.json`);
  const { payload, records } = readExisting(file);
  const map = new Map(records.map((r) => [String(r.issue), r]));
  const latestExisting = records.length ? String(records[0].issue) : '0000000';

  const { byIssue, sources, conflicts } = await collect(game);
  if (!byIssue.size) throw new Error('所有号码源都失败');

  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const added = [];

  for (const [issue, { row, source }] of byIssue) {
    if (map.has(issue)) continue;
    const isNewer = Number(issue) > Number(latestExisting);
    const isRecent = row.drawDate >= cutoff;
    if (!isNewer && !isRecent) continue;
    const record = buildRecord(game, row, source);
    map.set(issue, record);
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
    sources,
    parsed: byIssue.size,
    added: added.length,
    latest: merged.length ? merged[0].issue : null,
    latestDate: merged.length ? merged[0].drawDate : null,
    addedIssues: added.map((r) => r.issue).sort((a, b) => Number(b) - Number(a)),
    kept: merged.length,
    conflicts,
  };

  if (!dryRun) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const next = payload || { schema: 'jingcai-draws@1', game };
    next.schema = next.schema || 'jingcai-draws@1';
    next.game = game;
    next.generatedAt = new Date().toISOString();
    next.source = next.source || 'https://www.cwl.gov.cn';
    next.numbersSource = 'https://kaijiang.500.com + https://data.17500.cn（号码快通道）';
    next.parserVersion = kaijiang.PARSER_VERSION;
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
  const conflicts = [];

  for (const game of games) {
    try {
      const r = await syncGame(game);
      conflicts.push(...r.conflicts);
      console.log(
        `✓ ${game}: 源 ${r.sources.join(' + ')}，共 ${r.parsed} 期，新增 ${r.added} 期${
          r.added ? `（${r.addedIssues.join('、')}）` : ''
        }，库内 ${r.kept} 期，最新 ${r.latest}（${r.latestDate}）`
      );
    } catch (err) {
      failed += 1;
      console.warn(`! ${game} 号码同步失败: ${err.message}`);
    }
  }

  if (conflicts.length) {
    console.warn(`⚠ 多源号码不一致 ${conflicts.length} 期（已按先到的源保留，请人工核对）：`);
    for (const c of conflicts.slice(0, 5)) console.warn(`   ${c.issue}: 采用 ${c.keep}，${c.other} 不同`);
  }

  if (dryRun) console.log('[dry-run] 未写盘');
  if (failed === games.length) {
    console.error('✗ 两个彩种都失败');
    process.exitCode = 1;
  }
})();
