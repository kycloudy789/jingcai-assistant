#!/usr/bin/env node
/**
 * 判奖自检（真实官方开奖数据 + 构造的号码，不写数据库）：
 *   拉取最新一期 → 映射为开奖记录 → 用真实号码构造几种票 → 跑判奖 → 打印结论
 * 用法：node scripts/verify-judge.js [ssq|kl8]
 */
const https = require('https');

const { buildQueryUrl, mapRecord } = require('../shared/adapters/cwl');
const { judgeTicket } = require('../shared/rules/judge');
const { sha256, prepareRecord } = require('../shared/cloud/drawStore');

const game = process.argv[2] === 'kl8' ? 'kl8' : 'ssq';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (jingcai-assistant verifier)' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('响应不是合法 JSON'));
        }
      });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

function ticket(numbers, multiple = 1) {
  return { _id: 'test', game, issue: null, purchaseStatus: 'confirmed', multiple, numbers };
}

(async () => {
  const url = buildQueryUrl({ game, mode: 'incremental', issueCount: 1 });
  const payload = await fetchJson(url);
  const raw = payload.result && payload.result[0];
  if (!raw) throw new Error('官方接口未返回数据');

  const mapped = mapRecord(game, raw);
  if (!mapped.ok) throw new Error(`映射失败: ${mapped.message}`);

  // 与线上一致：入库前会经过 prepareRecord（校验 + 标 verified + 解析规则版本）
  const rawHash = sha256(JSON.stringify(raw));
  const prepared = prepareRecord(mapped.record, { rawHash });
  if (!prepared.ok) throw new Error(`校验失败: ${prepared.message}`);

  const draw = { ...prepared.record, _id: 'draw_test' };
  const issue = draw.issue;
  console.log(`开奖：${game} ${issue} ${draw.drawDate}`);
  console.log(`状态：${draw.drawStatus}｜福运奖状态：${draw.specialRuleStatus}`);
  console.log(`号码：${draw.numbers.red.join(' ')}${draw.numbers.blue ? ' | ' + draw.numbers.blue : ''}${
    game === 'kl8' ? draw.numbers.kl8.join(' ') : ''
  }`);
  console.log('');

  const cases = [];
  if (game === 'ssq') {
    const drawRed = draw.numbers.red;
    const drawBlue = draw.numbers.blue;
    const redPool = new Set(drawRed);
    const otherRed = [];
    for (let n = 1; n <= 33 && otherRed.length < 6; n += 1) if (!redPool.has(n)) otherRed.push(n);
    const otherBlue = drawBlue === 16 ? 15 : 16;

    cases.push(['全中 6+1（一等奖）', ticket({ red: drawRed, blue: drawBlue })]);
    cases.push([
      '5 红 + 蓝（三等奖）',
      ticket({ red: drawRed.slice(0, 5).concat(otherRed.slice(0, 1)), blue: drawBlue }),
    ]);
    cases.push([
      '仅中 3 红（福运奖边界）',
      ticket({ red: drawRed.slice(0, 3).concat(otherRed.slice(0, 3)), blue: otherBlue }),
    ]);
    cases.push([
      '中 1 蓝（六等奖）',
      ticket({ red: otherRed.slice(0, 6), blue: drawBlue }),
    ]);
    cases.push(['全不中', ticket({ red: otherRed.slice(0, 6), blue: otherBlue })]);
  } else {
    const d = draw.numbers.kl8;
    const pool = new Set(d);
    const others = [];
    for (let n = 1; n <= 80 && others.length < 10; n += 1) if (!pool.has(n)) others.push(n);
    const build = (hit) => d.slice(0, hit).concat(others.slice(0, 10 - hit));

    cases.push(['中 10（浮动奖）', ticket({ kl8: build(10) })]);
    cases.push(['中 8（720 元）', ticket({ kl8: build(8) })]);
    cases.push(['中 5（3 元）', ticket({ kl8: build(5) })]);
    cases.push(['中 0（2 元）', ticket({ kl8: build(0) })]);
    cases.push(['中 3（不中奖）', ticket({ kl8: build(3) })]);
  }

  for (const [label, t] of cases) {
    const r = judgeTicket({ ...t, issue }, draw);
    const amount = r.totalPrize === null ? '—' : `${r.totalPrize} 元`;
    console.log(
      `${label.padEnd(22)} → ${String(r.checkStatus).padEnd(22)} 奖级=${String(r.prizeLevel).padEnd(5)} 奖金=${amount}${
        r.pendingReason ? '  原因=' + r.pendingReason : ''
      }`
    );
  }

  console.log('\n说明：一等奖/10 中 10 的金额来自当期官方公告；若该期无人中，官方不公布单注金额，系统显示待公告。');
})().catch((err) => {
  console.error(`✗ 自检失败: ${err.message}`);
  process.exit(1);
});
