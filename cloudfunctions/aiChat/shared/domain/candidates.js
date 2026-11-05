/**
 * 候选号码组合生成（阶段 6）。
 *
 * 三条硬约束：
 *   1. 纯函数 + 确定性：同一个 (game, strategy, count, seed, params) 永远得到同一批号码。
 *      这样"这批号码哪来的"可以复现，开奖后能复盘，而不是每次点都不一样。
 *   2. 只产出候选，不产出"买了"。落到号码表里一律是 draft（见 shared/domain/tickets.js）。
 *   3. 不做任何"提升中奖机会"的暗示：策略只是结构约束（分区/奇偶/偏好），
 *      不读历史频次做加权——把冷热包装成算法能力属于伪预测，这里明确不做。
 *
 * 术语：一"注"（group）在双色球是 6 红 + 1 蓝，在快乐8选十是 10 个号码。
 */

const { GAME, GAME_META, isGame } = require('../constants/games');
const { isValidIssue } = require('../rules/registry');

const ALGORITHM_VERSION = 'candidate@1.0.0';

const STRATEGY = {
  RANDOM: 'random',
  BALANCED: 'balanced',
  PREFERENCE: 'preference',
};

const STRATEGY_META = {
  [STRATEGY.RANDOM]: {
    label: '随机',
    desc: '从号码池等概率抽取，每注互不相同。',
  },
  [STRATEGY.BALANCED]: {
    label: '分区均衡',
    desc: '按号码区间与奇偶做结构均衡，避免出现全小或全奇这类结构。',
  },
  [STRATEGY.PREFERENCE]: {
    label: '偏好约束',
    desc: '先满足你指定的必含/排除号码，余下随机补足。',
  },
};

const CODE = {
  OK: 'OK',
  BAD_GAME: 'BAD_GAME',
  BAD_STRATEGY: 'BAD_STRATEGY',
  BAD_COUNT: 'BAD_COUNT',
  BAD_ISSUE: 'BAD_ISSUE',
  BAD_SEED: 'BAD_SEED',
  BAD_INCLUDE: 'BAD_INCLUDE',
  BAD_EXCLUDE: 'BAD_EXCLUDE',
  NO_ROOM: 'NO_ROOM',
  DUPLICATE_EXHAUSTED: 'DUPLICATE_EXHAUSTED',
};

const MIN_COUNT = 1;
const MAX_COUNT = 5;
const DEFAULT_COUNT = 3;
const MAX_EXCLUDE_NUMBERS = 30;
const MAX_ATTEMPTS_PER_GROUP = 80;

/* ---------------- 确定性随机源 ---------------- */

/** FNV-1a 32 位哈希：把任意种子文本折成 uint32 */
function hashSeed(input) {
  const text = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32：小、快、可复现。
 * 不是密码学随机，这里也不需要——目的是"同种子同结果"，不是防预测。
 */
function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 规范化种子。
 * - 整数 / 数字字符串 → 折成 uint32
 * - 其他字符串（如 "batch-2026-11-05"）→ 哈希
 * - 缺省 → 随机生成，并把实际用到的种子回传，保证"用户能复现这一次"
 */
function normalizeSeed(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, seed: Math.floor(Math.random() * 4294967296) >>> 0, generated: true };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, message: '随机种子必须是有限数字或字符串' };
    return { ok: true, seed: Math.abs(Math.trunc(raw)) >>> 0, generated: false };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, seed: Math.floor(Math.random() * 4294967296) >>> 0, generated: true };
    if (/^\d+$/.test(trimmed)) return { ok: true, seed: Number(trimmed) >>> 0, generated: false };
    if (trimmed.length > 64) return { ok: false, message: '随机种子最长 64 字符' };
    return { ok: true, seed: hashSeed(trimmed), generated: false };
  }
  return { ok: false, message: '随机种子只支持数字或字符串' };
}

/* ---------------- 号码池与抽取 ---------------- */

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function shuffle(list, rng) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function pick(pool, k, rng) {
  return shuffle(pool, rng).slice(0, k);
}

function oddCount(list) {
  return list.filter((n) => n % 2 === 1).length;
}

function zoneSpread(list, zones) {
  const counts = zones.map(() => 0);
  for (const n of list) {
    for (let i = 0; i < zones.length; i += 1) {
      if (n >= zones[i][0] && n <= zones[i][1]) {
        counts[i] += 1;
        break;
      }
    }
  }
  return counts;
}

