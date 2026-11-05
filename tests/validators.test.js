/**
 * 号码校验测试 —— 覆盖主方案 16.1 全表 + 展示/幂等辅助函数。
 * 运行：npm test（会先同步 shared/）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSsq,
  validateKl8,
  validateNumbers,
  parseNumbers,
  formatTwo,
  formatDisplay,
  combinationKey,
  CODE,
} = require('../shared/validators/numbers');
const { GAME } = require('../shared/constants/games');

test('双色球：正确号码通过并规范化升序', () => {
  const res = validateSsq([31, 3, 8, 12, 19, 25], 9);
  assert.equal(res.ok, true);
  assert.deepEqual(res.normalized.red, [3, 8, 12, 19, 25, 31]);
  assert.equal(res.normalized.blue, 9);
});

test('双色球：字符串输入可解析', () => {
  const res = validateNumbers(GAME.SSQ, { red: '01 05 09 12 20 33', blue: '07' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.normalized.red, [1, 5, 9, 12, 20, 33]);
  assert.equal(res.normalized.blue, 7);
});

test('双色球：红球数量错误被拒绝（5 个 / 7 个）', () => {
  assert.equal(validateSsq([1, 2, 3, 4, 5], 1).code, CODE.NUM_COUNT);
  assert.equal(validateSsq([1, 2, 3, 4, 5, 6, 7], 1).code, CODE.NUM_COUNT);
});

test('双色球：红球重复被拒绝', () => {
  assert.equal(validateSsq([1, 1, 3, 4, 5, 6], 1).code, CODE.NUM_DUPLICATE);
});

test('双色球：红球越界被拒绝（0 / 34）', () => {
  assert.equal(validateSsq([0, 2, 3, 4, 5, 6], 1).code, CODE.NUM_RANGE);
  assert.equal(validateSsq([1, 2, 3, 4, 5, 34], 1).code, CODE.NUM_RANGE);
});

test('双色球：蓝球越界被拒绝（0 / 17）', () => {
  assert.equal(validateSsq([1, 2, 3, 4, 5, 6], 0).code, CODE.NUM_RANGE);
  assert.equal(validateSsq([1, 2, 3, 4, 5, 6], 17).code, CODE.NUM_RANGE);
});

test('双色球：非整数/非法字符被拒绝', () => {
  assert.equal(validateSsq(['1', '2', '3', '4', '5', 'x'], 1).code, CODE.NUM_TYPE);
  assert.equal(validateSsq([1.5, 2, 3, 4, 5, 6], 1).code, CODE.NUM_TYPE);
});

test('快乐8：10 个不同号码通过', () => {
  const nums = [1, 12, 23, 34, 45, 56, 60, 67, 72, 80];
  const res = validateKl8(nums);
  assert.equal(res.ok, true);
  assert.deepEqual(res.normalized.kl8, nums);
});

test('快乐8：数量错误被拒绝（9 / 11）', () => {
  assert.equal(validateKl8([1, 2, 3, 4, 5, 6, 7, 8, 9]).code, CODE.NUM_COUNT);
  assert.equal(validateKl8([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).code, CODE.NUM_COUNT);
});

test('快乐8：重复 / 越界（0 / 81）被拒绝', () => {
  assert.equal(validateKl8([1, 1, 3, 4, 5, 6, 7, 8, 9, 10]).code, CODE.NUM_DUPLICATE);
  assert.equal(validateKl8([0, 2, 3, 4, 5, 6, 7, 8, 9, 10]).code, CODE.NUM_RANGE);
  assert.equal(validateKl8([1, 2, 3, 4, 5, 6, 7, 8, 9, 81]).code, CODE.NUM_RANGE);
});

test('快乐8：开奖号码按 20 个校验', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(validateKl8(twenty, { asDraw: true }).ok, true);
  assert.equal(validateKl8(twenty.slice(0, 19), { asDraw: true }).code, CODE.NUM_COUNT);
});

test('不支持的彩种被拒绝', () => {
  assert.equal(validateNumbers('fc3d', { red: [1] }).code, CODE.GAME_UNSUPPORTED);
});

test('空输入被拒绝', () => {
  assert.equal(parseNumbers('').code, CODE.NUM_EMPTY);
  assert.equal(parseNumbers(null).code, CODE.NUM_EMPTY);
  assert.equal(validateSsq([], 1).code, CODE.NUM_EMPTY);
});

test('两位格式化与展示文本', () => {
  assert.equal(formatTwo(7), '07');
  assert.equal(formatTwo(80), '80');
  const ssq = { red: [1, 5, 9, 12, 20, 33], blue: 7, kl8: [] };
  assert.equal(formatDisplay(GAME.SSQ, ssq), '01 05 09 12 20 33 | 07');
  assert.equal(
    formatDisplay(GAME.KL8, { kl8: [1, 2, 3, 4, 5, 6, 7, 8, 9, 80] }),
    '01 02 03 04 05 06 07 08 09 80'
  );
});

test('幂等键：同组合不同顺序得到相同键', () => {
  const a = combinationKey(GAME.SSQ, { red: [3, 8, 12, 19, 25, 31], blue: 9 });
  const b = combinationKey(GAME.SSQ, { red: [31, 25, 19, 12, 8, 3], blue: 9 });
  assert.equal(a, b);
  assert.notEqual(
    combinationKey(GAME.SSQ, { red: [3, 8, 12, 19, 25, 31], blue: 9 }),
    combinationKey(GAME.SSQ, { red: [3, 8, 12, 19, 25, 31], blue: 10 })
  );
});
