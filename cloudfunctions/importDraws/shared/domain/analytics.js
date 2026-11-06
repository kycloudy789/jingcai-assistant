/**
 * 统计计算（纯函数，无副作用）。
 *
 * 这里只做**描述性统计**：出现了多少次、遗漏几期、和值落在哪、命中几个。
 * 不产生任何"下期倾向"结论——历史分布不改变独立随机事件的概率。
 *
 * 与 analysis.js 的分工：
 *   analytics.js = 看历史（开奖结构、个人表现）
 *   analysis.js  = 选号码（拥挤度），明确不用于预测
 */

const { GAME, GAME_META } = require('../constants/games');

const ANALYTICS_VERSION = 'analytics@1.0.0';
const WINDOWS = [30, 50, 100];

const NOTE =
  '以上均为历史描述性统计：它说明过去发生了什么，不预示下一期。样本量越小，波动越大。';

function isGame(game) {
  return game === GAME.SSQ || game === GAME.KL8;
}

function sortedDraws(draws) {
  return (draws || [])
    .filter((d) => d && d.numbers)
    .slice()
    .sort((a, b) => Number(b.issue) - Number(a.issue));
}

function mainNumbers(game, draw) {
  if (game === GAME.SSQ) return (draw.numbers && draw.numbers.red) || [];
  return (draw.numbers && draw.numbers.kl8) || [];
}

function mean(list) {
  if (!list.length) return 0;
  return list.reduce((acc, n) => acc + n, 0) / list.length;
}

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

function percentile(list, p) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

/**
 * 号码频次与当前遗漏。
 * @param {'ssq'|'kl8'} game
 * @param {Array} draws 开奖记录（任意顺序，内部按 issue 降序）
 * @param {{window?: number}} [options]
 */
function numberFrequency(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) {
    return {
      ok: false,
      code: 'NO_DRAWS',
      message: '本地还没有已核验的开奖数据，先在「开奖」页同步',
    };
  }

  const meta = GAME_META[game];
  const max = game === GAME.SSQ ? meta.redMax : meta.max;
  const rows = [];
  for (let n = 1; n <= max; n += 1) rows.push({ number: n, count: 0, omission: list.length });

  // list 已按最新在前，第一次遇到即为"当前遗漏"
  list.forEach((d, idx) => {
    for (const n of mainNumbers(game, d)) {
      const row = rows[n - 1];
      if (!row) continue;
      row.count += 1;
      if (row.omission === list.length) row.omission = idx;
    }
  });

  for (const row of rows) row.rate = Math.round((row.count / list.length) * 1000) / 10;

  const blue = [];
  if (game === GAME.SSQ) {
    for (let n = 1; n <= meta.blueMax; n += 1) blue.push({ number: n, count: 0, omission: list.length });
    list.forEach((d, idx) => {
      const b = d.numbers && d.numbers.blue;
      if (b === null || b === undefined) return;
      const row = blue[b - 1];
      if (!row) return;
      row.count += 1;
      if (row.omission === list.length) row.omission = idx;
    });
    for (const row of blue) row.rate = Math.round((row.count / list.length) * 1000) / 10;
  }

  const byCount = rows.slice().sort((a, b) => b.count - a.count || a.number - b.number);
  const byOmission = rows.slice().sort((a, b) => b.omission - a.omission || a.number - b.number);

  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    requestedWindow: window,
    issueRange: { from: list[list.length - 1].issue, to: list[0].issue },
    rows,
    blue: game === GAME.SSQ ? blue : undefined,
    mostSeen: byCount.slice(0, 5),
    leastSeen: byCount.slice(-5).reverse(),
    longestOmission: byOmission.slice(0, 5),
    note: list.length < window ? `请求 ${window} 期，本地只有 ${list.length} 期，样本偏小。` : NOTE,
  };
}

/** 和值分布：分桶 + 分位 */
function sumDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const sums = list.map((d) => mainNumbers(game, d).reduce((acc, n) => acc + n, 0));
  const min = Math.min(...sums);
  const max = Math.max(...sums);
  const bucketCount = 6;
  const step = Math.max(1, Math.ceil((max - min + 1) / bucketCount));
  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const from = min + i * step;
    const to = from + step - 1;
    buckets.push({ from, to, count: sums.filter((s) => s >= from && s <= to).length });
  }

  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    min,
    max,
    avg: Math.round(mean(sums) * 10) / 10,
    median: median(sums),
    p25: percentile(sums, 25),
    p75: percentile(sums, 75),
    buckets,
    note: NOTE,
  };
}

