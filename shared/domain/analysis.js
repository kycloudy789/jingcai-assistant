/**
 * 号码分析：结构画像 + 拥挤度（"会不会被很多人同时选中"）。
 *
 * 这个文件只回答两个问题：
 *   1. 这组号码的形态是什么？（和值/跨度/奇偶/大小/分区/连号/AC/重号）
 *   2. 这组号码有多"像大众会选的号"？（拥挤度指数）
 *
 * 它明确不回答"下期会开什么"——那在数学上不成立，不做。
 *
 * 拥挤度的现实意义：
 *   双色球一/二等奖、快乐8选十中十是**浮动奖**，按中奖注数均分。
 *   中奖概率与号码选择无关，但"有多少人跟你选了同一组"会影响到手金额。
 *   所以避开大众偏好，改变的是"中了分多少"，不是"能不能中"。
 *
 * 研究依据（参数据此设定，不是拍脑袋）：
 *   - Cook & Clotfelter (1993) "conscious selection"：玩家系统性偏向日期号，1–31 被超额选择。
 *   - Farrell, Hartley, Lanot & Walker (2000)：英国彩票中 7 最热，被选频率比最冷的 46 高约 25%。
 *   - Cox 等 (1998, JRSS-A)：冷门组合长期回报约 95 便士/英镑，随机约 45 便士（仍 < 1，赚不了钱）。
 *   - Baker & McHale (2009)：玩家偏爱"看起来像设计过"的票（连号、等差、等间距）。
 *
 * 重要限制：中国福彩不公布每注号码的投注分布，因此这里的权重是**基于公开研究的推定**，
 * 不是实测数据。界面必须如实标注这一点，不得表述为"测算出的真实中奖人数"。
 */

const { GAME, GAME_META } = require('../constants/games');

const CROWD_MODEL_VERSION = 'crowd@1.0.0';

const CODE = {
  OK: 'OK',
  BAD_GAME: 'BAD_GAME',
  BAD_NUMBERS: 'BAD_NUMBERS',
};

/** 拥挤度等级（按指数切分，越低越冷门） */
const CROWD_LEVEL = {
  LOW: 'low',
  MEDIUM_LOW: 'medium_low',
  MEDIUM: 'medium',
  MEDIUM_HIGH: 'medium_high',
  HIGH: 'high',
};

const CROWD_LEVEL_TEXT = {
  low: '低',
  medium_low: '中低',
  medium: '中',
  medium_high: '中高',
  high: '高',
};

/**
 * 权重表：单位是"人群偏好分"，正数=更像大众会选，负数=大众回避。
 * 全部集中在这里，改权重必须升 CROWD_MODEL_VERSION 并补测试。
 */
const WEIGHTS = {
  // 生日区（日期可达）：按"超出随机期望的个数"计，而不是按绝对个数。
  // 双色球只有 32/33 两个号在日期之外，若按绝对个数算，几乎每注都会被判"拥挤"，
  // 指数就失去区分度——这是第一版校准踩过的坑。
  birthdayExcess: 1.6,
  monthDayExcess: 0.5, // ≤12 的号码（既是日也是月），同样按超出期望计
  // 文化偏好
  luckyCN: 0.5, // 6 / 8 / 9
  unluckyCN: -0.5, // 4（中文语境忌讳，被选得更少）
  luckySeven: 0.6, // 7（多国数据一致偏热）
  // 形态
  allInBirthdayZone: 3.0, // 整注都在 1–31
  consecutivePair: 0.8, // 每有一对连号
  arithmeticRun: 2.0, // 存在长度 ≥3 的等差
  sameTailPair: 0.4, // 同尾号（个位相同）每对
  repeatWithPrev: 1.0, // 与上期重号，每个
  centerSum: 0.5, // 和值落在"最常见区间"（看着最正常）
  allOddOrEven: -0.8, // 全奇/全偶，人很少这么选
  // 蓝球
  blueMonthDay: 0.5, // 蓝球 ≤12
  blueHigh: -0.3, // 蓝球 13–16
  blueLucky: 0.4, // 蓝球 7 / 8
};

/** 和值"最正常"的区间：双色球按研究常提到的 85–115；快乐8 按 10 个号的均值换算 */
const CENTER_SUM = {
  [GAME.SSQ]: [85, 115],
  [GAME.KL8]: [360, 450],
};