/**
 * 结构均衡评分：分区间越均匀、奇偶越接近目标，分越高。
 * 用"采样多个候选取最优"而不是构造式算法——构造式在奇偶与分区冲突时会失败，
 * 采样法永远不会产生非法组合，且仍然完全确定性（同 rng 同结果）。
 */
function bestBalanced(sampleFn, scoreFn, samples, rng) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < samples; i += 1) {
    const candidate = sampleFn(rng);
    const s = scoreFn(candidate);
    if (s > bestScore) {
      bestScore = s;
      best = candidate;
    }
  }
  return best;
}

function ssqZones() {
  return [
    [1, 11],
    [12, 22],
    [23, 33],
  ];
}

function kl8Zones() {
  return [
    [1, 20],
    [21, 40],
    [41, 60],
    [61, 80],
  ];
}

/* ---------------- 参数规范化 ---------------- */

function normalizeList(raw, { min, max, label, maxLen }) {
  if (raw === undefined || raw === null) return { ok: true, list: [] };
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[\s,，、]+/);
  const list = [];
  for (const item of arr) {
    if (item === '' || item === null || item === undefined) continue;
    const n = Number(item);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, code: label === 'include' ? CODE.BAD_INCLUDE : CODE.BAD_EXCLUDE, message: `${label === 'include' ? '必含' : '排除'}号码必须是 ${min}–${max} 的整数` };
    }
    if (!list.includes(n)) list.push(n);
  }
  if (list.length > maxLen) {
    return { ok: false, code: label === 'include' ? CODE.BAD_INCLUDE : CODE.BAD_EXCLUDE, message: `${label === 'include' ? '必含' : '排除'}号码最多 ${maxLen} 个` };
  }
  return { ok: true, list: list.sort((a, b) => a - b) };
}

/**
 * 参数快照：随批次一起存，保证"参数→结果"可复现。
 * 所有字段都是可 JSON 化的标量或数组，禁止函数/引用。
 */
function snapshotParams(game, params) {
  const p = params || {};
  const base = {
    include: Array.isArray(p.include) ? p.include.slice() : [],
    exclude: Array.isArray(p.exclude) ? p.exclude.slice() : [],
  };
  if (game === GAME.SSQ) base.blueFixed = Number.isInteger(p.blueFixed) ? p.blueFixed : null;
  return base;
}

/* ---------------- 单注生成 ---------------- */

function buildSsqGroup({ strategy, include, exclude, blueFixed, rng }) {
  const zones = ssqZones();
  const all = range(1, 33).filter((n) => !exclude.includes(n));
  const forced = include.filter((n) => !exclude.includes(n));
  const free = all.filter((n) => !forced.includes(n));
  const need = 6 - forced.length;
  if (need < 0) return null;
  if (free.length < need) return null;

  let red;
  if (strategy === STRATEGY.BALANCED) {
    red = bestBalanced(
      (r) => forced.concat(pick(free, need, r)).sort((a, b) => a - b),
      (candidate) => {
        const spread = zoneSpread(candidate, zones);
        const zoneCost = spread.reduce((acc, c) => acc + Math.abs(c - 2), 0);
        const oddCost = Math.abs(oddCount(candidate) - 3);
        return -(zoneCost * 2 + oddCost);
      },
      48,
      rng
    );
  } else {
    red = forced.concat(pick(free, need, rng)).sort((a, b) => a - b);
  }
  if (!red || red.length !== 6) return null;

  const bluePool = range(1, 16);
  const blue = Number.isInteger(blueFixed) && bluePool.includes(blueFixed) ? blueFixed : pick(bluePool, 1, rng)[0];
  return { numbers: { red, blue, kl8: [] } };
}

function buildKl8Group({ strategy, include, exclude, rng }) {
  const zones = kl8Zones();
  const all = range(1, 80).filter((n) => !exclude.includes(n));
  const forced = include.filter((n) => !exclude.includes(n));
  const free = all.filter((n) => !forced.includes(n));
  const need = 10 - forced.length;
  if (need < 0) return null;
  if (free.length < need) return null;

  let kl8;
  if (strategy === STRATEGY.BALANCED) {
    kl8 = bestBalanced(
      (r) => forced.concat(pick(free, need, r)).sort((a, b) => a - b),
      (candidate) => {
        const spread = zoneSpread(candidate, zones);
        const zoneCost = spread.reduce((acc, c, i) => acc + Math.abs(c - [3, 3, 2, 2][i]), 0);
        const oddCost = Math.abs(oddCount(candidate) - 5);
        return -(zoneCost * 2 + oddCost);
      },
      64,
      rng
    );
  } else {
    kl8 = forced.concat(pick(free, need, rng)).sort((a, b) => a - b);
  }
  if (!kl8 || kl8.length !== 10) return null;
  return { numbers: { red: [], blue: null, kl8 } };
}

