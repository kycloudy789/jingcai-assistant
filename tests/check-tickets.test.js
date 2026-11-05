/**
 * checkTickets 云函数测试（假 CloudBase）：
 * 幂等、重算留痕、跳过未核验、待人工核验落库、派生字段回写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeCloud, installFakeSdk } = require('./helpers/fake-cloud');

const fake = createFakeCloud();
const restore = installFakeSdk(fake.sdk);
process.env.OWNER_OPENID = 'oOWNER';

const ticketService = require('../cloudfunctions/ticketService/index.js');
const checkTickets = require('../cloudfunctions/checkTickets/index.js');

const SSQ_RED = [1, 2, 3, 4, 5, 6];

function verifiedSsqDraw(over = {}) {
  return {
    _id: 'draw_ssq_126',
    game: 'ssq',
    issue: '2026127',
    drawStatus: 'verified',
    rawHash: 'hash_126',
    numbers: { red: SSQ_RED, blue: 7, kl8: [] },
    prizeInfo: {
      first: { count: 1, amount: 7000000 },
      second: { count: 10, amount: 150000 },
      third: { count: 100, amount: 3000 },
      fourth: { count: 1000, amount: 200 },
      fifth: { count: 10000, amount: 10 },
      sixth: { count: 100000, amount: 5 },
    },
    specialRuleStatus: 'inactive',
    ...over,
  };
}

async function createConfirmed(numbers, over = {}) {
  const created = await ticketService.main({
    action: 'create',
    game: 'ssq',
    issue: '2026127',
    numbers,
    ...over,
  });
  assert.equal(created.success, true, created.message);
  const id = created.data.ticket.id;
  await ticketService.main({ action: 'confirm', ticketId: id, payload: { actualCost: 2 } });
  return id;
}

test.before(() => {
  fake.setOpenId('oOWNER');
  fake.seed('app_config', [{ _id: 'global', ownerWhitelist: ['oOWNER'] }]);
});

test.after(() => restore());

test('未核验开奖不判奖，也不落核对记录', async () => {
  fake.seed('draw_records', [verifiedSsqDraw({ drawStatus: 'parsed' })]);
  await createConfirmed({ red: SSQ_RED, blue: 7 });
  const res = await checkTickets.main({});
  assert.equal(res.success, true);
  assert.equal(res.data.inserted, 0);
  assert.ok(res.data.skipped >= 1);
  assert.equal(fake.rows('ticket_checks').length, 0);
});

test('已核验开奖：一等奖落库，奖金取当期公告，回写派生字段', async () => {
  fake.seed('draw_records', [verifiedSsqDraw()]);
  const id = await createConfirmed({ red: SSQ_RED, blue: 7 });

  const res = await checkTickets.main({});
  assert.equal(res.success, true);
  assert.ok(res.data.inserted >= 1);
  assert.ok(res.data.winners >= 1);

  const check = fake.rows('ticket_checks').find((c) => c.ticketId === id);
  assert.equal(check.prizeLevel, '1');
  assert.equal(check.unitPrize, 7000000);
  assert.equal(check.checkStatus, 'checked');
  assert.equal(check.ruleVersion, 'ssq_2026_02_01');
  assert.equal(check.drawHash, 'hash_126');
  assert.ok(check.idempotencyKey);

  const ticket = fake.rows('ticket_records').find((t) => t._id === id);
  assert.equal(ticket.purchaseStatus, 'confirmed', '判奖不得改动购买状态');
  assert.equal(ticket.checkSummary.prizeLevel, '1');
  assert.equal(ticket.checkSummary.totalPrize, 7000000);
});

test('重复执行不产生重复核对记录（幂等）', async () => {
  const before = fake.rows('ticket_checks').length;
  const res = await checkTickets.main({});
  assert.equal(res.success, true);
  assert.equal(res.data.inserted, 0);
  assert.ok(res.data.unchanged >= 1);
  assert.equal(fake.rows('ticket_checks').length, before);
});

test('force 重算只更新同一条，不新增', async () => {
  const before = fake.rows('ticket_checks').length;
  const res = await checkTickets.main({ force: true });
  assert.equal(res.success, true);
  assert.ok(res.data.updated >= 1);
  assert.equal(fake.rows('ticket_checks').length, before);
});

test('开奖数据更正（rawHash 变化）→ 新增核对并指向上一条', async () => {
  const before = fake.rows('ticket_checks').length;
  fake.seed('draw_records', [verifiedSsqDraw({ rawHash: 'hash_126_v2', drawStatus: 'corrected' })]);

  const res = await checkTickets.main({});
  assert.equal(res.success, true);
  assert.ok(res.data.inserted >= 1);
  assert.equal(fake.rows('ticket_checks').length, before + res.data.inserted);

  const fresh = fake
    .rows('ticket_checks')
    .filter((c) => c.drawHash === 'hash_126_v2');
  assert.ok(fresh.length >= 1);
  assert.ok(fresh[0].recheckOf, '重算必须留痕指向上一条');
});

test('草稿与已作废记录不参与判奖', async () => {
  fake.seed('draw_records', [verifiedSsqDraw()]);
  const draft = await ticketService.main({
    action: 'create',
    game: 'ssq',
    issue: '2026127',
    numbers: { red: [11, 12, 13, 14, 15, 16], blue: 7 },
  });
  const draftId = draft.data.ticket.id;

  await checkTickets.main({});
  const checks = fake.rows('ticket_checks').filter((c) => c.ticketId === draftId);
  assert.equal(checks.length, 0);
});

test('福运奖状态未知的票会落 pending_manual_review，而不是给结论', async () => {
  fake.seed('draw_records', [verifiedSsqDraw({ specialRuleStatus: 'unknown' })]);
  const id = await createConfirmed({ red: [1, 2, 3, 31, 32, 33], blue: 8 });

  const res = await checkTickets.main({});
  assert.equal(res.success, true);

  const check = fake.rows('ticket_checks').find((c) => c.ticketId === id);
  assert.equal(check.checkStatus, 'pending_manual_review');
  assert.equal(check.pendingReason, 'FUYUN_STATUS_UNKNOWN');
  assert.equal(check.prizeLevel, null);
  assert.equal(check.unitPrize, null);
});

test('单票模式：只核对指定 ticketId', async () => {
  const id = await createConfirmed({ red: [1, 2, 3, 4, 5, 33], blue: 8 });
  const res = await checkTickets.main({ ticketId: id });
  assert.equal(res.success, true);
  assert.equal(res.data.total, 1);
  assert.ok(res.data.results.every((r) => r.ticketId === id));
});

test('他人无法触发我的核对', async () => {
  fake.setOpenId('oINTRUDER');
  const res = await checkTickets.main({});
  assert.equal(res.success, false);
  assert.equal(res.code, 'AUTH_DENIED');
  fake.setOpenId('oOWNER');
});
