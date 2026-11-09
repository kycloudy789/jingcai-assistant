/**
 * 判奖完整性审计：把两个彩种的**全部命中组合**枚举一遍，对照独立写死的官方奖级表。
 *
 * 这张表是手写的，不从 registry.js 读 —— 否则代码写错、表也写错时会一起"通过"，
 * 等于没有测试。用户在核对页看到的数字，就是这张表算出来的。
 */

const test = require('node:test');
const assert = require('node:assert');

const { judgeTicket } = require('../shared/rules/judge');
const { GAME } = require('../shared/constants/games');
const { deriveSpecialRuleSeries } = require('../shared/rules/special-rule');
const { parsePromoFromHtml } = require('../shared/adapters/cwl-promo');

const SSQ_DRAW = {
  game: 'ssq',
  issue: '2026128',
  drawStatus: 'verified',
  numbers: { red: [1, 2, 3, 4, 5, 6], blue: 7, kl8: [] },
  prizeInfo: {
    first: { count: 4, amount: 10000000 },
    second: { count: 161, amount: 175266 },
    fuyun: null,
  },
  specialRuleStatus: 'not_applicable',
  rawHash: 'hash-ssq',
};

const KL8_DRAW = {
  game: 'kl8',
  issue: '2026298',
  drawStatus: 'verified',
  numbers: { red: [], blue: null, kl8: Array.from({ length: 20 }, (_, i) => i + 1) },
  prizeInfo: { choose10: { hit10: { count: 3, amount: 5000000 }, hit9: { count: 63, amount: 8000 } } },
  specialRuleStatus: 'not_applicable',
  rawHash: 'hash-kl8',
};

/** 双色球官方奖级：红球命中数 + 是否中蓝球 → 单注奖金（'floating' 表示读当期公告） */
const SSQ_EXPECTED = {
  '0+0': null,
  '0+1': 5,
  '1+0': null,
  '1+1': 5,
  '2+0': null,
  '2+1': 5,
  '3+0': 'fuyun', // 仅在特别规定执行期间
  '3+1': 10,
  '4+0': 10,
  '4+1': 200,
  '5+0': 200,
  '5+1': 3000,
  '6+0': 'floating',
  '6+1': 'floating',
};

/** 快乐8 选十官方奖级：命中个数 → 单注奖金 */
const KL8_EXPECTED = {
  10: 'floating',
  9: 8000,
  8: 720,
  7: 80,
  6: 5,
  5: 3,
  4: null,
  3: null,
  2: null,
  1: null,
  0: 2,
};

function ssqTicket(redHit, blueHit) {
  const red = [];
  for (let i = 1; i <= redHit; i += 1) red.push(i);
  // 补足 6 个红球，补的号码用 20 以后的，绝不会命中
  let filler = 20;
  while (red.length < 6) {
    red.push(filler);
    filler += 1;
  }
  return {
    game: GAME.SSQ,
    issue: '2026128',
    purchaseStatus: 'confirmed',
    multiple: 1,
    numbers: { red, blue: blueHit ? 7 : 8 },
  };
}

function kl8Ticket(hit) {
  const nums = [];
  for (let i = 1; i <= hit; i += 1) nums.push(i);
  let filler = 60;
  while (nums.length < 10) {
    nums.push(filler);
    filler += 1;
  }
  return {
    game: GAME.KL8,
    issue: '2026298',
    purchaseStatus: 'confirmed',
    multiple: 1,
    numbers: { kl8: nums },
  };
}

test('双色球：14 种命中组合的判奖结果全部符合官方奖级表', () => {
  for (const [key, expected] of Object.entries(SSQ_EXPECTED)) {
    const [r, b] = key.split('+').map(Number);
    const draw = { ...SSQ_DRAW, specialRuleStatus: expected === 'fuyun' ? 'not_applicable' : 'not_applicable' };
    const res = judgeTicket(ssqTicket(r, b), draw);

    if (expected === null) {
      assert.equal(res.checkStatus, 'not_winner', `${key} 应未中奖，实际 ${res.checkStatus}`);
      assert.equal(res.totalPrize, null);
      continue;
    }
    if (expected === 'fuyun') {
      // 特别规定未执行 → 3 红 0 蓝不中奖
      assert.equal(res.checkStatus, 'not_winner', `${key} 在特别规定未执行时应未中奖`);
      continue;
    }
    if (expected === 'floating') {
      assert.equal(res.checkStatus, 'checked', `${key} 应可判（公告金额存在）`);
      assert.ok(res.totalPrize > 0);
      continue;
    }
    assert.equal(res.checkStatus, 'checked', `${key} 应判为 CHECKED，实际 ${res.checkStatus}`);
    assert.equal(res.unitPrize, expected, `${key} 单注奖金应为 ${expected}，实际 ${res.unitPrize}`);
    assert.equal(res.totalPrize, expected);
  }
});

