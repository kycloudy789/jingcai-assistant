/**
 * CSV 导入/导出测试（兜底通道必须可靠）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCsv, parseDrawsCsv, toDrawsCsv } = require('../shared/parsers/csv');
const { validateDrawRecord } = require('../shared/validators/draws');

const TEMPLATE = fs.readFileSync(
  path.resolve(__dirname, '..', 'data', 'samples', 'draws_template.csv'),
  'utf8'
);

test('模板文件可被解析，且无错误行', () => {
  const { records, errors, headerOk } = parseDrawsCsv(TEMPLATE, {
    validation: (r) => validateDrawRecord(r, { now: new Date('2026-12-31T00:00:00+08:00') }),
  });
  assert.equal(headerOk, true);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 2);
  assert.equal(records[0].game, 'ssq');
  assert.equal(records[1].game, 'kl8');
});

test('模板中的双色球行映射正确', () => {
  const { records } = parseDrawsCsv(TEMPLATE);
  const ssq = records.find((r) => r.game === 'ssq');
  assert.equal(ssq.issue, '2026126');
  assert.deepEqual(ssq.numbers.red, [9, 10, 13, 22, 29, 32]);
  assert.equal(ssq.numbers.blue, 12);
  assert.deepEqual(ssq.prizeInfo.first, { count: 5, amount: 9014860 });
  assert.equal(ssq.sourceType, 'manual_official_import');
  assert.equal(ssq.drawStatus, 'parsed');
});

test('模板中的快乐8行映射正确（20 个号码）', () => {
  const { records } = parseDrawsCsv(TEMPLATE);
  const kl8 = records.find((r) => r.game === 'kl8');
  assert.equal(kl8.numbers.kl8.length, 20);
  assert.deepEqual(kl8.numbers.kl8.slice(0, 2), [19, 23]);
});

test('引号包裹、逗号、转义双引号、CRLF、BOM 均可解析', () => {
  const text =
    '\uFEFFgame,issue,drawDate,red,blue,kl8,note\r\n' +
    'ssq,2026126,2026-11-03,"01,02,03,04,05,06",07,,"含,逗号与""引号"""\r\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][3], '01,02,03,04,05,06');
  assert.equal(rows[1][6], '含,逗号与"引号"');
});

test('缺少必需列时明确报错', () => {
  const { headerOk, errors } = parseDrawsCsv('foo,bar\n1,2\n');
  assert.equal(headerOk, false);
  assert.equal(errors[0].code, 'BAD_HEADER');
});

test('空文件给出行号可读的错误', () => {
  const { errors } = parseDrawsCsv('');
  assert.equal(errors[0].code, 'EMPTY_FILE');
});

test('单行号码非法时只跳过该行，并带行号', () => {
  const text =
    'game,issue,drawDate,red,blue,kl8\n' +
    'ssq,2026126,2026-11-03,"01,02,03,04,05,06",07,\n' +
    'ssq,2026125,2026-11-01,"01,02,03",08,\n';
  const { records, errors } = parseDrawsCsv(text, {
    validation: (r) => validateDrawRecord(r, { now: new Date('2026-12-31T00:00:00+08:00') }),
  });
  assert.equal(records.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.equal(errors[0].code, 'NUMBERS_INVALID');
});

test('导出后再导入保持一致（往返）', () => {
  const { records } = parseDrawsCsv(TEMPLATE);
  const csv = toDrawsCsv(records);
  const again = parseDrawsCsv(csv);
  assert.equal(again.errors.length, 0);
  assert.equal(again.records.length, records.length);
  assert.deepEqual(again.records[0].numbers, records[0].numbers);
  assert.deepEqual(again.records[1].numbers, records[1].numbers);
});
