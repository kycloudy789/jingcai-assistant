const test = require('node:test');
const assert = require('node:assert');

const {
  ALGORITHM_VERSION,
  STRATEGY,
  CODE,
  generateCandidates,
  verifyBatch,
  reviewBatch,
  normalizeSeed,
  hashSeed,
} = require('../shared/domain/candidates');

function zonesOf(list, zones) {
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

const SSQ_ZONES = [
  [1, 11],
  [12, 22],
  [23, 33],
];
const KL8_ZONES = [
  [1, 20],
  [21, 40],
  [41, 60],
  [61, 80],
];

test('默认生成 3 组，组间不重复，号码合法', () => {
  const r = generateCandidates({ game: 'ssq', seed: 'case-default' });
  assert.equal(r.ok, true);
  assert.equal(r.batch.count, 3);
  assert.equal(r.batch.groups.length, 3);
  assert.equal(r.batch.algorithmVersion, ALGORITHM_VERSION);

  const keys = new Set();
  for (const g of r.batch.groups) {
    assert.equal(g.numbers.red.length, 6);
    assert.equal(new Set(g.numbers.red).size, 6);
    for (const n of g.numbers.red) assert.ok(n >= 1 && n <= 33, `红球越界 ${n}`);
    assert.deepEqual(g.numbers.red, g.numbers.red.slice().sort((a, b) => a - b), '红球应升序');
    assert.ok(g.numbers.blue >= 1 && g.numbers.blue <= 16);
    keys.add(g.key);
  }
  assert.equal(keys.size, 3, '3 组必须互不相同');
});

test('同一种子 → 完全相同的批次（可复现）', () => {
  const a = generateCandidates({ game: 'ssq', count: 4, seed: 'repro-1', targetIssue: '2026127' });
  const b = generateCandidates({ game: 'ssq', count: 4, seed: 'repro-1', targetIssue: '2026127' });
  assert.deepEqual(
    a.batch.groups.map((g) => g.key),
    b.batch.groups.map((g) => g.key)
  );
  assert.equal(a.batch.randomSeed, b.batch.randomSeed);
});

test('不同种子 → 结果不同（不是固定输出）', () => {
  const a = generateCandidates({ game: 'kl8', seed: 'seed-a' });
  const b = generateCandidates({ game: 'kl8', seed: 'seed-b' });
  assert.notDeepEqual(
    a.batch.groups.map((g) => g.key),
    b.batch.groups.map((g) => g.key)
  );
});

test('不传种子时自动生成并回传，且可据此复现', () => {
  const first = generateCandidates({ game: 'ssq', seed: null });
  assert.equal(first.batch.seedGenerated, true);
  assert.ok(Number.isInteger(first.batch.randomSeed));
  const replay = generateCandidates({ game: 'ssq', seed: first.batch.randomSeed, count: 3 });
  assert.deepEqual(
    replay.batch.groups.map((g) => g.key),
    first.batch.groups.map((g) => g.key)
  );
});

test('字符串种子走哈希，稳定且落在 uint32', () => {
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
  const r = normalizeSeed('2026-11-05 选号');
  assert.equal(r.ok, true);
  assert.ok(r.seed >= 0 && r.seed <= 4294967295);
  assert.equal(r.generated, false);
});

test('分区均衡策略：双色球三区各 2 个、奇偶接近 3:3', () => {
  const r = generateCandidates({ game: 'ssq', strategy: STRATEGY.BALANCED, count: 3, seed: 'demo-seed' });
  assert.equal(r.ok, true);
  for (const g of r.batch.groups) {
    const zones = zonesOf(g.numbers.red, SSQ_ZONES);
    assert.deepEqual(zones, [2, 2, 2], `三区应各 2 个，实际 ${zones.join('/')}`);
    const odd = g.numbers.red.filter((n) => n % 2 === 1).length;
    assert.ok(odd >= 2 && odd <= 4, `奇数个数应在 2–4，实际 ${odd}`);
  }
});

test('分区均衡策略：快乐8 四区不堆叠、奇偶接近 5:5', () => {
  const r = generateCandidates({ game: 'kl8', strategy: STRATEGY.BALANCED, count: 3, seed: 'demo-seed' });
  assert.equal(r.ok, true);
  for (const g of r.batch.groups) {
    const zones = zonesOf(g.numbers.kl8, KL8_ZONES);
    assert.equal(g.numbers.kl8.length, 10);
    for (const c of zones) assert.ok(c >= 1 && c <= 4, `分区堆积异常：${zones.join('/')}`);
    const odd = g.numbers.kl8.filter((n) => n % 2 === 1).length;
    assert.ok(odd >= 4 && odd <= 6, `奇数个数应在 4–6，实际 ${odd}`);
  }
});

test('偏好策略：必含号码一定出现，排除号码一定不出现', () => {
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.PREFERENCE,
    count: 3,
    seed: 'pref-1',
    params: { include: [3, 9], exclude: [1, 2, 4, 5, 6] },
  });
  assert.equal(r.ok, true);
  for (const g of r.batch.groups) {
    assert.ok(g.numbers.red.includes(3) && g.numbers.red.includes(9), '必含号码缺失');
    for (const n of [1, 2, 4, 5, 6]) assert.ok(!g.numbers.red.includes(n), `排除了却出现 ${n}`);
    assert.equal(g.numbers.red.length, 6);
  }
});

