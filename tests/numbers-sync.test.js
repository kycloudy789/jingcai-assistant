/**
 * 号码快通道（500.com 静态 XML）解析测试。
 *
 * 这个解析器决定"开奖号码更不更新得上"，出错就是整站数据落后，
 * 所以每条脏数据路径都要覆盖：期号格式、号码个数、范围、重复。
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseList, normalizeIssue, listUrl } = require('../shared/adapters/kaijiang-xml');
const { GAME } = require('../shared/constants/games');

test('双色球：5 位期号补成 7 位，红蓝球拆开', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <xml>
    <row expect="26129" opencode="03,09,16,20,25,30|05" opentime="2026-11-10 21:15:00" />
    <row expect="03001" opencode="10,11,12,13,26,28|11" opentime="2003-02-23 00:00:00" />
  </xml>`;
  const rows = parseList(GAME.SSQ, xml);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].issue, '2026129', '应按期号降序');
  assert.equal(rows[0].drawDate, '2026-11-10');
  assert.deepEqual(rows[0].numbers.red, [3, 9, 16, 20, 25, 30]);
  assert.equal(rows[0].numbers.blue, 5);
  assert.equal(rows[1].issue, '2003001');
});

test('快乐8：20 个号码，7 位期号原样保留', () => {
  const nums = Array.from({ length: 20 }, (_, i) => i + 1);
  const xml = `<xml><row expect="2026300" opencode="${nums
    .map((n) => String(n).padStart(2, '0'))
    .join(',')}" opentime="2026-11-10 21:30:00" /></xml>`;
  const rows = parseList(GAME.KL8, xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, '2026300');
  assert.equal(rows[0].numbers.kl8.length, 20);
  assert.deepEqual(rows[0].numbers.kl8, nums);
});

test('脏数据一律丢弃，不猜', () => {
  const xml = `<xml>
    <row expect="26130" opencode="03,09,16,20,25|05" opentime="2026-11-11 21:15:00" />
    <row expect="26131" opencode="03,09,16,20,25,99|05" opentime="2026-11-12 21:15:00" />
    <row expect="26132" opencode="03,03,16,20,25,30|05" opentime="2026-11-13 21:15:00" />
    <row expect="26133" opencode="03,09,16,20,25,30|17" opentime="2026-11-14 21:15:00" />
    <row expect="26134" opencode="03,09,16,20,25,30" opentime="2026-11-15 21:15:00" />
    <row expect="26135" opencode="03,09,16,20,25,30|05" opentime="" />
  </xml>`;
  assert.deepEqual(parseList(GAME.SSQ, xml), [], '红球不足/越界/重复/蓝球越界/无分隔/无日期 全部应丢弃');
});

test('编号规范化：只接受 5 位或 7 位数字', () => {
  assert.equal(normalizeIssue(GAME.SSQ, '26129'), '2026129');
  assert.equal(normalizeIssue(GAME.SSQ, '2026129'), '2026129');
  assert.equal(normalizeIssue(GAME.SSQ, 'abc'), null);
  assert.equal(normalizeIssue(GAME.KL8, '2026300'), '2026300');
  assert.equal(normalizeIssue(GAME.KL8, '26300'), null, '快乐8 不接受 5 位');
});

test('列表地址按彩种生成', () => {
  assert.match(listUrl(GAME.SSQ), /\/ssq\/list\.xml$/);
  assert.match(listUrl(GAME.KL8), /\/kl8\/list\.xml$/);
});
