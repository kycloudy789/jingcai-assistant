const test = require('node:test');
const assert = require('node:assert');

const {
  ANALYTICS_VERSION,
  numberFrequency,
  sumDistribution,
  parityDistribution,
  zoneDistribution,
  consecutiveDistribution,
  hitDistribution,
  buildAnalytics,
} = require('../shared/domain/analytics');

const SSQ_DRAWS = [
  { issue: '2026126', numbers: { red: [9, 10, 13, 22, 29, 32], blue: 12, kl8: [] } },
  { issue: '2026125', numbers: { red: [3, 8, 12, 21, 26, 30], blue: 8, kl8: [] } },
  { issue: '2026124', numbers: { red: [1, 2, 4, 5, 27, 31], blue: 4, kl8: [] } },
];

test('频次：出现次数、当前遗漏、样本量与区间', () => {
  const r = numberFrequency('ssq', SSQ_DRAWS, { window: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.sampleSize, 3);
  assert.equal(r.issueRange.from, '2026124');
  assert.equal(r.issueRange.to, '2026126');
  assert.equal(r.rows.length, 33);

  const byNum = new Map(r.rows.map((x) => [x.number, x]));
  assert.equal(byNum.get(9).count, 1);
  assert.equal(byNum.get(9).omission, 0, '最新一期出现 → 遗漏 0');
  assert.equal(byNum.get(3).omission, 1);
  assert.equal(byNum.get(1).omission, 2);
  assert.equal(byNum.get(33).count, 0);
  assert.equal(byNum.get(33).omission, 3, '窗口内未出现记为窗口长度');

  // 样本不足时提示
  assert.match(r.note, /只有 3 期/);
});

test('频次：请求窗口大于本地数据时按实际计算', () => {
  const r = numberFrequency('ssq', SSQ_DRAWS, { window: 100 });
  assert.equal(r.window, 100);
  assert.equal(r.sampleSize, 3);
  assert.match(r.note, /样本偏小/);
});

test('频次：蓝球单独统计', () => {
  const r = numberFrequency('ssq', SSQ_DRAWS, { window: 30 });
  assert.equal(r.blue.length, 16);
  const b12 = r.blue.find((x) => x.number === 12);
  assert.equal(b12.count, 1);
  assert.equal(b12.omission, 0);
});

test('频次：没有开奖数据 → NO_DRAWS', () => {
  assert.equal(numberFrequency('ssq', []).code, 'NO_DRAWS');
  assert.equal(numberFrequency('dlt', SSQ_DRAWS).code, 'BAD_GAME');
});

test('和值：分桶总数等于样本量', () => {
  const r = sumDistribution('ssq', SSQ_DRAWS, { window: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.min, 70); // 1+2+4+5+27+31
  assert.equal(r.max, 115); // 9+10+13+22+29+32
  assert.ok(r.avg > 0);
  assert.equal(
    r.buckets.reduce((acc, b) => acc + b.count, 0),
    3
  );
});

test('奇偶：按奇数个数分桶', () => {
  const r = parityDistribution('ssq', SSQ_DRAWS, { window: 30 });
  assert.equal(r.rows.length, 7);
  assert.equal(
    r.rows.reduce((acc, x) => acc + x.count, 0),
    3
  );
  // 1,5,27,31 是 4 奇 2 偶
  assert.equal(r.rows.find((x) => x.odd === 4).count, 1);
});

test('分区：占比合计约 100%，断区单独计数', () => {
  const r = zoneDistribution('ssq', SSQ_DRAWS, { window: 30 });
  assert.equal(r.zones.length, 3);
  const share = r.zones.reduce((acc, z) => acc + z.share, 0);
  assert.ok(Math.abs(share - 100) <= 0.3, `占比合计 ${share}`);
  // 2026124 期：1,2,4,5 属一区；27,31 属三区 → 二区为 0，断区
  assert.ok(r.brokenZoneIssues >= 1);
  assert.match(r.note, /不是"该回补"的信号/);
});

test('连号：识别含连号的期数与平均对数', () => {
  const r = consecutiveDistribution('ssq', SSQ_DRAWS, { window: 30 });
  assert.equal(r.sampleSize, 3);
  // 1-2 与 4-5 两对；9-10 一对；3,8,12,21,26,30 无
  assert.equal(r.withConsecutive, 2);
  assert.equal(r.share, 66.7);
  assert.ok(r.avgPairs > 0);
});

test('命中分布：双色球按红球命中数 + 蓝球', () => {
  const checks = [
    { game: 'ssq', hitDetails: { red: 6, blue: true, numbers: [] } },
    { game: 'ssq', hitDetails: { red: 2, blue: false, numbers: [] } },
    { game: 'ssq', hitDetails: { red: 2, blue: true, numbers: [] } },
  ];
  const r = hitDistribution('ssq', checks);
  assert.equal(r.ok, true);
  assert.equal(r.sampleSize, 3);
  assert.equal(r.rows.find((x) => x.hits === 6).count, 1);
  assert.equal(r.rows.find((x) => x.hits === 2).count, 2);
  assert.equal(r.blueHits, 2);
});

test('命中分布：快乐8 按命中个数 0–10', () => {
  const checks = [
    { game: 'kl8', hitDetails: { count: 10, numbers: [] } },
    { game: 'kl8', hitDetails: { count: 0, numbers: [] } },
    { game: 'kl8', hitDetails: { count: 0, numbers: [] } },
  ];
  const r = hitDistribution('kl8', checks);
  assert.equal(r.rows.length, 11);
  assert.equal(r.rows.find((x) => x.hits === 0).count, 2);
  assert.equal(r.rows.find((x) => x.hits === 10).count, 1);
});

test('命中分布：只统计本彩种，没核对结果时明确提示', () => {
  const mixed = [
    { game: 'ssq', hitDetails: { red: 1, blue: false } },
    { game: 'kl8', hitDetails: { count: 3 } },
  ];
  assert.equal(hitDistribution('kl8', mixed).sampleSize, 1);
  assert.equal(hitDistribution('ssq', []).code, 'NO_CHECKS');
});

test('汇总：一次返回所有统计块并带版本号', () => {
  const a = buildAnalytics('ssq', SSQ_DRAWS, [{ game: 'ssq', hitDetails: { red: 1, blue: false } }], {
    window: 30,
  });
  assert.equal(a.version, ANALYTICS_VERSION);
  assert.equal(a.frequency.ok, true);
  assert.equal(a.sum.ok, true);
  assert.equal(a.parity.ok, true);
  assert.equal(a.zones.ok, true);
  assert.equal(a.consecutive.ok, true);
  assert.equal(a.hits.ok, true);
});

test('奇偶：快乐8 按开奖的 20 个号分桶，不能丢期', () => {
  const draws = [
    { issue: '2026295', numbers: { red: [], blue: null, kl8: Array.from({ length: 20 }, (_, i) => i + 1) } },
    { issue: '2026294', numbers: { red: [], blue: null, kl8: Array.from({ length: 20 }, (_, i) => (i + 1) * 2) } },
  ];
  const r = parityDistribution('kl8', draws, { window: 30 });
  assert.equal(r.ballsPerDraw, 20);
  assert.equal(r.rows.length, 21);
  const total = r.rows.reduce((acc, x) => acc + x.count, 0);
  assert.equal(total, r.sampleSize, '每期都必须被计入，不能被静默丢弃');
  // 第一期 1–20 有 10 个奇数，第二期全是偶数
  assert.equal(r.rows.find((x) => x.odd === 10).count, 1);
  assert.equal(r.rows.find((x) => x.odd === 0).count, 1);
});
