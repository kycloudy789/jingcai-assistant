/**
 * 云函数服务层测试（假 CloudBase）：
 * 验证鉴权外壳、归属隔离、幂等、号码冻结、删除条件在"真实调用路径"上生效。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeCloud, installFakeSdk } = require('./helpers/fake-cloud');

const fake = createFakeCloud();
const restore = installFakeSdk(fake.sdk);

process.env.OWNER_OPENID = 'oOWNER';

// 需要先安装假 SDK，再加载云函数（模块加载时会 require wx-server-sdk）
const ticketService = require('../cloudfunctions/ticketService/index.js');
const queryTickets = require('../cloudfunctions/queryTickets/index.js');

const SSQ = { red: [1, 5, 9, 12, 20, 33], blue: 7 };

const createDraft = (over = {}) =>
  ticketService.main({
    action: 'create',
    game: 'ssq',
    issue: '2026127',
    numbers: SSQ,
    ...over,
  });

test.before(() => {
  fake.setOpenId('oOWNER');
  fake.seed('app_config', [
    { _id: 'global', ownerWhitelist: ['oOWNER', 'oOTHER'], wxComplianceStatus: 'not_checked' },
  ]);
});

test.after(() => restore());

test('创建草稿成功，返回 draft 与展示文本', async () => {
  const res = await createDraft();
  assert.equal(res.success, true);
  assert.equal(res.data.created, true);
  assert.equal(res.data.ticket.purchaseStatus, 'draft');
  assert.equal(res.data.ticket.displayText, '01 05 09 12 20 33 | 07');
  assert.equal(res.data.ticket.actualCost, null);
});

test('幂等：同一 idempotencyKey 重复提交不产生第二条记录', async () => {
  const before = fake.rows('ticket_records').length;
  const first = await createDraft({ idempotencyKey: 'k-123' });
  const second = await createDraft({ idempotencyKey: 'k-123' });
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(second.data.duplicated, true);
  assert.equal(second.data.ticket.id, first.data.ticket.id);
  assert.equal(fake.rows('ticket_records').length, before + 1);
});

test('确认购买：缺金额被拒，给金额后进入 confirmed', async () => {
  const created = await createDraft();
  const id = created.data.ticket.id;

  const missing = await ticketService.main({ action: 'confirm', ticketId: id, payload: {} });
  assert.equal(missing.success, false);
  assert.equal(missing.code, 'COST_INVALID');

  const okRes = await ticketService.main({
    action: 'confirm',
    ticketId: id,
    payload: { actualCost: 4, multiple: 2, purchaseAt: '2026-11-05T09:00:00+08:00' },
  });
  assert.equal(okRes.success, true);
  assert.equal(okRes.data.ticket.purchaseStatus, 'confirmed');
  assert.equal(okRes.data.ticket.actualCost, 4);
  assert.equal(okRes.data.ticket.multiple, 2);
});

test('已购买后改号被拒（服务端强制），改备注放行', async () => {
  const created = await createDraft();
  const id = created.data.ticket.id;
  await ticketService.main({ action: 'confirm', ticketId: id, payload: { actualCost: 2 } });

  const frozen = await ticketService.main({
    action: 'update',
    ticketId: id,
    patch: { numbers: { red: [2, 3, 4, 5, 6, 7], blue: 1 } },
  });
  assert.equal(frozen.success, false);
  assert.equal(frozen.code, 'NUMBER_FROZEN');

  const note = await ticketService.main({
    action: 'update',
    ticketId: id,
    patch: { note: '柜台补打', actualCost: 6 },
  });
  assert.equal(note.success, true);
  assert.equal(note.data.ticket.note, '柜台补打');
  assert.equal(note.data.ticket.actualCost, 6);
});

test('归属隔离：他人无法读取或修改我的记录', async () => {
  const created = await createDraft();
  const id = created.data.ticket.id;

  fake.setOpenId('oOTHER');
  const detail = await queryTickets.main({ mode: 'detail', ticketId: id });
  assert.equal(detail.success, false);
  assert.equal(detail.code, 'NOT_FOUND');

  const update = await ticketService.main({ action: 'update', ticketId: id, patch: { note: 'x' } });
  assert.equal(update.success, false);
  assert.equal(update.code, 'NOT_FOUND');

  fake.setOpenId('oOWNER');
});

test('非白名单 OpenID 一律拒绝', async () => {
  fake.setOpenId('oINTRUDER');
  const res = await createDraft();
  assert.equal(res.success, false);
  assert.equal(res.code, 'AUTH_DENIED');
  fake.setOpenId('oOWNER');
});

test('删除：已确认必须先作废', async () => {
  const created = await createDraft();
  const id = created.data.ticket.id;
  await ticketService.main({ action: 'confirm', ticketId: id, payload: { actualCost: 2 } });

  const denied = await ticketService.main({ action: 'delete', ticketId: id });
  assert.equal(denied.success, false);
  assert.equal(denied.code, 'DELETE_NOT_ALLOWED');

  const voided = await ticketService.main({ action: 'void', ticketId: id, payload: { reason: '录错' } });
  assert.equal(voided.success, true);
  assert.equal(voided.data.ticket.purchaseStatus, 'void');

  const removed = await ticketService.main({ action: 'delete', ticketId: id });
  assert.equal(removed.success, true);
  assert.equal(fake.rows('ticket_records').some((t) => t._id === id), false);
});

test('未知动作返回 BAD_ACTION', async () => {
  const res = await ticketService.main({ action: 'drop_database' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'BAD_ACTION');
});

test('列表：按状态过滤，并返回各状态计数', async () => {
  const res = await queryTickets.main({ mode: 'list', status: 'confirmed', pageSize: 50 });
  assert.equal(res.success, true);
  assert.ok(res.data.items.every((t) => t.purchaseStatus === 'confirmed'));
  assert.equal(typeof res.data.counts.draft, 'number');
  assert.ok(res.data.total >= 1);
});

test('列表：只返回本人的记录', async () => {
  fake.setOpenId('oOTHER');
  const res = await queryTickets.main({ mode: 'list', pageSize: 50 });
  assert.equal(res.success, true);
  assert.ok(res.data.items.every((t) => t.ownerOpenId === 'oOTHER'));
  fake.setOpenId('oOWNER');
});

test('统计计数只反映本人数据', async () => {
  const res = await queryTickets.main({ mode: 'summary' });
  assert.equal(res.success, true);
  assert.equal(res.data.total, res.data.draft + res.data.confirmed + res.data.void);
});
