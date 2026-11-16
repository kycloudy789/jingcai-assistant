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

// 云端定时会被 GitHub 推迟（实测 5–8 小时），所以把"等开奖"做进脚本本身：
// 提前跑到窗口前就睡到窗口，然后在窗口内每 4 分钟重试，直到拿到新一期。
const WAIT_DRAW = args.includes('--wait-draw');
const WAIT = {
  start: 20 * 60 + 40, // 北京 20:40（双色球 21:15、快乐8 21:30 开奖）
  end: 23 * 60 + 56, // 北京 23:56，之后不再等
  maxPreWait: 150, // 最多提前等 150 分钟（受单次任务 6 小时上限约束）
  intervalMs: 4 * 60 * 1000,
  maxRounds: 50,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 北京时间的"当天第几分钟"，避免服务器时区差异 */
function bjMinuteOfDay() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function bjClock() {
  const m = bjMinuteOfDay();
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 北京日期 YYYY-MM-DD（用 UTC 字段读"已偏移 8 小时"的时间） */
function bjDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 双色球每周二/四/日开奖；快乐8 每天开奖 */
const SSQ_WEEKDAYS = [0, 2, 4];

/** 某个星期几（0=周日）该开哪些彩种 —— 纯函数，便于测试 */
function gamesExpectedOn(weekday) {
  return SSQ_WEEKDAYS.includes(weekday) ? [GAME.SSQ, GAME.KL8] : [GAME.KL8];
}

/** 今晚"应该"出新一期的彩种 */
function gamesExpectedToday() {
  return gamesExpectedOn(new Date(Date.now() + 8 * 3600 * 1000).getUTCDay());
}

function latestRecordOf(game) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${game}.json`), 'utf8'));
    return (payload.records || [])[0] || null;
  } catch (err) {
    return null;
  }
}

/** 今晚还缺哪些彩种的新一期（缺 → 需要继续等） */
function pendingTonight() {
  const today = bjDate();
  return gamesExpectedToday().filter((g) => {
    const r = latestRecordOf(g);
    return !r || String(r.drawDate) < today;
  });
}

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

/** 跑一轮全量同步，返回本轮新增了多少期（用于判断"新一期到了没"） */
async function runOnce({ quiet = false } = {}) {
  const games = [GAME.SSQ, GAME.KL8];
  let failed = 0;
  let added = 0;
  const conflicts = [];

  for (const game of games) {
    try {
      const r = await syncGame(game);
      conflicts.push(...r.conflicts);
      added += r.added;
      console.log(
        `${quiet ? '·' : '✓'} ${game}: 源 ${r.sources.join(' + ')}，共 ${r.parsed} 期，新增 ${r.added} 期${
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

  return { added, failed, total: games.length };
}

async function main() {
  const first = await runOnce();
  let failed = first.failed;

  if (WAIT_DRAW && !dryRun) {
    let pending = pendingTonight();

    if (!pending.length) {
      console.log(`[等开奖] 今晚该出的期次已经齐了（北京 ${bjClock()}），不再等待`);
    } else {
      const now = bjMinuteOfDay();
      if (now < WAIT.start) {
        const gap = WAIT.start - now;
        if (gap > WAIT.maxPreWait) {
          console.log(
            `[等开奖] 现在北京 ${bjClock()}，距开奖窗口还有 ${gap} 分钟，超出单次任务预算，` +
              `本轮不再等待（缺 ${pending.join('/')}，交给下一次定时）`
          );
          pending = [];
        } else {
          console.log(
            `[等开奖] 现在北京 ${bjClock()}，缺 ${pending.join('/')}，先等到 20:40 再轮询（约 ${gap} 分钟）`
          );
          await sleep(gap * 60000);
        }
      }

      let rounds = 0;
      while (pending.length && bjMinuteOfDay() <= WAIT.end && rounds < WAIT.maxRounds) {
        rounds += 1;
        console.log(`[等开奖] 第 ${rounds} 次重试（北京 ${bjClock()}），仍缺 ${pending.join('/')}`);
        await sleep(WAIT.intervalMs);
        const r = await runOnce({ quiet: true });
        failed = r.failed;
        pending = pendingTonight();
      }

      if (!pending.length) {
        console.log(`[等开奖] 全部到齐（北京 ${bjClock()}）`);
      } else if (bjMinuteOfDay() > WAIT.end) {
        console.log(`[等开奖] 已过 23:56，仍缺 ${pending.join('/')}，本轮结束`);
      }
    }
  }

  if (dryRun) console.log('[dry-run] 未写盘');
  if (failed === first.total) {
    console.error('✗ 两个彩种都失败');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { runOnce, bjMinuteOfDay, bjDate, gamesExpectedOn, gamesExpectedToday, pendingTonight, WAIT };
