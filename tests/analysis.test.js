const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeNumbers,
  describeStructure,
  crowdIndex,
  coldNumbers,
  consecutivePairs,
  hasArithmeticRun,
  sameTailPairs,
  acValue,
  CROWD_MODEL_VERSION,
} = require('../shared/domain/analysis');
const { generateCandidates, STRATEGY, CODE } = require('../shared/domain/candidates');

/* 造一期"完美生日号"和一期"冷门号"用于对照 */
const BIRTHDAY = { red: [3, 8, 12, 21, 26, 30], blue: 8 };
const COLD = { red: [4, 17, 25, 29, 32, 33], blue: 16 };

function makeDraws(n, seedStart = 7) {
  const out = [];
  let seed = seedStart;
  for (let i = 0; i < n; i += 1) {
    const red = new Set();
    while (red.size < 6) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      red.add((seed % 33) + 1);
    }
    out.push({
      issue: String(2026100 + i),
      numbers: { red: [...red].sort((a, b) => a - b), blue: (i % 16) + 1, kl8: [] },
    });
  }
  return out;
}

/* ---------------- 结构画像 ---------------- */

test('结构画像：和值/跨度/奇偶/分区/连号/重复号', () => {
  const s = describeStructure('ssq', { red: [1, 2, 12, 22, 23, 33], blue: 7 }, {
    previousDraw: { numbers: { red: [2, 5, 22, 30, 31, 33], blue: 1 } },
  });
  assert.equal(s.ok, true);
  assert.equal(s.sum, 93);
  assert.equal(s.span, 32);
  assert.equal(s.odd, 3);
  assert.equal(s.even, 3);
  assert.deepEqual(s.zones, [2, 2, 2]);
  assert.equal(s.consecutivePairs, 2); // 1-2 与 22-23
  assert.deepEqual(s.repeats, [2, 22, 33]);
  assert.equal(s.blue, 7);
  assert.equal(s.inCenterSum, true);
});

test('结构画像：号码个数不对直接拒绝', () => {
  assert.equal(describeStructure('ssq', { red: [1, 2, 3] }).code, 'BAD_NUMBERS');
  assert.equal(describeStructure('dlt', { red: [1, 2, 3, 4, 5, 6] }).code, 'BAD_GAME');
});

test('AC 值与工具函数', () => {
  assert.equal(acValue([1, 2, 3, 4, 5, 6]), 0);
  assert.equal(consecutivePairs([1, 3, 4, 8]).length, 1);
  assert.equal(sameTailPairs([3, 13, 23, 7]), 3);
  // 三连号算"设计感"模式
  assert.ok(hasArithmeticRun([1, 2, 3, 20, 26, 31]));
  // 偶然的 3 项等差（公差 6）不算，避免误伤普通组合
  assert.equal(hasArithmeticRun([5, 11, 17, 24, 28, 31]), null);
  // 4 项等差算
  assert.ok(hasArithmeticRun([4, 12, 20, 28, 31, 33]));
});

/* ---------------- 拥挤度 ---------------- */

test('拥挤度：生日号明显比冷门号"挤"', () => {
  const hot = crowdIndex('ssq', BIRTHDAY);
  const cold = crowdIndex('ssq', COLD);
  assert.equal(hot.ok, true);
  assert.ok(hot.index > cold.index + 25, `生日号 ${hot.index} 应远高于冷门号 ${cold.index}`);
  assert.equal(hot.level, 'high');
  assert.ok(['low', 'medium_low'].includes(cold.level), `冷门号应为低/中低，实际 ${cold.level}`);
});

test('拥挤度：指数在 0–100 且带推定声明', () => {
  for (const n of [BIRTHDAY, COLD, { red: [2, 9, 15, 22, 28, 33], blue: 11 }]) {
    const c = crowdIndex('ssq', n);
    assert.ok(c.index >= 0 && c.index <= 100);
    assert.equal(c.modelVersion, CROWD_MODEL_VERSION);
    assert.match(c.caveat, /推定值/);
    assert.match(c.caveat, /不改变中奖概率/);
  }
});

