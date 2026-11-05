/**
 * 官方适配器测试 —— 使用 2026-11-05 从中国福彩网实测抓取的真实数据（tests/fixtures/）。
 * 这些用例锁定真实接口的行为，包括已知的两个坑（快乐8 空奖级、双色球单注封顶）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapRecord,
  mapRecords,
  buildQueryUrl,
  assertResponseShape,
  contentSignature,
  parseMoney,
  parseDrawDate,
} = require('../shared/adapters/cwl');
const { validateDrawRecord } = require('../shared/validators/draws');
const { DRAW_STATUS, SPECIAL_RULE_STATUS } = require('../shared/constants/games');

const ssqFixture = require('./fixtures/cwl-ssq.json');
const kl8Fixture = require('./fixtures/cwl-kl8.json');

const findRaw = (fixture, issue) => fixture.result.find((r) => r.code === issue);

test('双色球：真实样例映射正确（2026126）', () => {
  const res = mapRecord('ssq', findRaw(ssqFixture, '2026126'));
  assert.equal(res.ok, true);
  const r = res.record;
  assert.equal(r.issue, '2026126');
  assert.equal(r.drawDate, '2026-11-03');
  assert.deepEqual(r.numbers.red, [9, 10, 13, 22, 29, 32]);
  assert.equal(r.numbers.blue, 12);
  assert.deepEqual(r.prizeInfo.first, { count: 5, amount: 9014860 });
  assert.deepEqual(r.prizeInfo.second, { count: 159, amount: 157816 });
  assert.equal(r.prizeInfo.third.amount, 3000);
  assert.equal(r.poolAmount, 1074322050);
  assert.equal(r.sourceUrl, 'https://www.cwl.gov.cn/c/2026/11/03/671981.shtml');
  assert.equal(r.drawStatus, DRAW_STATUS.PARSED);
  assert.equal(r.ruleVersion, null, '规则版本必须由调用方按期号解析，采集器不赋值');
  assert.equal(r.parserVersion, 'cwl_api@1.0.0');
});

test('双色球：一等奖单注封顶样例（2026119 → 2 注 × 1000 万）', () => {
  const res = mapRecord('ssq', findRaw(ssqFixture, '2026119'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.record.prizeInfo.first, { count: 2, amount: 10000000 });
});

test('双色球：无福运奖数据时状态为 unknown，不猜 inactive', () => {
  const res = mapRecord('ssq', findRaw(ssqFixture, '2026126'));
  assert.equal(res.record.specialRuleStatus, SPECIAL_RULE_STATUS.UNKNOWN);
});

test('双色球：显式开启"空字段视为未执行"后才给 inactive', () => {
  const res = mapRecord('ssq', findRaw(ssqFixture, '2026126'), { fuyunEmptyMeansInactive: true });
  assert.equal(res.record.specialRuleStatus, SPECIAL_RULE_STATUS.INACTIVE);
});

test('双色球：规则起始期之前为 not_applicable', () => {
  const raw = { ...findRaw(ssqFixture, '2026126'), code: '2026013' };
  const res = mapRecord('ssq', raw, { fuyunEmptyMeansInactive: true });
  assert.equal(res.record.specialRuleStatus, SPECIAL_RULE_STATUS.NOT_APPLICABLE);
});

test('双色球：福运奖金额存在时判定 active', () => {
  const raw = { ...findRaw(ssqFixture, '2026126'), fyjCount: '12345', fyjMoney: '5' };
  const res = mapRecord('ssq', raw);
  assert.equal(res.record.specialRuleStatus, SPECIAL_RULE_STATUS.ACTIVE);
  assert.deepEqual(res.record.prizeInfo.fuyun, { count: 12345, amount: 5 });
});

test('快乐8：20 个号码映射正确（2026294）', () => {
  const res = mapRecord('kl8', findRaw(kl8Fixture, '2026294'));
  assert.equal(res.ok, true);
  const r = res.record;
  assert.equal(r.numbers.kl8.length, 20);
  assert.deepEqual(r.numbers.kl8.slice(0, 3), [3, 7, 10]);
  assert.equal(r.numbers.kl8[19], 80);
  assert.equal(r.specialRuleStatus, SPECIAL_RULE_STATUS.NOT_APPLICABLE);
});

test('快乐8：无人中"10 中 10"时金额为 null，绝不为 0（关键坑）', () => {
  const res = mapRecord('kl8', findRaw(kl8Fixture, '2026294'));
  const hit10 = res.record.prizeInfo.choose10.hit10;
  assert.equal(hit10.count, 0);
  assert.equal(hit10.amount, null, 'typenum=0 时 typemoney=0 是占位，不是奖金 0 元');
});

test('快乐8：有人中"10 中 10"时取当期公告金额（2026007 → 500 万）', () => {
  const res = mapRecord('kl8', findRaw(kl8Fixture, '2026007'));
  assert.deepEqual(res.record.prizeInfo.choose10.hit10, { count: 1, amount: 5000000 });
});

test('快乐8：只保留选十奖级，不混入其他玩法', () => {
  const res = mapRecord('kl8', findRaw(kl8Fixture, '2026294'));
  const keys = Object.keys(res.record.prizeInfo.choose10);
  assert.deepEqual(keys.sort(), ['hit0', 'hit10', 'hit5', 'hit6', 'hit7', 'hit8', 'hit9']);
  assert.equal(res.record.prizeInfo.first, undefined);
});

test('快乐8：号码不足 20 个时拒绝', () => {
  const raw = { ...findRaw(kl8Fixture, '2026294'), red: '01,02,03' };
  const res = mapRecord('kl8', raw);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NUMBERS_INVALID');
});

test('非法期号 / 非法日期被拒绝', () => {
  assert.equal(mapRecord('ssq', { ...findRaw(ssqFixture, '2026126'), code: '2026-11-03' }).code, 'ISSUE_INVALID');
  assert.equal(mapRecord('ssq', { ...findRaw(ssqFixture, '2026126'), date: '2026-02-31(六)' }).code, 'DATE_INVALID');
});

test('不支持的彩种被拒绝', () => {
  assert.equal(mapRecord('fc3d', findRaw(ssqFixture, '2026126')).code, 'GAME_UNSUPPORTED');
});

test('批量映射：一条坏数据不影响其它记录，且保留错误原因', () => {
  const list = [findRaw(ssqFixture, '2026126'), { code: 'BAD', red: '', blue: '' }, findRaw(ssqFixture, '2026125')];
  const { records, errors } = mapRecords('ssq', list);
  assert.equal(records.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].issue, 'BAD');
});

test('映射结果可通过入库校验', () => {
  for (const raw of ssqFixture.result) {
    const res = mapRecord('ssq', raw);
    const check = validateDrawRecord(res.record, { now: new Date('2026-12-31T00:00:00+08:00') });
    assert.equal(check.ok, true, `${raw.code}: ${check.message}`);
  }
  for (const raw of kl8Fixture.result) {
    const res = mapRecord('kl8', raw);
    const check = validateDrawRecord(res.record, { now: new Date('2026-12-31T00:00:00+08:00') });
    assert.equal(check.ok, true, `${raw.code}: ${check.message}`);
  }
});

test('查询 URL：增量模式必须带 issueCount，且不超过上限', () => {
  const url = buildQueryUrl({ game: 'kl8', mode: 'incremental', issueCount: 30 });
  assert.match(url, /issueCount=30/);
  assert.match(url, /name=kl8/);
  const capped = buildQueryUrl({ game: 'ssq', mode: 'incremental', issueCount: 999 });
  assert.match(capped, /issueCount=100/);
});

test('查询 URL：年度模式构造起止期号', () => {
  const url = buildQueryUrl({ game: 'ssq', mode: 'year', issueStart: '2026' });
  assert.match(url, /issueStart=2026001/);
  assert.match(url, /issueEnd=2026999/);
});

test('查询 URL：按期号模式拒绝非法期号', () => {
  assert.throws(() => buildQueryUrl({ game: 'ssq', mode: 'issue', issueStart: '26' }), /期号区间不合法/);
  assert.throws(() => buildQueryUrl({ game: 'fc3d', mode: 'incremental' }), /不支持的彩种/);
});

test('空 result 的响应外壳被拒绝，避免把错误页当数据', () => {
  assert.equal(assertResponseShape(null).ok, false);
  assert.equal(assertResponseShape({ state: 1, message: 'err' }).code, 'BAD_STATE');
  assert.equal(assertResponseShape({ state: 0 }).code, 'NO_RESULT');
  assert.equal(assertResponseShape({ state: 0, result: [] }).ok, true);
});

test('内容指纹：号码变化才变化，采集时间不影响', () => {
  const a = mapRecord('ssq', findRaw(ssqFixture, '2026126')).record;
  const b = { ...a, fetchedAt: '2026-11-05T00:00:00Z', rawHash: 'deadbeef' };
  assert.equal(contentSignature(a), contentSignature(b));

  const c = { ...a, numbers: { ...a.numbers, blue: 1 } };
  assert.notEqual(contentSignature(a), contentSignature(c));
});

test('金额与日期解析的边界', () => {
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('0'), 0);
  assert.equal(parseMoney('74325672.00'), 74325672);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseDrawDate('2026-11-03(二)'), '2026-11-03');
  assert.equal(parseDrawDate('乱码'), null);
});