test('双色球：福运奖三种状态都不能把 3 红 0 蓝判错', () => {
  const t = ssqTicket(3, false);

  const active = judgeTicket(t, {
    ...SSQ_DRAW,
    specialRuleStatus: 'active',
  });
  assert.equal(active.checkStatus, 'checked');
  assert.equal(active.prizeLevel, 'fuyun');
  assert.equal(active.unitPrize, 5);

  const stopped = judgeTicket(t, { ...SSQ_DRAW, specialRuleStatus: 'not_applicable' });
  assert.equal(stopped.checkStatus, 'not_winner');

  const unknown = judgeTicket(t, { ...SSQ_DRAW, specialRuleStatus: 'unknown' });
  assert.equal(unknown.checkStatus, 'pending_manual_review');
  assert.equal(unknown.pendingReason, 'FUYUN_STATUS_UNKNOWN');
});

test('双色球：倍数按注乘，不是按票乘', () => {
  const t = { ...ssqTicket(5, true), multiple: 3 };
  const res = judgeTicket(t, SSQ_DRAW);
  assert.equal(res.prizeLevel, '3');
  assert.equal(res.unitPrize, 3000);
  assert.equal(res.totalPrize, 9000);
});

test('快乐8：11 种命中个数的判奖结果全部符合官方奖级表', () => {
  for (const [hitText, expected] of Object.entries(KL8_EXPECTED)) {
    const hit = Number(hitText);
    const res = judgeTicket(kl8Ticket(hit), KL8_DRAW);

    if (expected === null) {
      assert.equal(res.checkStatus, 'not_winner', `中 ${hit} 个应未中奖，实际 ${res.checkStatus}`);
      assert.equal(res.totalPrize, null);
      continue;
    }
    if (expected === 'floating') {
      assert.equal(res.checkStatus, 'checked');
      assert.equal(res.unitPrize, 5000000);
      continue;
    }
    assert.equal(res.checkStatus, 'checked', `中 ${hit} 个应判为 CHECKED`);
    assert.equal(res.unitPrize, expected, `中 ${hit} 个单注应为 ${expected}，实际 ${res.unitPrize}`);
  }
});

test('快乐8：中 4 个不设奖，且命中号码照实列出', () => {
  const res = judgeTicket(kl8Ticket(4), KL8_DRAW);
  assert.equal(res.checkStatus, 'not_winner');
  assert.equal(res.hit.count, 4);
  assert.deepEqual(res.hit.numbers, [1, 2, 3, 4]);
});

test('快乐8：中 0 个是七等奖 2 元（最容易漏的一档）', () => {
  const t = kl8Ticket(0);
  const res = judgeTicket(t, KL8_DRAW);
  assert.equal(res.checkStatus, 'checked');
  assert.equal(res.prizeLevel, '0');
  assert.equal(res.totalPrize, 2);
});

/* ---------------- 派奖 ---------------- */

const PROMO_DRAW = {
  ...SSQ_DRAW,
  promo: {
    program: 'ssq_2026_promo_12yi',
    perTicketAmount: 20,
    secondBonus: { count: 88, amount: 227272 },
    sixthBonus: { count: 7182590, amount: 5 },
  },
};

test('派奖：六等奖在单票满 20 元时才翻番', () => {
  const ok = judgeTicket({ ...ssqTicket(0, true), actualCost: 20 }, PROMO_DRAW);
  assert.equal(ok.unitPrize, 10, '5 元基本奖 + 5 元翻番奖');
  assert.equal(ok.promo.applied, true);
  assert.equal(ok.totalPrize, 10);

  const small = judgeTicket({ ...ssqTicket(0, true), actualCost: 2 }, PROMO_DRAW);
  assert.equal(small.unitPrize, 5, '未达门槛不加派奖');
  assert.equal(small.promo.applied, false);
  assert.equal(small.promo.reason, 'BELOW_THRESHOLD');
  assert.match(small.promo.note, /未达派奖门槛/);

  const unknown = judgeTicket({ ...ssqTicket(0, true), actualCost: null }, PROMO_DRAW);
  assert.equal(unknown.unitPrize, 5);
  assert.equal(unknown.promo.reason, 'TICKET_AMOUNT_UNKNOWN');
});

test('派奖：二等奖特别奖叠加在浮动奖之上', () => {
  const t = { ...ssqTicket(6, false), actualCost: 20 };
  const res = judgeTicket(t, PROMO_DRAW);
  assert.equal(res.prizeLevel, '2');
  assert.equal(res.unitPrize, 175266 + 227272);
  assert.equal(res.promo.label, '二等奖特别奖');
  assert.equal(res.totalPrize, 175266 + 227272);

  const small = judgeTicket({ ...t, actualCost: 2 }, PROMO_DRAW);
  assert.equal(small.unitPrize, 175266);
});

test('派奖：倍数同样作用于派奖金额', () => {
  const t = { ...ssqTicket(0, true), multiple: 10, actualCost: 20 };
  const res = judgeTicket(t, PROMO_DRAW);
  assert.equal(res.unitPrize, 10);
  assert.equal(res.totalPrize, 100);
});

