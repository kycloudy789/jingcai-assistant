/**
 * 判奖引擎测试 —— 覆盖主方案 16.2 / 16.3 全表 + 概率自检。
 * 这些用例是"算错钱"的最后一道防线，任何一条改动都必须先让它们变绿。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { judgeTicket, CHECK_STATUS, PENDING_REASON, checkIdempotencyKey } = require('../shared/rules/judge');
const { combination, ssqFirstPrizeOdds, kl8HitProbability } = require('../shared/rules/probability');

const NOW = '2026-11-05T10:00:00.000Z';

function ssqDraw(over = {}) {
  return {
    _id: 'draw_ssq_2026126',
    game: 'ssq',
    issue: '2026126',
    drawStatus: 'verified',
    rawHash: 'hash_ssq_126',
    numbers: { red: [1, 2, 3, 4, 5, 6], blue: 7, kl8: [] },
    prizeInfo: {
      first: { count: 5, amount: 9014860 },
      second: { count: 159, amount: 157816 },
      third: { count: 1412, amount: 3000 },
      fourth: { count: 61720, amount: 200 },
      fifth: { count: 1272146, amount: 10 },
      sixth: { count: 7670635, amount: 5 },
      fuyun: null,
    },
    specialRuleStatus: 'inactive',
    ...over,
  };
}

function kl8Draw(over = {}) {
  return {
    _id: 'draw_kl8_2026294',
    game: 'kl8',
    issue: '2026294',
    drawStatus: 'verified',
    rawHash: 'hash_kl8_294',
    numbers: { red: [], blue: null, kl8: Array.from({ length: 20 }, (_, i) => i + 1) },
    prizeInfo: {
      choose10: {
        hit10: { count: 1, amount: 5000000 },
        hit9: { count: 50, amount: 8000 },
        hit8: { count: 715, amount: 720 },
        hit7: { count: 8768, amount: 80 },
        hit6: { count: 68339, amount: 5 },
        hit5: { count: 336264, amount: 3 },
        hit0: { count: 308049, amount: 2 },
      },
    },
    specialRuleStatus: 'not_applicable',
    ...over,
  };
}

function ssqTicket(red, blue, over = {}) {
  return {
    _id: 'tk_ssq_1',
    game: 'ssq',
    issue: '2026126',
    purchaseStatus: 'confirmed',
    multiple: 1,
    numbers: { red, blue, kl8: [] },
    ...over,
  };
}

function kl8Ticket(kl8, over = {}) {
  return {
    _id: 'tk_kl8_1',
    game: 'kl8',
    issue: '2026294',
    purchaseStatus: 'confirmed',
    multiple: 1,
    numbers: { red: [], blue: null, kl8 },
    ...over,
  };
}

const judge = (ticket, draw, options = {}) => judgeTicket(ticket, draw, { checkedAt: NOW, ...options });

// ---------------- 双色球：六奖级 ----------------

test('双色球 6红+1蓝 → 一等奖，金额取当期公告', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7), ssqDraw());
  assert.equal(r.checkStatus, CHECK_STATUS.CHECKED);
  assert.equal(r.prizeLevel, '1');
  assert.equal(r.unitPrize, 9014860);
  assert.equal(r.totalPrize, 9014860);
  assert.equal(r.hit.red, 6);
  assert.equal(r.hit.blue, true);
  assert.equal(r.isWinner, true);
  assert.equal(r.ruleVersion, 'ssq_2026_02_01');
});

test('双色球 6红+0蓝 → 二等奖', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 8), ssqDraw());
  assert.equal(r.prizeLevel, '2');
  assert.equal(r.unitPrize, 157816);
});

test('双色球 5红+1蓝 → 三等奖 3000 元', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 33], 7), ssqDraw());
  assert.equal(r.prizeLevel, '3');
  assert.equal(r.unitPrize, 3000);
});

test('双色球 5红+0蓝 → 四等奖 200 元', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 33], 8), ssqDraw());
  assert.equal(r.prizeLevel, '4');
  assert.equal(r.unitPrize, 200);
});

test('双色球 4红+1蓝 → 四等奖 200 元', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 32, 33], 7), ssqDraw());
  assert.equal(r.prizeLevel, '4');
  assert.equal(r.unitPrize, 200);
});

test('双色球 4红+0蓝 → 五等奖 10 元', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 32, 33], 8), ssqDraw());
  assert.equal(r.prizeLevel, '5');
  assert.equal(r.unitPrize, 10);
});

test('双色球 3红+1蓝 → 五等奖 10 元（不是福运奖）', () => {
  const r = judge(ssqTicket([1, 2, 3, 31, 32, 33], 7), ssqDraw());
  assert.equal(r.prizeLevel, '5');
  assert.equal(r.unitPrize, 10);
});

test('双色球 仅中蓝球 → 六等奖 5 元', () => {
  const r = judge(ssqTicket([11, 12, 13, 14, 15, 16], 7), ssqDraw());
  assert.equal(r.prizeLevel, '6');
  assert.equal(r.unitPrize, 5);
});

test('双色球 未中奖 → not_winner 且无奖金', () => {
  const r = judge(ssqTicket([11, 12, 13, 14, 15, 16], 8), ssqDraw());
  assert.equal(r.checkStatus, CHECK_STATUS.NOT_WINNER);
  assert.equal(r.prizeLevel, null);
  assert.equal(r.unitPrize, null);
  assert.equal(r.isWinner, false);
});

// ---------------- 双色球：福运奖三态 ----------------

test('双色球 3红0蓝 + 特别规定生效 → 福运奖 5 元', () => {
  const draw = ssqDraw({ specialRuleStatus: 'active' });
  const r = judge(ssqTicket([1, 2, 3, 31, 32, 33], 8), draw);
  assert.equal(r.prizeLevel, 'fuyun');
  assert.equal(r.unitPrize, 5);
  assert.equal(r.isWinner, true);
});

test('双色球 3红0蓝 + 特别规定未执行 → 不中奖', () => {
  const draw = ssqDraw({ specialRuleStatus: 'inactive' });
  const r = judge(ssqTicket([1, 2, 3, 31, 32, 33], 8), draw);
  assert.equal(r.checkStatus, CHECK_STATUS.NOT_WINNER);
});

test('双色球 3红0蓝 + 规则起始期之前 → 不中奖', () => {
  const draw = ssqDraw({ specialRuleStatus: 'not_applicable', issue: '2026126' });
  const r = judge(ssqTicket([1, 2, 3, 31, 32, 33], 8), draw);
  assert.equal(r.checkStatus, CHECK_STATUS.NOT_WINNER);
});

test('双色球 3红0蓝 + 状态未知 → 待人工核验，不给结论', () => {
  const draw = ssqDraw({ specialRuleStatus: 'unknown' });
  const r = judge(ssqTicket([1, 2, 3, 31, 32, 33], 8), draw);
  assert.equal(r.checkStatus, CHECK_STATUS.PENDING);
  assert.equal(r.pendingReason, PENDING_REASON.FUYUN_STATUS_UNKNOWN);
  assert.equal(r.prizeLevel, null);
  assert.equal(r.isWinner, false);
});

// ---------------- 双色球：浮动奖缺失 ----------------

test('双色球 一等奖无人中（count=0, amount=null）→ 待官方公告，不估算', () => {
  const draw = ssqDraw({ prizeInfo: { ...ssqDraw().prizeInfo, first: { count: 0, amount: null } } });
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7), draw);
  assert.equal(r.checkStatus, CHECK_STATUS.PENDING);
  assert.equal(r.pendingReason, PENDING_REASON.PRIZE_AMOUNT_PENDING);
  assert.equal(r.prizeLevel, '1');
  assert.equal(r.unitPrize, null);
  assert.equal(r.totalPrize, null);
});

test('双色球 二等奖缺金额 → 待官方公告', () => {
  const draw = ssqDraw({ prizeInfo: { ...ssqDraw().prizeInfo, second: null } });
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 8), draw);
  assert.equal(r.pendingReason, PENDING_REASON.PRIZE_AMOUNT_PENDING);
  assert.equal(r.prizeLevel, '2');
});

test('倍数参与总奖金：2 倍一等奖 = 单注 × 2', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7, { multiple: 2 }), ssqDraw());
  assert.equal(r.quantity, 2);
  assert.equal(r.totalPrize, 9014860 * 2);
});

// ---------------- 快乐8：选十全表 ----------------

test('快乐8 中 10 → 浮动奖，取当期公告', () => {
  const r = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), kl8Draw());
  assert.equal(r.prizeLevel, '10');
  assert.equal(r.unitPrize, 5000000);
  assert.equal(r.hit.count, 10);
});

test('快乐8 中 9 → 8000 元', () => {
  const r = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 7, 8, 9, 21]), kl8Draw());
  assert.equal(r.prizeLevel, '9');
  assert.equal(r.unitPrize, 8000);
});

test('快乐8 中 8 → 720 元（新规则，非旧规则的 800）', () => {
  const r = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 7, 8, 21, 22]), kl8Draw());
  assert.equal(r.prizeLevel, '8');
  assert.equal(r.unitPrize, 720);
});

test('快乐8 中 7 → 80 元；中 6 → 5 元；中 5 → 3 元', () => {
  const seven = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 7, 21, 22, 23]), kl8Draw());
  assert.equal(seven.unitPrize, 80);
  const six = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 21, 22, 23, 24]), kl8Draw());
  assert.equal(six.unitPrize, 5);
  const five = judge(kl8Ticket([1, 2, 3, 4, 5, 21, 22, 23, 24, 25]), kl8Draw());
  assert.equal(five.unitPrize, 3);
});

test('快乐8 中 4 → 不中奖（1–4 均无奖）', () => {
  for (const hit of [1, 2, 3, 4]) {
    const picked = Array.from({ length: hit }, (_, i) => i + 1)
      .concat(Array.from({ length: 10 - hit }, (_, i) => 21 + i));
    const r = judge(kl8Ticket(picked), kl8Draw());
    assert.equal(r.checkStatus, CHECK_STATUS.NOT_WINNER, `hit=${hit}`);
  }
});

test('快乐8 中 0 → 2 元', () => {
  const r = judge(kl8Ticket([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]), kl8Draw());
  assert.equal(r.prizeLevel, '0');
  assert.equal(r.unitPrize, 2);
  assert.equal(r.hit.count, 0);
});

test('快乐8 中 10 但当期无人中（amount=null）→ 待官方公告', () => {
  const draw = kl8Draw({
    prizeInfo: { choose10: { ...kl8Draw().prizeInfo.choose10, hit10: { count: 0, amount: null } } },
  });
  const r = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), draw);
  assert.equal(r.pendingReason, PENDING_REASON.PRIZE_AMOUNT_PENDING);
  assert.equal(r.prizeLevel, '10');
  assert.equal(r.unitPrize, null);
});

test('快乐8 旧期（2025350 之前）无规则版本 → 待人工，不套用新规则', () => {
  const draw = kl8Draw({ _id: 'draw_kl8_old', issue: '2025349' });
  const r = judge(kl8Ticket([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { issue: '2025349' }), draw);
  assert.equal(r.checkStatus, CHECK_STATUS.PENDING);
  assert.equal(r.pendingReason, PENDING_REASON.NO_RULE_VERSION);
  assert.equal(r.prizeLevel, null, '绝不能给出奖级');
});

// ---------------- 前置条件 ----------------

test('未确认购买的记录不判奖', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7, { purchaseStatus: 'draft' }), ssqDraw());
  assert.equal(r.ok, false);
  assert.equal(r.code, PENDING_REASON.NOT_CONFIRMED);
});

test('没有开奖数据 → 待开奖', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7), null);
  assert.equal(r.pendingReason, PENDING_REASON.NO_DRAW);
});

test('开奖未核验（parsed/conflict）→ 不判奖', () => {
  for (const status of ['parsed', 'conflict', 'pending']) {
    const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7), ssqDraw({ drawStatus: status }));
    assert.equal(r.checkStatus, CHECK_STATUS.PENDING, status);
    assert.equal(r.pendingReason, PENDING_REASON.DRAW_NOT_VERIFIED);
  }
});

test('已更正的开奖数据可以判奖', () => {
  const r = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7), ssqDraw({ drawStatus: 'corrected' }));
  assert.equal(r.checkStatus, CHECK_STATUS.CHECKED);
  assert.equal(r.prizeLevel, '1');
});

test('期号/彩种不匹配 → 拒绝，不做跨期错配', () => {
  const r1 = judge(ssqTicket([1, 2, 3, 4, 5, 6], 7, { issue: '2026125' }), ssqDraw());
  assert.equal(r1.pendingReason, PENDING_REASON.MISMATCH);
  const r2 = judge(kl8Ticket([1, 2, 3]), ssqDraw());
  assert.equal(r2.pendingReason, PENDING_REASON.MISMATCH);
});

test('幂等键包含票、开奖、规则版本与原始哈希', () => {
  const t = ssqTicket([1, 2, 3, 4, 5, 6], 7);
  const d = ssqDraw();
  const k1 = checkIdempotencyKey(t, d, 'ssq_2026_02_01');
  const k2 = checkIdempotencyKey(t, d, 'ssq_2026_02_01');
  assert.equal(k1, k2);
  assert.notEqual(k1, checkIdempotencyKey(t, { ...d, rawHash: 'changed' }, 'ssq_2026_02_01'));
  assert.notEqual(k1, checkIdempotencyKey(t, d, 'ssq_other'));
});

// ---------------- 概率自检 ----------------

test('概率公式：双色球一等奖 1/17,721,088', () => {
  assert.equal(ssqFirstPrizeOdds(), 17721088);
  assert.equal(combination(33, 6), 1107568);
  assert.equal(combination(80, 10), 1646492110120);
});

test('概率公式：快乐8选十各命中概率之和为 1', () => {
  let sum = 0;
  for (let k = 0; k <= 10; k += 1) sum += kl8HitProbability(k);
  assert.ok(Math.abs(sum - 1) < 1e-12, `sum=${sum}`);
});
