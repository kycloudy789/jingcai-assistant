/**
 * 号码记录域模型测试（主方案 16.4 候选/购买隔离 + 状态流转 + 字段冻结）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTicketDraft,
  applyPatch,
  confirmPurchase,
  voidTicket,
  canDeleteTicket,
  isEligibleForPrize,
  isCountedInStats,
  summarize,
  CODE,
} = require('../shared/domain/tickets');
const { suggestCost } = require('../shared/rules/registry');

const NOW = new Date('2026-11-05T10:00:00+08:00');
const SSQ_NUMBERS = { red: [1, 5, 9, 12, 20, 33], blue: 7 };
const KL8_NUMBERS = { kl8: [1, 2, 3, 4, 5, 6, 7, 8, 9, 80] };

const makeSsq = (over = {}) =>
  buildTicketDraft(
    { game: 'ssq', issue: '2026127', numbers: SSQ_NUMBERS, ...over },
    { ownerOpenId: 'oOWNER', now: NOW }
  );

test('创建草稿：状态为 draft，且不带任何"已购买"信息', () => {
  const res = makeSsq();
  assert.equal(res.ok, true);
  const t = res.record;
  assert.equal(t.purchaseStatus, 'draft');
  assert.equal(t.purchaseAt, null);
  assert.equal(t.confirmedAt, null);
  assert.equal(t.actualCost, null, '草稿不得自动填金额');
  assert.equal(t.multiple, 1);
  assert.equal(t.numberKey, 'ssq:1,5,9,12,20,33|7');
  assert.equal(t.displayText, '01 05 09 12 20 33 | 07');
  assert.equal(t.ruleVersion, undefined, '号码记录不保存规则版本，判奖时另存 ticket_checks');
});

test('创建草稿：号码/期号非法被拒绝', () => {
  assert.equal(makeSsq({ numbers: { red: [1, 2, 3], blue: 1 } }).code, CODE.NUMBERS_INVALID);
  assert.equal(makeSsq({ issue: '2026' }).code, CODE.ISSUE_INVALID);
  assert.equal(makeSsq({ game: 'fc3d' }).code, CODE.GAME_UNSUPPORTED);
});

test('创建草稿：倍数与金额边界', () => {
  assert.equal(makeSsq({ multiple: 0 }).code, CODE.MULTIPLE_INVALID);
  assert.equal(makeSsq({ multiple: 100 }).code, CODE.MULTIPLE_INVALID);
  assert.equal(makeSsq({ multiple: 2 }).record.multiple, 2);
  assert.equal(makeSsq({ actualCost: -1 }).code, CODE.COST_INVALID);
  assert.equal(makeSsq({ note: 'x'.repeat(201) }).code, CODE.NOTE_TOO_LONG);
});

test('快乐8 草稿：10 个号码，playType=choose10', () => {
  const res = buildTicketDraft(
    { game: 'kl8', issue: '2026295', numbers: KL8_NUMBERS },
    { ownerOpenId: 'oOWNER', now: NOW }
  );
  assert.equal(res.ok, true);
  assert.equal(res.record.playType, 'choose10');
  assert.equal(res.record.numbers.kl8.length, 10);
});

test('草稿阶段允许改号码，且重新计算展示与幂等键', () => {
  const t = makeSsq().record;
  const res = applyPatch(t, { numbers: { red: [2, 3, 4, 5, 6, 7], blue: 8 }, multiple: 3 }, { now: NOW });
  assert.equal(res.ok, true);
  assert.deepEqual(res.update.numbers.red, [2, 3, 4, 5, 6, 7]);
  assert.equal(res.update.numberKey, 'ssq:2,3,4,5,6,7|8');
  assert.equal(res.update.multiple, 3);
});

test('确认购买：draft → confirmed，必须给实际金额', () => {
  const t = makeSsq().record;
  const missing = confirmPurchase(t, {}, { now: NOW });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODE.COST_INVALID);

  const res = confirmPurchase(t, { actualCost: 4, multiple: 2, purchaseAt: '2026-11-05T09:00:00+08:00' }, { now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.update.purchaseStatus, 'confirmed');
  assert.equal(res.update.actualCost, 4);
  assert.equal(res.update.multiple, 2);
  assert.ok(res.update.confirmedAt);
  assert.ok(res.update.purchaseAt);
});

test('确认购买：金额为 0（赠票）允许，非法金额拒绝', () => {
  const t = makeSsq().record;
  assert.equal(confirmPurchase(t, { actualCost: 0 }, { now: NOW }).ok, true);
  assert.equal(confirmPurchase(t, { actualCost: 'abc' }, { now: NOW }).code, CODE.COST_INVALID);
});

test('确认购买：购买时间不能是未来', () => {
  const t = makeSsq().record;
  const res = confirmPurchase(t, { actualCost: 2, purchaseAt: '2027-01-01T00:00:00+08:00' }, { now: NOW });
  assert.equal(res.code, CODE.PURCHASE_AT_INVALID);
});

test('重复确认被拒绝（不能拿 confirmed 再确认一次）', () => {
  const t = { ...makeSsq().record, purchaseStatus: 'confirmed' };
  const res = confirmPurchase(t, { actualCost: 2 }, { now: NOW });
  assert.equal(res.code, CODE.TRANSITION_NOT_ALLOWED);
});

test('已购买后号码冻结：改号被拒，改备注/金额放行', () => {
  const t = { ...makeSsq().record, purchaseStatus: 'confirmed' };
  const frozen = applyPatch(t, { numbers: { red: [2, 3, 4, 5, 6, 7], blue: 1 } }, { now: NOW });
  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, CODE.NUMBER_FROZEN);

  const issueChange = applyPatch(t, { issue: '2026128' }, { now: NOW });
  assert.equal(issueChange.code, CODE.NUMBER_FROZEN);

  const note = applyPatch(t, { note: '柜台补打', actualCost: 6, multiple: 3 }, { now: NOW });
  assert.equal(note.ok, true);
  assert.equal(note.update.note, '柜台补打');
  assert.equal(note.update.actualCost, 6);
  assert.equal(note.update.multiple, 3);
});

test('已购买记录不能改状态类字段（防止绕过 confirm 流程）', () => {
  const t = { ...makeSsq().record, purchaseStatus: 'confirmed' };
  const res = applyPatch(t, { purchaseStatus: 'draft' }, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, CODE.FIELD_NOT_EDITABLE);
});

test('作废：draft 与 confirmed 均可作废，重复作废被拒', () => {
  const draft = makeSsq().record;
  assert.equal(voidTicket(draft, { reason: '录错' }, { now: NOW }).update.purchaseStatus, 'void');

  const confirmed = { ...draft, purchaseStatus: 'confirmed' };
  const res = voidTicket(confirmed, {}, { now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.update.purchaseStatus, 'void');

  const already = { ...draft, purchaseStatus: 'void' };
  assert.equal(voidTicket(already, {}, { now: NOW }).code, CODE.TRANSITION_NOT_ALLOWED);
});

test('作废记录不可编辑', () => {
  const t = { ...makeSsq().record, purchaseStatus: 'void' };
  assert.equal(applyPatch(t, { note: 'x' }, { now: NOW }).code, CODE.FIELD_NOT_EDITABLE);
});

test('删除：已确认必须先作废', () => {
  const draft = { ...makeSsq().record };
  assert.equal(canDeleteTicket(draft).ok, true);
  assert.equal(canDeleteTicket({ ...draft, purchaseStatus: 'void' }).ok, true);

  const confirmed = { ...draft, purchaseStatus: 'confirmed' };
  const res = canDeleteTicket(confirmed);
  assert.equal(res.ok, false);
  assert.equal(res.code, CODE.DELETE_NOT_ALLOWED);
});

test('候选/草稿不计入统计与判奖，只有 confirmed 计入', () => {
  const draft = makeSsq().record;
  const confirmed = { ...draft, purchaseStatus: 'confirmed' };
  const voided = { ...draft, purchaseStatus: 'void' };

  for (const t of [draft, voided]) {
    assert.equal(isEligibleForPrize(t), false);
    assert.equal(isCountedInStats(t), false);
  }
  assert.equal(isEligibleForPrize(confirmed), true);
  assert.equal(isCountedInStats(confirmed), true);
});

test('分组统计只按 purchaseStatus 计数', () => {
  const s = summarize([
    { purchaseStatus: 'draft' },
    { purchaseStatus: 'draft' },
    { purchaseStatus: 'confirmed' },
    { purchaseStatus: 'void' },
  ]);
  assert.deepEqual(s, { draft: 2, confirmed: 1, void: 1, total: 4 });
});

test('金额建议：两个彩种单注均为 2 元，3 倍给 6 元建议值', () => {
  assert.deepEqual(suggestCost('ssq', 3), { value: 6, verified: true, source: '双色球游戏规则：单式一注 2 元' });
  const kl8 = suggestCost('kl8', 3);
  assert.equal(kl8.value, 6);
  assert.equal(kl8.verified, true);
  assert.match(kl8.source, /快乐8 单注 2 元/);
  assert.equal(suggestCost('kl8', 1).value, 2);
});

test('幂等键：可选的字符串，超长拒绝', () => {
  assert.equal(makeSsq({ idempotencyKey: 'abc123' }).ok, true);
  assert.equal(makeSsq({ idempotencyKey: 'x'.repeat(65) }).code, CODE.IDEMPOTENCY_INVALID);
});

test('候选导入的草稿标记来源，但仍不是已购买', () => {
  const res = makeSsq({ recordSource: 'candidate_import', candidateId: 'cand_1' });
  assert.equal(res.record.recordSource, 'candidate_import');
  assert.equal(res.record.candidateId, 'cand_1');
  assert.equal(res.record.purchaseStatus, 'draft');
});
