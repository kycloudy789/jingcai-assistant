/**
 * AI 工具执行器测试（假 CloudBase）：
 * 只读、归属隔离、口径正确、找不到时如实拒绝。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeCloud } = require('./helpers/fake-cloud');
const { createExecutors } = require('../shared/cloud/aiTools');

const fake = createFakeCloud();
const executors = createExecutors({ db: fake.sdk.database(), openid: 'oOWNER' });
const run = (name, args) => executors.execute(name, args);

test.before(() => {
  fake.seed('draw_records', [
    {
      _id: 'd126',
      game: 'ssq',
      issue: '2026126',
      drawDate: '2026-11-03',
      drawStatus: 'verified',
      numbers: { red: [9, 10, 13, 22, 29, 32], blue: 12, kl8: [] },
      prizeInfo: { first: { count: 5, amount: 9014860 } },
      specialRuleStatus: 'unknown',
      sourceUrl: 'https://www.cwl.gov.cn/c/2026/11/03/671981.shtml',
      verifiedAt: '2026-11-04T00:00:00.000Z',
      ruleVersion: 'ssq_2026_02_01',
    },
    {
      _id: 'd125',
      game: 'ssq',
      issue: '2026125',
      drawDate: '2026-11-01',
      drawStatus: 'verified',
      numbers: { red: [4, 6, 10, 15, 26, 27], blue: 11, kl8: [] },
      prizeInfo: {},
      specialRuleStatus: 'unknown',
      ruleVersion: 'ssq_2026_02_01',
    },
    {
      _id: 'd127',
      game: 'ssq',
      issue: '2026127',
      drawDate: '2026-11-05',
      drawStatus: 'parsed',
      numbers: { red: [1, 2, 3, 4, 5, 6], blue: 7, kl8: [] },
    },
  ]);

  fake.seed('ticket_records', [
    {
      _id: 't1',
      ownerOpenId: 'oOWNER',
      game: 'ssq',
      issue: '2026126',
      purchaseStatus: 'confirmed',
      actualCost: 4,
      multiple: 2,
      displayText: '09 10 13 22 29 32 | 12',
      createdAt: '2026-11-04T01:00:00.000Z',
    },
    {
      _id: 't2',
      ownerOpenId: 'oOWNER',
      game: 'ssq',
      issue: '2026125',
      purchaseStatus: 'confirmed',
      actualCost: 6,
      multiple: 3,
      displayText: '04 06 10 15 26 27 | 11',
      createdAt: '2026-11-03T01:00:00.000Z',
    },
    {
      _id: 't3',
      ownerOpenId: 'oOWNER',
      game: 'ssq',
      issue: '2026127',
      purchaseStatus: 'confirmed',
      actualCost: null,
      multiple: 1,
      displayText: '01 02 03 04 05 06 | 07',
      createdAt: '2026-11-05T01:00:00.000Z',
    },
    {
      _id: 't4',
      ownerOpenId: 'oOWNER',
      game: 'ssq',
      issue: '2026127',
      purchaseStatus: 'draft',
      actualCost: null,
      multiple: 1,
      createdAt: '2026-11-05T02:00:00.000Z',
    },
    {
      _id: 'tOther',
      ownerOpenId: 'oOTHER',
      game: 'ssq',
      issue: '2026126',
      purchaseStatus: 'confirmed',
      actualCost: 100,
      multiple: 1,
      createdAt: '2026-11-04T03:00:00.000Z',
    },
  ]);

  fake.seed('ticket_checks', [
    {
      _id: 'c1',
      ticketId: 't1',
      ownerOpenId: 'oOWNER',
      game: 'ssq',
      issue: '2026126',
      checkStatus: 'checked',
      isWinner: true,
      prizeLevel: '3',
      unitPrize: 3000,
      quantity: 2,
      totalPrize: 6000,
      hitDetails: { red: 5, blue: true, numbers: [9, 10, 13, 22, 29, 32] },
      ruleVersion: 'ssq_2026_02_01',
      checkedAt: '2026-11-04T05:00:00.000Z',
    },
    {
      _id: 'c2',
      ticketId: 't2',
      ownerOpenId: 'oOWNER',
      game: 'ssq',
      issue: '2026125',
      checkStatus: 'pending_manual_review',
      isWinner: false,
      prizeLevel: null,
      totalPrize: null,
      pendingReason: 'FUYUN_STATUS_UNKNOWN',
      checkedAt: '2026-11-02T05:00:00.000Z',
    },
    {
      _id: 'cOther',
      ticketId: 'tOther',
      ownerOpenId: 'oOTHER',
      game: 'ssq',
      issue: '2026126',
      checkStatus: 'checked',
      isWinner: true,
      totalPrize: 5,
      checkedAt: '2026-11-04T05:00:00.000Z',
    },
  ]);

  fake.seed('sync_logs', [
    { _id: 'log1', game: 'ssq', status: 'success', finishedAt: '2026-11-05T02:00:00.000Z', createdAt: '2026-11-05T02:00:00.000Z' },
  ]);
});

test('最新开奖只取已核验，忽略 parsed', async () => {
  const r = await run('get_latest_draw', { game: 'ssq' });
  assert.equal(r.ok, true);
  assert.equal(r.draw.issue, '2026126');
  assert.equal(r.draw.drawStatus, 'verified');
  assert.equal(r.draw.prizeInfo.first.amount, 9014860);
  assert.equal(r.lastSync.status, 'success');
});

test('没有已核验数据时如实拒绝，并给出同步提示', async () => {
  const r = await run('get_latest_draw', { game: 'kl8' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_VERIFIED_DRAW');
  assert.ok(r.hint.includes('同步'));
});

test('按期号查询：未核验的期返回 NOT_FOUND', async () => {
  assert.equal((await run('get_draws', { game: 'ssq', issue: '2026127' })).code, 'NOT_FOUND');
  const ok = await run('get_draws', { game: 'ssq', issue: '2026126' });
  assert.equal(ok.ok, true);
  assert.equal(ok.draws[0].issue, '2026126');
});

test('我的号码：只返回本人记录，且剥离 ownerOpenId', async () => {
  const r = await run('get_my_tickets', { limit: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.total, 4);
  for (const t of r.tickets) {
    assert.equal(t.ownerOpenId, undefined);
    assert.notEqual(t.id, 'tOther');
  }
});

test('我的号码：按状态过滤', async () => {
  const r = await run('get_my_tickets', { status: 'draft' });
  assert.equal(r.total, 1);
  assert.equal(r.tickets[0].id, 't4');
});

test('核对结果：他人的票查不到', async () => {
  const r = await run('get_ticket_check', { ticketId: 'tOther' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('核对结果：尚无核对时明确说明', async () => {
  const r = await run('get_ticket_check', { ticketId: 't3' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_CHECK');
});

test('核对结果：返回命中与奖金明细', async () => {
  const r = await run('get_ticket_check', { ticketId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.check.prizeLevel, '3');
  assert.equal(r.check.totalPrize, 6000);
  assert.equal(r.check.ruleVersion, 'ssq_2026_02_01');
});

test('个人统计：金额只算已填写的，奖金只来自核对结果', async () => {
  const r = await run('get_my_ticket_stats', {});
  assert.equal(r.ok, true);
  assert.equal(r.counts.confirmed, 3);
  assert.equal(r.counts.draft, 1);
  assert.equal(r.purchased.totalCost, 10, '4 + 6，未填写的 t3 不计入');
  assert.equal(r.purchased.missingCostTickets, 1);
  assert.equal(r.winnings.recordsWithCheck, 2);
  assert.equal(r.winnings.winners, 1);
  assert.equal(r.winnings.totalPrize, 6000, '他人核对与待核验不计入');
  assert.equal(r.winnings.pendingReview, 1);
});

test('号码统计：频次与遗漏口径正确', async () => {
  const r = await run('get_number_stats', { game: 'ssq', window: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.sampleSize, 2);
  const byNumber = new Map(r.red.map((x) => [x.number, x]));

  assert.equal(byNumber.get(10).count, 2, '10 在两期都出现');
  assert.equal(byNumber.get(10).omission, 0, '最近一期出现 → 遗漏 0');
  assert.equal(byNumber.get(4).count, 1);
  assert.equal(byNumber.get(4).omission, 1, '上上期出现 → 遗漏 1');
  assert.equal(byNumber.get(1).omission, 2, '窗口内从未出现 → 记为窗口长度');
  assert.match(r.note, /不能用于判断未来/);
});

test('规则查询：旧期没有建档版本时明确拒绝，不回退新规则', async () => {
  const r = await run('get_rule_info', { game: 'ssq', issue: '2026013' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_RULE_VERSION');
  assert.equal(r.current.ruleVersion, 'ssq_2026_02_01');
});

test('规则查询：现行版本返回奖级表与来源', async () => {
  const r = await run('get_rule_info', { game: 'kl8', issue: '2026294' });
  assert.equal(r.ok, true);
  assert.equal(r.rule.ruleVersion, 'kl8_2025_12_30');
  assert.equal(r.rule.prizeTable['8'], 720);
  assert.ok(r.rule.sourceUrl);
});

test('执行器统一入口：未知工具与非法参数都被拒绝', async () => {
  assert.equal((await executors.execute('sql_query', { q: 'x' })).code, 'UNKNOWN_TOOL');
  assert.equal((await executors.execute('get_latest_draw', { game: 'nope' })).code, 'BAD_ARGS');
});