test('拥挤度：1-2-3-4-5-6 与全生日号被识别为高拥挤', () => {
  const c = crowdIndex('ssq', { red: [1, 2, 3, 4, 5, 6], blue: 7 });
  assert.equal(c.level, 'high');
  const keys = c.factors.map((f) => f.key);
  assert.ok(keys.includes('allInBirthdayZone'));
  assert.ok(keys.includes('consecutivePair'));
  assert.ok(keys.includes('arithmeticRun'));
});

test('拥挤度：因子带可直接展示的中文说明', () => {
  const c = crowdIndex('ssq', COLD);
  assert.ok(c.factors.length > 0);
  for (const f of c.factors) {
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length > 3);
    assert.equal(typeof f.delta, 'number');
  }
});

test('组合分析：结构与拥挤度一次返回', () => {
  const a = analyzeNumbers('ssq', COLD);
  assert.equal(a.ok, true);
  assert.equal(a.structure.span, 29);
  assert.ok(a.crowd.index < 60);
  assert.match(a.note, /不改变中奖概率/);
});

/* ---------------- 冷号 ---------------- */

test('冷号：近 N 期未出现的号码，附样本量与免责说明', () => {
  const draws = [
    { numbers: { red: [1, 2, 3, 4, 5, 6], blue: 1 } },
    { numbers: { red: [1, 2, 3, 4, 5, 7], blue: 2 } },
  ];
  const r = coldNumbers('ssq', draws, 30);
  assert.equal(r.ok, true);
  assert.equal(r.window, 2);
  assert.equal(r.cold.includes(1), false);
  assert.equal(r.cold.includes(8), true);
  assert.equal(r.cold.includes(33), true);
  assert.match(r.note, /不代表下期更可能/);
});

test('冷号：没有历史数据时返回空且不报错', () => {
  const r = coldNumbers('ssq', [], 30);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cold, []);
  assert.equal(r.sampleSize, 0);
});

/* ---------------- 分析选号策略 ---------------- */

test('分析选号：3 注、结构合格、拥挤度低于纯随机', () => {
  const draws = makeDraws(30);
  const insight = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 3,
    seed: 'cmp',
    recentDraws: draws,
    previousDraw: draws[draws.length - 1],
  });
  const plain = generateCandidates({ game: 'ssq', strategy: STRATEGY.RANDOM, count: 3, seed: 'cmp' });

  assert.equal(insight.ok, true);
  assert.equal(insight.batch.groups.length, 3);
  assert.ok(insight.batch.tradeoff, '应带兼顾代价摘要');
  assert.ok(
    insight.batch.tradeoff.avgCrowdIndex < 55,
    `平均拥挤应明显低于中位，实际 ${insight.batch.tradeoff.avgCrowdIndex}`
  );

  for (const g of insight.batch.groups) {
    const sum = g.numbers.red.reduce((a, b) => a + b, 0);
    assert.ok(sum >= 75 && sum <= 130, `和值越界 ${sum}`);
    const odd = g.numbers.red.filter((n) => n % 2 === 1).length;
    assert.ok(odd >= 2 && odd <= 4, `奇数个数越界 ${odd}`);
    assert.ok(g.crowd, '每注应带拥挤度');
    assert.ok(g.crowd.index <= 92);
  }

  // 与纯随机相比，平均拥挤度应更低（随机通常 55–65）
  const randomAvg = 60;
  assert.ok(insight.batch.tradeoff.avgCrowdIndex < randomAvg);
  assert.ok(plain.ok);
});