function numList(game, numbers) {
  if (game === GAME.SSQ) return (numbers && numbers.red) || [];
  return (numbers && numbers.kl8) || [];
}

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** 连号对数：相邻且差 1 的号码对 */
function consecutivePairs(list) {
  const sorted = list.slice().sort((a, b) => a - b);
  const pairs = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) pairs.push([sorted[i - 1], sorted[i]]);
  }
  return pairs;
}

/**
 * 是否存在"看起来被设计过"的等差数列。
 * 阈值：长度 ≥4，或长度 3 且公差为 1（三连号）。
 * 随意 6 个号里出现 3 项等差太常见，不算大众模式，否则会误伤普通组合。
 */
function hasArithmeticRun(list, minLen = 4) {
  const sorted = list.slice().sort((a, b) => a - b);
  for (let i = 0; i <= sorted.length - minLen; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const step = sorted[j] - sorted[i];
      if (step <= 0) continue;
      let count = 2;
      let last = sorted[j];
      for (let k = j + 1; k < sorted.length; k += 1) {
        if (sorted[k] - last === step) {
          count += 1;
          last = sorted[k];
          const qualifies = count >= minLen || (count === 3 && step === 1);
          if (qualifies) return { start: sorted[i], step, length: count };
        } else if (sorted[k] - last > step) {
          break;
        }
      }
    }
  }
  return null;
}

/** 同尾号对数（个位相同） */
function sameTailPairs(list) {
  const buckets = new Map();
  for (const n of list) {
    const tail = n % 10;
    buckets.set(tail, (buckets.get(tail) || 0) + 1);
  }
  let pairs = 0;
  for (const count of buckets.values()) {
    if (count >= 2) pairs += (count * (count - 1)) / 2;
  }
  return pairs;
}

/** AC 值：不同差值个数 - (号码个数 - 1)，衡量号码离散程度 */
function acValue(list) {
  const diffs = new Set();
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      diffs.add(Math.abs(list[j] - list[i]));
    }
  }
  return diffs.size - (list.length - 1);
}

/**
 * 结构画像：纯描述，不含任何倾向性判断。
 * @param {'ssq'|'kl8'} game
 * @param {{red?:number[], blue?:number, kl8?:number[]}} numbers
 * @param {{previousDraw?: object}} [options]
 */
function describeStructure(game, numbers, options = {}) {
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.BAD_GAME, message: '彩种不合法' };
  }
  const main = numList(game, numbers);
  const count = game === GAME.SSQ ? GAME_META[GAME.SSQ].redCount : GAME_META[GAME.KL8].count;
  if (!Array.isArray(main) || main.length !== count) {
    return { ok: false, code: CODE.BAD_NUMBERS, message: `号码数量应为 ${count} 个` };
  }

  const sorted = main.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const span = sorted[sorted.length - 1] - sorted[0];
  const odd = sorted.filter((n) => n % 2 === 1).length;
  const even = sorted.length - odd;
  const bigLine = game === GAME.SSQ ? 17 : 41;
  const big = sorted.filter((n) => n >= bigLine).length;
  const small = sorted.length - big;

  const zones = game === GAME.SSQ
    ? [
        [1, 11],
        [12, 22],
        [23, 33],
      ]
    : [
        [1, 20],
        [21, 40],
        [41, 60],
        [61, 80],
      ];
  const zoneCounts = zones.map(() => 0);
  for (const n of sorted) {
    for (let i = 0; i < zones.length; i += 1) {
      if (n >= zones[i][0] && n <= zones[i][1]) {
        zoneCounts[i] += 1;
        break;
      }
    }
  }

  const prev = options.previousDraw ? numList(game, options.previousDraw.numbers) : [];
  const repeats = prev.length ? sorted.filter((n) => prev.includes(n)) : [];
  const pairs = consecutivePairs(sorted);
  const run = hasArithmeticRun(sorted);
  const center = CENTER_SUM[game];
  const inCenterSum = sum >= center[0] && sum <= center[1];

  return {
    ok: true,
    game,
    numbers: sorted,
    blue: game === GAME.SSQ && numbers.blue !== undefined ? numbers.blue : null,
    sum,
    span,
    odd,
    even,
    big,
    small,
    zones: zoneCounts,
    zoneLabels: game === GAME.SSQ ? ['1–11', '12–22', '23–33'] : ['1–20', '21–40', '41–60', '61–80'],
    consecutivePairs: pairs.length,
    consecutive: pairs,
    arithmeticRun: run,
    sameTailPairs: sameTailPairs(sorted),
    acValue: acValue(sorted),
    repeats,
    inCenterSum,
    centerSumRange: center,
    count: sorted.length,
  };
}