/** 一组号码的规范化键，用于组间去重 */
function groupKey(game, numbers) {
  const list = game === GAME.SSQ ? numbers.red : numbers.kl8;
  const tail = game === GAME.SSQ ? `|${numbers.blue}` : '';
  return `${list.join(',')}${tail}`;
}

/* ---------------- 对外主函数 ---------------- */

/**
 * 生成候选组合。
 * @param {object} input
 * @param {'ssq'|'kl8'} input.game
 * @param {'random'|'balanced'|'preference'} [input.strategy]
 * @param {number} [input.count] 1–5，默认 3
 * @param {string} [input.targetIssue] 目标期号（可选，仅记录）
 * @param {number|string} [input.seed] 随机种子；不传则自动生成并回传
 * @param {{include?:number[], exclude?:number[], blueFixed?:number}} [input.params]
 * @param {string} [input.complianceState] 记录生成时的闸门状态
 * @returns {{ok:boolean, code:string, message?:string, batch?:object}}
 */
function generateCandidates(input) {
  const src = input || {};
  const game = src.game;
  if (!isGame(game)) {
    return { ok: false, code: CODE.BAD_GAME, message: '只支持双色球（ssq）与快乐8选十（kl8）' };
  }

  const strategy = src.strategy || STRATEGY.RANDOM;
  if (!Object.values(STRATEGY).includes(strategy)) {
    return { ok: false, code: CODE.BAD_STRATEGY, message: '策略只能是 random / balanced / preference' };
  }

  const count = src.count === undefined || src.count === null ? DEFAULT_COUNT : Number(src.count);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return { ok: false, code: CODE.BAD_COUNT, message: `注数需为 ${MIN_COUNT}–${MAX_COUNT} 的整数` };
  }

  let targetIssue = null;
  if (src.targetIssue !== undefined && src.targetIssue !== null && src.targetIssue !== '') {
    const issue = String(src.targetIssue).trim();
    if (!isValidIssue(issue)) {
      return { ok: false, code: CODE.BAD_ISSUE, message: '目标期号需为 7 位数字，如 2026127' };
    }
    targetIssue = issue;
  }

  const meta = GAME_META[game];
  const numberMin = game === GAME.SSQ ? meta.redMin : meta.min;
  const numberMax = game === GAME.SSQ ? meta.redMax : meta.max;
  const need = game === GAME.SSQ ? meta.redCount : meta.count;

  const params = src.params || {};
  const inc = normalizeList(params.include, {
    min: numberMin,
    max: numberMax,
    label: 'include',
    maxLen: need,
  });
  if (!inc.ok) return inc;

  const exc = normalizeList(params.exclude, {
    min: numberMin,
    max: numberMax,
    label: 'exclude',
    maxLen: MAX_EXCLUDE_NUMBERS,
  });
  if (!exc.ok) return exc;

  const conflict = inc.list.filter((n) => exc.list.includes(n));
  if (conflict.length) {
    return { ok: false, code: CODE.BAD_INCLUDE, message: `号码 ${conflict.join('、')} 同时出现在必含与排除里` };
  }

  if (inc.list.length > need) {
    return { ok: false, code: CODE.NO_ROOM, message: `必含号码最多 ${need} 个` };
  }
  const available = numberMax - numberMin + 1 - exc.list.length;
  if (available < need) {
    return { ok: false, code: CODE.NO_ROOM, message: '排除的号码太多，剩余号码不足以组成一注' };
  }

  const seedRes = normalizeSeed(src.seed);
  if (!seedRes.ok) {
    return { ok: false, code: CODE.BAD_SEED, message: seedRes.message };
  }
  const rng = createRng(seedRes.seed);

  const groups = [];
  const seen = new Set();
  const buildGroup = game === GAME.SSQ ? buildSsqGroup : buildKl8Group;

  for (let i = 0; i < count; i += 1) {
    let built = null;
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS_PER_GROUP) {
      attempts += 1;
      const candidate = buildGroup({
        strategy,
        include: inc.list,
        exclude: exc.list,
        blueFixed: params.blueFixed,
        rng,
      });
      if (!candidate) break;
      const key = groupKey(game, candidate.numbers);
      if (seen.has(key)) continue;
      built = { ...candidate, key };
      break;
    }
    if (!built) {
      return {
        ok: false,
        code: CODE.DUPLICATE_EXHAUSTED,
        message:
          groups.length === 0
            ? '当前约束下无法生成合法号码，请放宽必含/排除条件'
            : '当前约束下可生成的组合不足，请减少注数或放宽约束',
      };
    }
    seen.add(built.key);
    groups.push({
      index: i,
      numbers: built.numbers,
      key: built.key,
      displayText: game === GAME.SSQ
        ? `${built.numbers.red.map((n) => String(n).padStart(2, '0')).join(' ')} + ${String(built.numbers.blue).padStart(2, '0')}`
        : built.numbers.kl8.map((n) => String(n).padStart(2, '0')).join(' '),
    });
  }

  return {
    ok: true,
    code: CODE.OK,
    batch: {
      algorithmVersion: ALGORITHM_VERSION,
      game,
      strategy,
      count,
      randomSeed: seedRes.seed,
      seedGenerated: seedRes.generated,
      parameterSnapshot: snapshotParams(game, { ...params, include: inc.list, exclude: exc.list }),
      targetIssue,
      complianceState: src.complianceState || null,
      createdAt: (src.now instanceof Date ? src.now : new Date()).toISOString(),
      groups,
    },
  };
}

