/**
 * 号码生成测试：注数与倍数分离、每注号码互不相同、范围与数量合法。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_BETS, betKey, betLabel, randomBet, randomBets, emptyBet } = require('../web/js/bets');

test('双色球随机一注：6 个不重复红球 + 1 个蓝球', () => {
  for (let i = 0; i < 50; i += 1) {
    const bet = randomBet('ssq');
    assert.equal(bet.red.length, 6);
    assert.equal(new Set(bet.red).size, 6, '红球不能重复');
    assert.ok(bet.red.every((n) => n >= 1 && n <= 33));
    assert.deepEqual(bet.red, bet.red.slice().sort((a, b) => a - b), '应升序');
    assert.ok(bet.blue >= 1 && bet.blue <= 16);
    assert.deepEqual(bet.kl8, []);
  }
});

test('快乐8随机一注：10 个不重复号码，范围 1–80', () => {
  for (let i = 0; i < 50; i += 1) {
    const bet = randomBet('kl8');
    assert.equal(bet.kl8.length, 10);
    assert.equal(new Set(bet.kl8).size, 10);
    assert.ok(bet.kl8.every((n) => n >= 1 && n <= 80));
    assert.deepEqual(bet.kl8, bet.kl8.slice().sort((a, b) => a - b));
    assert.equal(bet.blue, null);
  }
});

test('注数 2 / 3 时生成两注、三注，且彼此不同', () => {
  for (const count of [2, 3]) {
    for (let round = 0; round < 20; round += 1) {
      const bets = randomBets('ssq', count);
      assert.equal(bets.length, count);
      const keys = bets.map((b) => betKey(b, 'ssq'));
      assert.equal(new Set(keys).size, count, `第 ${count} 注应互不相同`);
    }
  }
});

test('快乐8 多注同样互不相同', () => {
  const bets = randomBets('kl8', 3);
  assert.equal(bets.length, 3);
  assert.equal(new Set(bets.map((b) => betKey(b, 'kl8'))).size, 3);
});

test('注数边界：0 与负数按 1 注，超过 5 截断', () => {
  assert.equal(randomBets('ssq', 0).length, 1);
  assert.equal(randomBets('ssq', -3).length, 1);
  assert.equal(randomBets('ssq', 99).length, MAX_BETS);
  assert.equal(randomBets('ssq', '3').length, 3, '字符串数字也应识别');
});

test('展示文案：未选号 / 双色球带蓝球 / 快乐8 无括号', () => {
  assert.equal(betLabel(emptyBet(), 'ssq'), '未选号');
  assert.equal(betLabel({ red: [1, 5, 9, 12, 20, 33], blue: 7, kl8: [] }, 'ssq'), '01 05 09 12 20 33 + 07');
  assert.equal(betLabel({ red: [], blue: null, kl8: [1, 2, 3] }, 'kl8'), '01 02 03');
});