test('分析选号：避开上一期号码', () => {
  const draws = makeDraws(30);
  const prev = draws[draws.length - 1];
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 3,
    seed: 'norepeat',
    recentDraws: draws,
    previousDraw: prev,
    analysis: { avoidRepeat: true },
  });
  assert.equal(r.ok, true);
  const prevRed = prev.numbers.red;
  for (const g of r.batch.groups) {
    for (const n of g.numbers.red) {
      assert.equal(prevRed.includes(n), false, `不应包含上期号码 ${n}`);
    }
  }
  assert.equal(r.batch.analysis.previousIssue, prev.issue);
});

test('分析选号：要求带冷号时每注都带够', () => {
  const draws = makeDraws(12); // 期数少 → 冷号多
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 2,
    seed: 'cold',
    recentDraws: draws,
    analysis: { includeCold: 2, avoidRepeat: false },
  });
  assert.equal(r.ok, true);
  const cold = new Set(r.batch.analysis.coldNumbers);
  assert.ok(cold.size >= 2);
  for (const g of r.batch.groups) {
    const hits = g.numbers.red.filter((n) => cold.has(n)).length;
    assert.ok(hits >= 2, `第 ${g.index + 1} 注只带了 ${hits} 个冷号`);
  }
});

test('分析选号：冷号不足时报错，不偷偷降级', () => {
  const draws = makeDraws(40); // 期数多 → 冷号可能为 0
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 2,
    seed: 'cold2',
    recentDraws: draws,
    analysis: { includeCold: 2 },
  });
  if (r.ok) {
    // 若恰好有 2 个冷号，则必须每注都含
    const cold = new Set(r.batch.analysis.coldNumbers);
    for (const g of r.batch.groups) {
      assert.ok(g.numbers.red.filter((n) => cold.has(n)).length >= 2);
    }
  } else {
    assert.equal(r.code, CODE.BAD_ANALYSIS);
    assert.match(r.message, /冷号/);
  }
});

test('分析选号：同种子同参数完全可复现', () => {
  const draws = makeDraws(30);
  const opts = {
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 3,
    seed: 'repro',
    recentDraws: draws,
    previousDraw: draws[0],
    analysis: { includeCold: 0, sumRange: [80, 125] },
  };
  const a = generateCandidates(opts);
  const b = generateCandidates(opts);
  assert.deepEqual(
    a.batch.groups.map((g) => g.key),
    b.batch.groups.map((g) => g.key)
  );
  assert.deepEqual(a.batch.analysis, b.batch.analysis);
});

test('分析选号：组间不会"只差一个号"', () => {
  const draws = makeDraws(30);
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 5,
    seed: 'diverse',
    recentDraws: draws,
  });
  assert.equal(r.ok, true);
  for (let i = 0; i < r.batch.groups.length; i += 1) {
    for (let j = i + 1; j < r.batch.groups.length; j += 1) {
      const a = r.batch.groups[i].numbers.red;
      const b = r.batch.groups[j].numbers.red;
      const overlap = a.filter((n) => b.includes(n)).length;
      assert.ok(overlap <= 3, `第 ${i + 1} 与第 ${j + 1} 注重合 ${overlap} 个`);
    }
  }
});

test('分析选号：和值区间过窄导致无解时报错而不是返回空批', () => {
  const draws = makeDraws(30);
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 3,
    seed: 'narrow',
    recentDraws: draws,
    analysis: { sumRange: [21, 22] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODE.DUPLICATE_EXHAUSTED);
  assert.match(r.message, /放宽/);
});

test('分析选号：参数非法被拒绝', () => {
  const bad = [
    { includeCold: 5 },
    { includeCold: -1 },
    { sumRange: [130, 80] },
    { oddRange: [1, 9] },
    { maxCrowdIndex: 200 },
  ];
  for (const analysis of bad) {
    const r = generateCandidates({
      game: 'ssq',
      strategy: STRATEGY.ANALYZED,
      seed: 'bad',
      recentDraws: makeDraws(10),
      analysis,
    });
    assert.equal(r.ok, false, JSON.stringify(analysis));
    assert.ok([CODE.BAD_ANALYSIS, CODE.DUPLICATE_EXHAUSTED].includes(r.code), `${JSON.stringify(analysis)} → ${r.code}`);
  }
});