/**
 * 拥挤度指数：0（最冷门）–100（最拥挤）。
 * 这是公开研究推导出的**推定值**，不是实测投注人数。
 */
function crowdIndex(game, numbers, options = {}) {
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.BAD_GAME, message: '彩种不合法' };
  }
  const main = numList(game, numbers);
  const count = game === GAME.SSQ ? GAME_META[GAME.SSQ].redCount : GAME_META[GAME.KL8].count;
  if (!Array.isArray(main) || main.length !== count) {
    return { ok: false, code: CODE.BAD_NUMBERS, message: `号码数量应为 ${count} 个` };
  }

  const sorted = main.slice().sort((a, b) => a - b);
  const factors = [];
  let score = 0;

  const add = (key, label, delta) => {
    if (!delta) return;
    score += delta;
    factors.push({ key, label, delta: Math.round(delta * 100) / 100 });
  };

  const poolMax = game === GAME.SSQ ? GAME_META[GAME.SSQ].redMax : GAME_META[GAME.KL8].max;
  const lowInBirthday = sorted.filter((n) => n <= 31).length;
  const highAbove = sorted.filter((n) => n > 31).length;
  const monthDay = sorted.filter((n) => n <= 12).length;
  const lucky = sorted.filter((n) => n === 6 || n === 8 || n === 9).length;
  const unlucky = sorted.filter((n) => n === 4).length;
  const sevens = sorted.filter((n) => n === 7).length;

  // 随机选号时"落在生日区"的期望个数；超出多少才算偏大众
  const expectedLow = (31 / poolMax) * sorted.length;
  const expectedMonthDay = (12 / poolMax) * sorted.length;
  const lowExcess = lowInBirthday - expectedLow;
  const monthExcess = monthDay - expectedMonthDay;

  add(
    'birthdayZone',
    `${lowInBirthday} 个号在 1–31（随机期望约 ${expectedLow.toFixed(1)} 个）`,
    lowExcess * WEIGHTS.birthdayExcess
  );
  add(
    'monthDay',
    `${monthDay} 个号 ≤12（日/月重叠，随机期望约 ${expectedMonthDay.toFixed(1)} 个）`,
    monthExcess * WEIGHTS.monthDayExcess
  );
  add('luckyCN', `${lucky} 个号码是 6/8/9（中文吉利数）`, lucky * WEIGHTS.luckyCN);
  add('unluckyCN', `${unlucky} 个号码是 4（中文忌讳，反而少人选）`, unlucky * WEIGHTS.unluckyCN);
  add('luckySeven', `${sevens} 个号码是 7（多国最热号）`, sevens * WEIGHTS.luckySeven);

  if (highAbove === 0) add('allInBirthdayZone', '整注都在 1–31 内', WEIGHTS.allInBirthdayZone);

  const pairs = consecutivePairs(sorted).length;
  add('consecutivePair', `${pairs} 对连号`, Math.min(pairs, 2) * WEIGHTS.consecutivePair);

  const run = hasArithmeticRun(sorted);
  add('arithmeticRun', run ? `存在等差 ${run.start} 起、公差 ${run.step}` : '', run ? WEIGHTS.arithmeticRun : 0);

  const tails = sameTailPairs(sorted);
  add('sameTailPair', `${tails} 对同尾号`, Math.min(tails, 2) * WEIGHTS.sameTailPair);

  const prev = options.previousDraw ? numList(game, options.previousDraw.numbers) : [];
  const repeats = prev.length ? sorted.filter((n) => prev.includes(n)) : [];
  add('repeatWithPrev', prev.length ? `${repeats.length} 个号与上期重号` : '', Math.min(repeats.length, 3) * WEIGHTS.repeatWithPrev);

  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const center = CENTER_SUM[game];
  const inCenter = sum >= center[0] && sum <= center[1];
  add('centerSum', inCenter ? `和值 ${sum} 落在「最常见」区间` : '', inCenter ? WEIGHTS.centerSum : 0);

  const odd = sorted.filter((n) => n % 2 === 1).length;
  if (odd === 0 || odd === sorted.length) {
    add('allOddOrEven', odd === 0 ? '全偶数（人很少这么选）' : '全奇数（人很少这么选）', WEIGHTS.allOddOrEven);
  }

  if (game === GAME.SSQ && numbers.blue !== undefined && numbers.blue !== null) {
    const blue = numbers.blue;
    add('blueMonthDay', blue <= 12 ? `蓝球 ${blue} ≤12（日期可达）` : '', blue <= 12 ? WEIGHTS.blueMonthDay : 0);
    add('blueHigh', blue > 12 ? `蓝球 ${blue} 在 13–16（日期不可达）` : '', blue > 12 ? WEIGHTS.blueHigh : 0);
    add('blueLucky', blue === 7 || blue === 8 ? `蓝球 ${blue} 是热门号` : '', blue === 7 || blue === 8 ? WEIGHTS.blueLucky : 0);
  }

  const index = Math.max(0, Math.min(100, Math.round(50 + score * 5)));
  const level =
    index <= 25
      ? CROWD_LEVEL.LOW
      : index <= 42
      ? CROWD_LEVEL.MEDIUM_LOW
      : index <= 58
      ? CROWD_LEVEL.MEDIUM
      : index <= 72
      ? CROWD_LEVEL.MEDIUM_HIGH
      : CROWD_LEVEL.HIGH;

  return {
    ok: true,
    game,
    index,
    level,
    levelText: CROWD_LEVEL_TEXT[level],
    score: Math.round(score * 100) / 100,
    factors: factors.filter((f) => f.delta !== 0),
    modelVersion: CROWD_MODEL_VERSION,
    caveat:
      '拥挤度是基于公开研究（生日偏好、幸运号、连号/等差偏好等）推导的推定值，不是实测投注人数——中国福彩不公布每注号码的投注分布。它只影响浮动奖的均分，不改变中奖概率。',
  };
}

