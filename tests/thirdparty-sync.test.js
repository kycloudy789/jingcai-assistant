const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseSsq, parseKl8, merge, isOfficial, SOURCE } = require('../scripts/sync-thirdparty');

/* ---------------- 解析 ---------------- */

const SSQ_ROW = (issue, red, blue, date) => `
<tr class="t_tr1">
  <!--<td>2</td>--><td>${issue}</td>
  ${red.map((n) => `<td class="t_cfont2">${String(n).padStart(2, '0')}</td>`).join('')}
  <td class="t_cfont4">${String(blue).padStart(2, '0')}</td>
  <td class="t_cfont4">&nbsp;</td>
  <td>1,129,731,594</td>
  <td>3</td><td>10,000,000</td>
  <td>79</td><td>360,377</td>
  <td>346,422,846</td>
  <td>${date}</td>
</tr>`;

test('双色球解析：期号补全、号码、蓝球、日期、奖金、销量', () => {
  const html = `<table><tbody>
    ${SSQ_ROW('26127', [13, 14, 19, 25, 29, 32], 12, '2026-11-05')}
  </tbody></table>`;
  const rows = parseSsq(html);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.issue, '2026127');
  assert.deepEqual(r.numbers.red, [13, 14, 19, 25, 29, 32]);
  assert.equal(r.numbers.blue, 12);
  assert.equal(r.drawDate, '2026-11-05');
  assert.equal(r.prizeInfo.first.count, 3);
  assert.equal(r.prizeInfo.first.amount, 10000000);
  assert.equal(r.prizeInfo.second.amount, 360377);
  assert.equal(r.salesAmount, 346422846);
  assert.equal(r.poolAmount, 1129731594);
});

test('双色球解析：脏行（号码越界/期号格式不对）被丢弃', () => {
  const badRed = SSQ_ROW('26128', [13, 14, 19, 25, 29, 99], 12, '2026-11-06');
  const badIssue = SSQ_ROW('abcd', [1, 2, 3, 4, 5, 6], 7, '2026-11-06');
  assert.equal(parseSsq(`<table>${badRed}${badIssue}</table>`).length, 0);
});

test('快乐8解析：20 个号码 + 期号 + 日期', () => {
  const balls = Array.from({ length: 20 }, (_, i) => i + 1);
  const html = `
    <td class="td_title01"><a href="/shtml/kl8/2026297.shtml">快乐8 第 <font class="cfont2"><strong>2026297</strong></font> 期</a>
    <span class="span_right">开奖日期：2026年11月7日 兑奖截止日期：2027年1月5日</span></td>
    <ul>${balls.map((n) => `<li class="ball_red">${String(n).padStart(2, '0')}</li>`).join('')}</ul>`;
  const rows = parseKl8(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, '2026297');
  assert.equal(rows[0].drawDate, '2026-11-07');
  assert.equal(rows[0].numbers.kl8.length, 20);
  assert.equal(rows[0].numbers.kl8[0], 1);
  assert.equal(rows[0].numbers.kl8[19], 20);
});

test('快乐8解析：号码不足 20 个时整条丢弃（不写半条脏数据）', () => {
  const html = `<strong>2026297</strong> 开奖日期：2026年11月7日 <li class="ball_red">01</li>`;
  assert.equal(parseKl8(html).length, 0);
});

/* ---------------- 合并优先级 ---------------- */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jc-3rd-'));
}

const raw = (issue, red) => ({
  issue,
  drawDate: '2026-11-05',
  numbers: { red, blue: 12, kl8: [] },
  prizeInfo: { first: { count: 1, amount: 100 }, second: { count: 2, amount: 50 }, fuyun: null },
  salesAmount: null,
  poolAmount: null,
  specialRuleStatus: 'unknown',
});

test('合并：官方记录不会被第三方覆盖', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'ssq.json'),
    JSON.stringify({
      records: [
        {
          ...raw('2026127', [1, 2, 3, 4, 5, 6]),
          verifiedBy: 'official_api',
          sourceType: 'cwl',
        },
      ],
    })
  );

  const r = merge('ssq', [raw('2026127', [9, 10, 11, 12, 13, 14])], 'https://x', dir);
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 1);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'ssq.json'), 'utf8'));
  assert.deepEqual(saved.records[0].numbers.red, [1, 2, 3, 4, 5, 6], '官方号码必须保留');
});

test('合并：新期号写入并打第三方标记', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ssq.json'), JSON.stringify({ records: [] }));

  const r = merge('ssq', [raw('2026127', [4, 9, 13, 22, 29, 32])], 'https://x', dir);
  assert.equal(r.added, 1);
  assert.equal(r.kept, 1);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'ssq.json'), 'utf8'));
  assert.equal(saved.sourceType, SOURCE);
  assert.equal(saved.records[0].sourceType, SOURCE);
  assert.equal(saved.records[0].verifiedBy, SOURCE);
  assert.equal(saved.records[0].latestIssue, undefined);
  assert.equal(saved.latestIssue, '2026127');
  assert.ok(saved.records[0].ruleVersion, '应解析出规则版本');
});

test('合并：第三方记录可以被后续第三方更新（不算官方）', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ssq.json'), JSON.stringify({ records: [] }));
  merge('ssq', [raw('2026127', [1, 2, 3, 4, 5, 6])], 'https://x', dir);
  const r = merge('ssq', [raw('2026127', [4, 9, 13, 22, 29, 32])], 'https://x', dir);
  assert.equal(r.skipped, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'ssq.json'), 'utf8'));
  assert.deepEqual(saved.records[0].numbers.red, [4, 9, 13, 22, 29, 32]);
});

test('isOfficial：认 verifiedBy 与 sourceType 两种写法', () => {
  assert.equal(isOfficial({ verifiedBy: 'official_api' }), true);
  assert.equal(isOfficial({ sourceType: 'official_api' }), true);
  assert.equal(isOfficial({ sourceType: SOURCE }), false);
  assert.equal(isOfficial(null), false);
});