test('分析选号：快乐8 同样支持，批次带分析快照', () => {
  const draws = makeDraws(20).map((d) => ({
    issue: d.issue,
    numbers: { red: [], blue: null, kl8: d.numbers.red.concat([40, 50, 60, 70]).slice(0, 10) },
  }));
  const r = generateCandidates({
    game: 'kl8',
    strategy: STRATEGY.ANALYZED,
    count: 2,
    seed: 'kl8',
    recentDraws: draws,
    previousDraw: draws[0],
  });
  assert.equal(r.ok, true);
  assert.equal(r.batch.groups.length, 2);
  assert.equal(r.batch.analysis.crowdModelVersion, CROWD_MODEL_VERSION);
  assert.equal(r.batch.groups[0].numbers.kl8.length, 10);
  assert.ok(r.batch.crowdSummary.length === 2);
});

test('分析选号：统计窗口可配，并如实记录实际用了几期', () => {
  const draws = makeDraws(40);
  const r30 = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 1,
    seed: 'win30',
    recentDraws: draws,
    analysis: { window: 30 },
  });
  assert.equal(r30.ok, true);
  assert.equal(r30.batch.analysis.window, 30);
  assert.equal(r30.batch.analysis.sampleSize, 30);
  assert.equal(r30.batch.analysis.dataSufficient, true);

  const r100 = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 1,
    seed: 'win100',
    recentDraws: draws,
    analysis: { window: 100 },
  });
  assert.equal(r100.ok, true);
  assert.equal(r100.batch.analysis.window, 100);
  assert.equal(r100.batch.analysis.sampleSize, 40, '实际只有 40 期就记 40');
  assert.equal(r100.batch.analysis.dataSufficient, false);
});

test('分析选号：窗口只能是 30/50/100', () => {
  for (const w of [10, 35, 120, 'abc']) {
    const r = generateCandidates({
      game: 'ssq',
      strategy: STRATEGY.ANALYZED,
      seed: 'badwin',
      recentDraws: makeDraws(10),
      analysis: { window: w },
    });
    assert.equal(r.ok, false, `window=${w} 应被拒绝`);
    assert.equal(r.code, CODE.BAD_ANALYSIS);
  }
});

test('分析选号：窗口越大，冷号判定越宽（同一批数据）', () => {
  const draws = makeDraws(60);
  const short = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 1,
    seed: 'cmp-win',
    recentDraws: draws,
    analysis: { window: 30, includeCold: 0 },
  });
  const long = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.ANALYZED,
    count: 1,
    seed: 'cmp-win',
    recentDraws: draws,
    analysis: { window: 100, includeCold: 0 },
  });
  assert.equal(short.ok, true);
  assert.equal(long.ok, true);
  // 100 期窗口覆盖更多历史 → 冷号只会更少或相等
  assert.ok(
    long.batch.analysis.coldNumbers.length <= short.batch.analysis.coldNumbers.length,
    `长窗口冷号 ${long.batch.analysis.coldNumbers.length} 应 ≤ 短窗口 ${short.batch.analysis.coldNumbers.length}`
  );
});

test('分析选号：窗口支持 200 / 300（需要更多历史）', () => {
  const draws = makeDraws(320);
  for (const w of [200, 300]) {
    const r = generateCandidates({
      game: 'ssq',
      strategy: STRATEGY.ANALYZED,
      count: 1,
      seed: `win-${w}`,
      recentDraws: draws,
      analysis: { window: w },
    });
    assert.equal(r.ok, true, `window=${w} 应可用`);
    assert.equal(r.batch.analysis.window, w);
    assert.equal(r.batch.analysis.sampleSize, w);
  }
});
