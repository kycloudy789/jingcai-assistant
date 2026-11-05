/**
 * 规则版本解析测试（主方案 8.3 / 16.3 的版本边界）
 * 关键点：旧期不得套用新规则；查不到一律转人工。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRuleVersion, getUnitPrize, compareIssue, isValidIssue, KL8_CHOOSE10_PRIZE_TABLE } = require('../shared/rules/registry');

test('双色球：2026013 期无适用版本（不得回退到新规则）', () => {
  const r = resolveRuleVersion('ssq', '2026013');
  assert.equal(r.found, false);
  assert.equal(r.reason, 'NO_RULE_VERSION');
});

test('双色球：2026014 期起适用 ssq_2026_02_01', () => {
  const r = resolveRuleVersion('ssq', '2026014');
  assert.equal(r.found, true);
  assert.equal(r.ruleVersion, 'ssq_2026_02_01');
  assert.equal(r.rule.prizeTable[3], 3000);
});

test('双色球：后续期号沿用同一版本（无结束期号）', () => {
  assert.equal(resolveRuleVersion('ssq', '2026126').ruleVersion, 'ssq_2026_02_01');
  assert.equal(resolveRuleVersion('ssq', '2030001').ruleVersion, 'ssq_2026_02_01');
});

test('快乐8：2025349 期无适用版本', () => {
  assert.equal(resolveRuleVersion('kl8', '2025349').found, false);
});

test('快乐8：2025350 期起适用 kl8_2025_12_30', () => {
  const r = resolveRuleVersion('kl8', '2025350');
  assert.equal(r.ruleVersion, 'kl8_2025_12_30');
  assert.equal(r.rule.prizeTable[8], 720, '新规则 8 中 8 为 720 元（旧规则为 800 元）');
  assert.equal(r.rule.prizeTable[0], 2);
  assert.equal(r.rule.prizeTable[10], 'floating');
});

test('非法期号不被当作旧期处理', () => {
  assert.equal(resolveRuleVersion('ssq', '2026-11-03').reason, 'INVALID_ISSUE');
  assert.equal(resolveRuleVersion('ssq', '').reason, 'INVALID_ISSUE');
  assert.equal(isValidIssue('2026126'), true);
  assert.equal(isValidIssue(2026126), false, '期号必须是字符串');
});

test('期号比较：同位数按数值，非期号抛错', () => {
  assert.ok(compareIssue('2026126', '2026014') > 0);
  assert.ok(compareIssue('2025350', '2025349') > 0);
  assert.throws(() => compareIssue('2026', '2026126'));
});

test('奖级金额查询：浮动奖返回未知并要求读公告', () => {
  const rule = resolveRuleVersion('kl8', '2026294').rule;
  assert.deepEqual(getUnitPrize(rule, 10), { known: false, value: null, floating: true });
  assert.deepEqual(getUnitPrize(rule, 9), { known: true, value: 8000 });
  assert.equal(getUnitPrize(rule, 4).known, false, '1–4 命中无奖级');
});

test('快乐8 奖级表不含 1–4 命中', () => {
  for (const hit of [1, 2, 3, 4]) {
    assert.equal(Object.prototype.hasOwnProperty.call(KL8_CHOOSE10_PRIZE_TABLE, hit), false);
  }
});
