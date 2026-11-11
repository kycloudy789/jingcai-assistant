/**
 * 第二条号码通道（17500.cn 明文 txt）解析测试。
 * 这个源是 500.com XML 的备份：格式不同、站点独立，所以两边结果必须能对上。
 */

const test = require('node:test');
const assert = require('node:assert');

const txt = require('../shared/adapters/txt17500');
const { parseList } = require('../shared/adapters/kaijiang-xml');

test('17500 双色球：只取期号/日期/号码，后面一堆列忽略', () => {
  const text = [
    '2003001 2003-02-23 10 11 12 13 26 28 11 26 28 11 13 10 12 0 0 0',
    '2026129 2026-11-10 03 09 16 20 25 30 05 25 09 16 20 03 30 409899552 1134076885 47 2127659',
  ].join('\n');
  const rows = txt.parseText('ssq', text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].issue, '2026129');
  assert.equal(rows[0].drawDate, '2026-11-10');
  assert.deepEqual(rows[0].numbers.red, [3, 9, 16, 20, 25, 30]);
  assert.equal(rows[0].numbers.blue, 5);
});

test('17500 快乐8：20 个号码', () => {
  const nums = Array.from({ length: 20 }, (_, i) => i + 1);
  const row = ['2026300', '2026-11-10', ...nums.map(String), '102967106', '71482684'].join(' ');
  const rows = txt.parseText('kl8', row);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].numbers.kl8, nums);
});

test('17500 脏数据丢弃：期号/日期/号码个数/范围/重复', () => {
  const text = [
    '26129 2026-11-10 03 09 16 20 25 30 05',
    '2026129 2026/11/10 03 09 16 20 25 30 05',
    '2026129 2026-11-10 03 09 16 20 25 05',
    '2026129 2026-11-10 03 09 16 20 25 34 05',
    '2026129 2026-11-10 03 03 16 20 25 30 05',
    '2026129 2026-11-10 03 09 16 20 25 30 17',
  ].join('\n');
  assert.deepEqual(txt.parseText('ssq', text), []);
});

test('17500 同一期重复出现只保留一次', () => {
  const line = '2026129 2026-11-10 03 09 16 20 25 30 05';
  const rows = txt.parseText('ssq', [line, line].join('\n'));
  assert.equal(rows.length, 1);
});

test('两个源对同一期的解析结果一致（互相验证格式）', () => {
  const xml = '<xml><row expect="26129" opencode="03,09,16,20,25,30|05" opentime="2026-11-10 21:15:00" /></xml>';
  const fromXml = parseList('ssq', xml)[0];
  const fromTxt = txt.parseText('ssq', '2026129 2026-11-10 03 09 16 20 25 30 05')[0];
  assert.equal(fromXml.issue, fromTxt.issue);
  assert.deepEqual(fromXml.numbers, fromTxt.numbers);
});