test('派奖：没有 promo 的期次绝不多算钱', () => {
  const res = judgeTicket({ ...ssqTicket(0, true), actualCost: 100 }, SSQ_DRAW);
  assert.equal(res.unitPrize, 5);
  assert.equal(res.promo, null);
});

test('派奖：公告页解析出二等奖特别奖与六等奖翻番奖', () => {
  const html = `
    <p class="zgs_title">中奖情况</p>
    <table border="1">
      <tr><th>奖级</th><th>中奖注数（注）</th><th>单注中奖金额（元）</th></tr>
      <tr><td class="space">一等奖</td><td>4</td><td>10000000</td></tr>
      <tr><td class="space">二等奖</td><td>161</td><td>175266</td></tr>
      <tr><td class="space" style="letter-spacing: 0px">二等奖特别奖</td><td>88</td><td>227272</td></tr>
      <tr><td class="space">三等奖</td><td>1912</td><td>3000</td></tr>
      <tr><td class="space">六等奖翻番奖</td><td>7182590</td><td>5</td></tr>
    </table>
    <p>一等奖中奖情况：</p>`;
  const promo = parsePromoFromHtml(html);
  assert.ok(promo);
  assert.equal(promo.perTicketAmount, 20);
  assert.deepEqual(promo.secondBonus, { count: 88, amount: 227272 });
  assert.deepEqual(promo.sixthBonus, { count: 7182590, amount: 5 });
});

test('派奖：公告页没有派奖行时返回 null，不编造', () => {
  const html = `<p>中奖情况</p><table>
    <tr><td>一等奖</td><td>4</td><td>10000000</td></tr>
    <tr><td>二等奖</td><td>161</td><td>175266</td></tr>
    </table><p>一等奖中奖情况：</p>`;
  assert.equal(parsePromoFromHtml(html), null);
});

test('派奖：注数为 0 时金额不作数', () => {
  const html = `<p>中奖情况</p><table>
    <tr><td>二等奖特别奖</td><td>0</td><td>20000000</td></tr>
    <tr><td>六等奖翻番奖</td><td>0</td><td>5</td></tr>
    </table><p>一等奖中奖情况：</p>`;
  const promo = parsePromoFromHtml(html);
  assert.equal(promo.secondBonus.amount, null);
  assert.equal(promo.sixthBonus.amount, null);
});

/* ---------------- 福运奖启停推导 ---------------- */

function draw(issue, pool, fuyunAmount) {
  return {
    issue,
    poolAmount: pool,
    prizeInfo: fuyunAmount ? { fuyun: { count: 100, amount: fuyunAmount } } : { fuyun: null },
  };
}

test('福运奖：奖池 ≥15 亿启动、<3 亿停止、中间区间保持', () => {
  const series = [
    draw('2026013', 2961315457), // 29.6 亿 → 下一期启动
    draw('2026014', 2876368081, 5), // 执行中
    draw('2026015', 1000000000), // 10 亿：不改变，继续执行
    draw('2026016', 283183968), // 2.83 亿 → 下一期停止
    draw('2026017', 320076738), // 3.2 亿：不改变，仍停止
    draw('2026018', 1174385127), // 11.7 亿：未回到 15 亿，仍停止
  ];
  const m = deriveSpecialRuleSeries(series);
  assert.equal(m.get('2026013').status, 'not_applicable');
  assert.equal(m.get('2026014').status, 'active');
  assert.equal(m.get('2026015').status, 'active', '回落到 10 亿仍执行（这正是"低于 15 亿就停"的谣言）');
  assert.equal(m.get('2026016').status, 'active');
  assert.equal(m.get('2026017').status, 'not_applicable', '跌破 3 亿的下一期停止');
  assert.equal(m.get('2026018').status, 'not_applicable');
});

test('福运奖：奖池重新回到 15 亿会再次启动', () => {
  const m = deriveSpecialRuleSeries([
    draw('2026014', 1000000000, 5),
    draw('2026015', 250000000),
    draw('2026016', 1600000000),
    draw('2026017', 1500000000),
  ]);
  assert.equal(m.get('2026015').status, 'active');
  assert.equal(m.get('2026016').status, 'not_applicable');
  assert.equal(m.get('2026017').status, 'active');
});

test('福运奖：公告明确派了奖，一律以公告为准', () => {
  const m = deriveSpecialRuleSeries([
    draw('2026014', 200000000, 5), // 奖池跌破 3 亿，但公告确实派了
  ]);
  assert.equal(m.get('2026014').status, 'active');
  assert.equal(m.get('2026014').source, 'announcement');
});

test('福运奖：缺奖池数据时后续一律 unknown，不猜', () => {
  const m = deriveSpecialRuleSeries([
    draw('2026014', null),
    draw('2026015', 1000000000),
  ]);
  assert.equal(m.get('2026014').status, 'not_applicable', '没有前置状态时按未执行');
  assert.equal(m.get('2026015').status, 'unknown', '无法推导时必须转人工');
});