/**
 * 批次完整性自检：用于导入历史批次、以及"复现校验"。
 * 只做结构校验，不判奖。
 */
function verifyBatch(batch) {
  if (!batch || typeof batch !== 'object') {
    return { ok: false, code: 'BATCH_INVALID', message: '批次数据为空' };
  }
  if (!isGame(batch.game)) {
    return { ok: false, code: 'BATCH_INVALID', message: '批次彩种不合法' };
  }
  if (batch.algorithmVersion !== ALGORITHM_VERSION) {
    return {
      ok: false,
      code: 'ALGORITHM_VERSION_MISMATCH',
      message: `批次算法版本为 ${batch.algorithmVersion || '(空)'}，当前为 ${ALGORITHM_VERSION}`,
    };
  }
  if (!Array.isArray(batch.groups) || !batch.groups.length) {
    return { ok: false, code: 'BATCH_INVALID', message: '批次没有号码组' };
  }
  const seen = new Set();
  for (const g of batch.groups) {
    const n = g && g.numbers;
    const list = batch.game === GAME.SSQ ? n && n.red : n && n.kl8;
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, code: 'BATCH_INVALID', message: '存在空号码组' };
    }
    const key = groupKey(batch.game, n);
    if (seen.has(key)) {
      return { ok: false, code: 'GROUP_DUPLICATED', message: '批次内存在重复号码组' };
    }
    seen.add(key);
  }
  return { ok: true, code: 'OK' };
}

/**
 * 用一期开奖结果回看批次命中情况（描述性，不判奖、不算钱）。
 * 判奖仍只走 shared/rules/judge.js。
 */
function reviewBatch(batch, draw) {
  if (!batch || !draw) {
    return { ok: false, code: 'NO_DRAW', message: '缺少批次或开奖数据' };
  }
  if (batch.game !== draw.game) {
    return { ok: false, code: 'GAME_MISMATCH', message: '批次与开奖彩种不一致' };
  }
  const isSsq = batch.game === GAME.SSQ;
  const drawRed = isSsq ? draw.numbers.red || [] : draw.numbers.kl8 || [];
  const drawBlue = isSsq ? draw.numbers.blue : null;

  const groups = (batch.groups || []).map((g) => {
    const list = isSsq ? g.numbers.red : g.numbers.kl8;
    const matched = list.filter((n) => drawRed.includes(n));
    const blueHit = isSsq && drawBlue !== null && drawBlue !== undefined ? g.numbers.blue === drawBlue : null;
    return {
      index: g.index,
      mainHits: matched.length,
      matched,
      blueHit,
      totalHits: matched.length + (blueHit ? 1 : 0),
    };
  });

  const best = groups.reduce((acc, g) => (acc === null || g.totalHits > acc.totalHits ? g : acc), null);
  return {
    ok: true,
    game: batch.game,
    issue: draw.issue,
    groups,
    best,
    note: '这是候选组合与开奖号码的重合情况，不代表已购买，也不构成任何预测结论。',
  };
}

module.exports = {
  ALGORITHM_VERSION,
  STRATEGY,
  STRATEGY_META,
  CODE,
  DEFAULT_COUNT,
  MIN_COUNT,
  MAX_COUNT,
  generateCandidates,
  verifyBatch,
  reviewBatch,
  normalizeSeed,
  createRng,
  hashSeed,
  groupKey,
};