test('偏好策略：快乐8 必含 5 个仍能补足 10 个', () => {
  const r = generateCandidates({
    game: 'kl8',
    strategy: STRATEGY.PREFERENCE,
    params: { include: [1, 2, 3, 4, 5] },
    seed: 'pref-kl8',
  });
  assert.equal(r.ok, true);
  for (const g of r.batch.groups) {
    assert.equal(g.numbers.kl8.length, 10);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(g.numbers.kl8.includes(n));
  }
});

test('参数互斥：必含与排除冲突直接拒绝', () => {
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.PREFERENCE,
    params: { include: [7], exclude: [7] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODE.BAD_INCLUDE);
  assert.match(r.message, /同时出现/);
});

test('排除过多导致无解 → NO_ROOM', () => {
  const exclude = Array.from({ length: 30 }, (_, i) => i + 1);
  const r = generateCandidates({ game: 'ssq', params: { exclude } });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODE.NO_ROOM);
});

test('必含超过一注容量 → BAD_INCLUDE，且说明上限', () => {
  const r = generateCandidates({ game: 'ssq', params: { include: [1, 2, 3, 4, 5, 6, 7] } });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODE.BAD_INCLUDE);
  assert.match(r.message, /最多 6 个/);

  const kl8 = generateCandidates({ game: 'kl8', params: { include: Array.from({ length: 11 }, (_, i) => i + 1) } });
  assert.equal(kl8.code, CODE.BAD_INCLUDE);
  assert.match(kl8.message, /最多 10 个/);
});

test('注数越界与类型错误被拒绝，默认 3', () => {
  for (const count of [0, 6, -1, 2.5, 'abc']) {
    const r = generateCandidates({ game: 'ssq', count });
    assert.equal(r.ok, false, `count=${count} 应被拒绝`);
    assert.equal(r.code, CODE.BAD_COUNT);
  }
  assert.equal(generateCandidates({ game: 'ssq', count: 1, seed: 'x' }).batch.count, 1);
  assert.equal(generateCandidates({ game: 'ssq', count: 5, seed: 'x' }).batch.count, 5);
});

test('彩种 / 策略 / 期号非法均被拒绝', () => {
  assert.equal(generateCandidates({ game: 'dlt' }).code, CODE.BAD_GAME);
  assert.equal(generateCandidates({ game: 'ssq', strategy: 'hot' }).code, CODE.BAD_STRATEGY);
  assert.equal(generateCandidates({ game: 'ssq', targetIssue: '202612' }).code, CODE.BAD_ISSUE);
  assert.equal(generateCandidates({ game: 'ssq', targetIssue: '2026127' }).batch.targetIssue, '2026127');
});

test('参数快照完整记录，可据此复现', () => {
  const r = generateCandidates({
    game: 'ssq',
    strategy: STRATEGY.PREFERENCE,
    count: 2,
    seed: 'snap-1',
    targetIssue: '2026127',
    params: { include: [5], exclude: [6], blueFixed: 8 },
    complianceState: 'approved',
  });
  const b = r.batch;
  assert.deepEqual(b.parameterSnapshot, { include: [5], exclude: [6], blueFixed: 8 });
  assert.equal(b.complianceState, 'approved');
  assert.equal(b.targetIssue, '2026127');

  const replay = generateCandidates({
    game: b.game,
    strategy: b.strategy,
    count: b.count,
    seed: b.randomSeed,
    targetIssue: b.targetIssue,
    params: b.parameterSnapshot,
  });
  assert.deepEqual(
    replay.batch.groups.map((g) => g.key),
    b.groups.map((g) => g.key)
  );
});

test('批次自检：正常通过、版本不符与重复组被拦', () => {
  const r = generateCandidates({ game: 'ssq', seed: 'verify-1' });
  assert.equal(verifyBatch(r.batch).ok, true);

  const badVersion = { ...r.batch, algorithmVersion: 'candidate@0.9.0' };
  assert.equal(verifyBatch(badVersion).code, 'ALGORITHM_VERSION_MISMATCH');

  const duplicated = { ...r.batch, groups: [r.batch.groups[0], r.batch.groups[0]] };
  assert.equal(verifyBatch(duplicated).code, 'GROUP_DUPLICATED');

  assert.equal(verifyBatch(null).ok, false);
});

test('开奖回看：逐注命中数与最佳注', () => {
  const batch = generateCandidates({ game: 'ssq', count: 2, seed: 'review-1' }).batch;
  const draw = {
    game: 'ssq',
    issue: '2026127',
    numbers: { red: batch.groups[0].numbers.red.slice(), blue: batch.groups[0].numbers.blue, kl8: [] },
  };
  const r = reviewBatch(batch, draw);
  assert.equal(r.ok, true);
  assert.equal(r.groups[0].mainHits, 6);
  assert.equal(r.groups[0].blueHit, true);
  assert.equal(r.groups[0].totalHits, 7);
  assert.equal(r.best.index, 0);
  assert.match(r.note, /不代表已购买/);
});

test('开奖回看：彩种不一致被拒绝', () => {
  const batch = generateCandidates({ game: 'ssq', seed: 'review-2' }).batch;
  const r = reviewBatch(batch, { game: 'kl8', issue: '2026127', numbers: { kl8: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GAME_MISMATCH');
});