/** 组合分析：一次拿到结构 + 拥挤度 */
function analyzeNumbers(game, numbers, options = {}) {
  const structure = describeStructure(game, numbers, options);
  if (!structure.ok) return structure;
  const crowd = crowdIndex(game, numbers, options);
  if (!crowd.ok) return crowd;
  return {
    ok: true,
    game,
    numbers: structure.numbers,
    structure,
    crowd,
    note: '结构是描述，拥挤度是推定；两者都不改变中奖概率。',
  };
}

/**
 * 冷号：近 window 期一次都没出现的号码。
 * 用途只有一个——当作"大众会回避的号"来降低拥挤度，
 * **不是**"该回补了"。这两件事必须区分清楚。
 */
function coldNumbers(game, recentDraws, window = 30) {
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.BAD_GAME, message: '彩种不合法' };
  }
  const meta = GAME_META[game];
  const max = game === GAME.SSQ ? meta.redMax : meta.max;
  const list = (recentDraws || []).slice(0, Math.max(0, window));
  if (!list.length) {
    return { ok: true, window: 0, sampleSize: 0, cold: [], frequencies: {}, note: '没有历史开奖数据，冷号为空' };
  }
  const freq = {};
  for (let n = 1; n <= max; n += 1) freq[n] = 0;
  for (const d of list) {
    const nums = numList(game, d.numbers);
    for (const n of nums) {
      if (freq[n] !== undefined) freq[n] += 1;
    }
  }
  const cold = Object.keys(freq)
    .map(Number)
    .filter((n) => freq[n] === 0)
    .sort((a, b) => a - b);
  return {
    ok: true,
    window: list.length,
    sampleSize: list.length,
    cold,
    frequencies: freq,
    note: '冷号只代表这段时间没出现过，不代表下期更可能或更不可能出现。',
  };
}

module.exports = {
  CROWD_MODEL_VERSION,
  CROWD_LEVEL,
  CROWD_LEVEL_TEXT,
  WEIGHTS,
  CODE,
  describeStructure,
  crowdIndex,
  analyzeNumbers,
  coldNumbers,
  consecutivePairs,
  hasArithmeticRun,
  sameTailPairs,
  acValue,
};