/** 奇偶分布：奇数个数 → 期数 */
function parityDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const count = game === GAME.SSQ ? GAME_META[GAME.SSQ].redCount : GAME_META[GAME.KL8].count;
  const rows = [];
  for (let i = 0; i <= count; i += 1) rows.push({ odd: i, even: count - i, count: 0 });
  for (const d of list) {
    const odd = mainNumbers(game, d).filter((n) => n % 2 === 1).length;
    if (rows[odd]) rows[odd].count += 1;
  }
  return { ok: true, game, window, sampleSize: list.length, rows, note: NOTE };
}

/** 三区（双色球）/ 四区（快乐8）分布 */
function zoneDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const zones = game === GAME.SSQ
    ? [
        { label: '1–11', from: 1, to: 11 },
        { label: '12–22', from: 12, to: 22 },
        { label: '23–33', from: 23, to: 33 },
      ]
    : [
        { label: '1–20', from: 1, to: 20 },
        { label: '21–40', from: 21, to: 40 },
        { label: '41–60', from: 41, to: 60 },
        { label: '61–80', from: 61, to: 80 },
      ];

  const totals = zones.map(() => 0);
  let brokenZoneIssues = 0;
  for (const d of list) {
    const nums = mainNumbers(game, d);
    const counts = zones.map((z) => nums.filter((n) => n >= z.from && n <= z.to).length);
    counts.forEach((c, i) => {
      totals[i] += c;
    });
    if (counts.some((c) => c === 0)) brokenZoneIssues += 1;
  }

  const totalBalls = totals.reduce((acc, n) => acc + n, 0) || 1;
  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    zones: zones.map((z, i) => ({
      label: z.label,
      count: totals[i],
      share: Math.round((totals[i] / totalBalls) * 1000) / 10,
      avgPerIssue: Math.round((totals[i] / list.length) * 100) / 100,
    })),
    brokenZoneIssues,
    note: `${NOTE} 断区（某区一个号都没出）在 ${list.length} 期里出现 ${brokenZoneIssues} 次，属于正常波动，不是"该回补"的信号。`,
  };
}

/** 连号出现情况 */
function consecutiveDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const rows = [];
  for (const d of list) {
    const nums = mainNumbers(game, d).slice().sort((a, b) => a - b);
    let pairs = 0;
    for (let i = 1; i < nums.length; i += 1) if (nums[i] - nums[i - 1] === 1) pairs += 1;
    rows.push({ issue: d.issue, pairs });
  }
  const withConsecutive = rows.filter((r) => r.pairs > 0).length;
  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    withConsecutive,
    share: Math.round((withConsecutive / list.length) * 1000) / 10,
    avgPairs: Math.round(mean(rows.map((r) => r.pairs)) * 100) / 100,
    note: NOTE,
  };
}

/**
 * 个人命中分布：从核对结果统计"每注命中几个"。
 * 双色球按红球命中数分桶，并单独统计蓝球；快乐8按命中个数分桶。
 * 只统计有核对结果的记录（草稿不参与）。
 */
function hitDistribution(game, checks) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const list = (checks || []).filter((c) => c && c.game === game && c.hitDetails);
  if (!list.length) {
    return { ok: false, code: 'NO_CHECKS', message: '还没有核对结果，先到「我的号码」点一键核对' };
  }

  if (game === GAME.SSQ) {
    const rows = [];
    for (let i = 0; i <= 6; i += 1) rows.push({ hits: i, count: 0 });
    let blueHits = 0;
    for (const c of list) {
      const red = Number(c.hitDetails.red) || 0;
      if (rows[red]) rows[red].count += 1;
      if (c.hitDetails.blue) blueHits += 1;
    }
    return {
      ok: true,
      game,
      sampleSize: list.length,
      rows,
      blueHits,
      note: '统计的是已核对过的记录（每注一条），同一注重算不会重复计数。',
    };
  }

  const rows = [];
  for (let i = 0; i <= 10; i += 1) rows.push({ hits: i, count: 0 });
  for (const c of list) {
    const hits = Number(c.hitDetails.count);
    if (Number.isInteger(hits) && rows[hits]) rows[hits].count += 1;
  }
  return {
    ok: true,
    game,
    sampleSize: list.length,
    rows,
    note: '统计的是已核对过的记录（每注一条），同一注重算不会重复计数。',
  };
}

/** 汇总：一次算完统计页需要的所有块 */
function buildAnalytics(game, draws, checks, options = {}) {
  return {
    version: ANALYTICS_VERSION,
    game,
    frequency: numberFrequency(game, draws, options),
    sum: sumDistribution(game, draws, options),
    parity: parityDistribution(game, draws, options),
    zones: zoneDistribution(game, draws, options),
    consecutive: consecutiveDistribution(game, draws, options),
    hits: hitDistribution(game, checks),
  };
}

module.exports = {
  ANALYTICS_VERSION,
  WINDOWS,
  NOTE,
  numberFrequency,
  sumDistribution,
  parityDistribution,
  zoneDistribution,
  consecutiveDistribution,
  hitDistribution,
  buildAnalytics,
};
