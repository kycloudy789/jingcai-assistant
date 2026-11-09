/**
 * 开奖数据补全（只动 web/data/draws/*.json，不联网抓开奖号码）。
 *
 * 做两件官方 JSON 接口给不了的事：
 *   1. 双色球福运奖状态：按《双色球游戏规则》第十八条，用奖池推导启停
 *      （接口对 2026076 之后把 fyjCount / fyjMoney 返回成空字符串）。
 *   2. 双色球派奖：二等奖特别奖 / 六等奖翻番奖只出现在公告详情页 HTML 里，
 *      接口没有。只对派奖期内的期次抓一次，抓到就写 promo，抓不到写 null（记为已检查）。
 *
 * 用法：
 *   node scripts/enrich-draws.js            # 补全 + 抓派奖
 *   node scripts/enrich-draws.js --offline  # 只做本地推导，不发网络请求
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { deriveSpecialRuleSeries } = require('../shared/rules/special-rule');
const { fetchPromo, PROMO_START_ISSUE } = require('../shared/adapters/cwl-promo');

const ROOT = path.join(__dirname, '..');
const DRAW_DIR = path.join(ROOT, 'web', 'data', 'draws');
const OFFLINE = process.argv.includes('--offline');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readPayload(game) {
  const file = path.join(DRAW_DIR, `${game}.json`);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(payload.records)) return null;
  return { file, payload };
}

function writePayload(file, payload) {
  payload.generatedAt = new Date().toISOString();
  payload.count = payload.records.length;
  payload.latestIssue = payload.records[0] ? payload.records[0].issue : null;
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));
}

/**
 * 重新计算 rawHash：把补全信息一并纳入，保证"数据变了 → 旧核对结果自动失效"。
 * 不重算就会出现"补了派奖金额，但历史核对记录还停在 5 元"的漏报。
 */
function rehash(record, signature) {
  const base = record.rawHash || sha256(JSON.stringify({ issue: record.issue, numbers: record.numbers }));
  return sha256(`${base}|${signature}`);
}

async function enrichSsq({ offline }) {
  const loaded = readPayload('ssq');
  if (!loaded) return { skipped: 'no-file' };
  const { file, payload } = loaded;

  // 1) 福运奖状态
  const derived = deriveSpecialRuleSeries(payload.records);
  let statusChanged = 0;
  for (const record of payload.records) {
    const info = derived.get(record.issue);
    if (!info) continue;
    if (record.specialRuleStatus !== info.status) statusChanged += 1;
    record.specialRuleStatus = info.status;
    record.specialRuleSource = info.source;
    if (info.reason) record.specialRuleReason = info.reason;
  }

  // 2) 派奖（只抓派奖期，且只抓没检查过的）
  let promoFetched = 0;
  let promoFound = 0;
  let promoFailed = 0;
  let hashChanged = 0;

  for (const record of payload.records) {
    if (Number(record.issue) < Number(PROMO_START_ISSUE)) {
      if (record.promo === undefined) record.promo = null;
      continue;
    }
    if (record.promo !== undefined) continue; // 已检查过（可能为 null）
    if (offline || !record.sourceUrl) {
      continue;
    }
    const res = await fetchPromo(record.sourceUrl);
    promoFetched += 1;
    if (!res.ok) {
      // 抓不到（云端对官方站 403）→ 保持 undefined，下次继续试，绝不写成"没有派奖"
      promoFailed += 1;
      continue;
    }
    record.promo = res.promo; // 可能是 null：页面确实没有派奖行
    if (res.promo) promoFound += 1;
  }

  // 3) 补全过的记录换哈希（否则历史核对不会重算）
  for (const record of payload.records) {
    const signature = `srs:${record.specialRuleStatus || ''}|promo:${
      record.promo ? JSON.stringify(record.promo) : 'none'
    }`;
    // 幂等：签名没变就不动哈希，否则每跑一次就把全部历史核对作废
    if (record.enrichSignature === signature) continue;
    if (record.rawHash) record.rawHash = rehash(record, signature);
    record.enrichSignature = signature;
    hashChanged += 1;
  }

  writePayload(file, payload);
  return { statusChanged, promoFetched, promoFound, promoFailed, hashChanged };
}

async function main() {
  const result = await enrichSsq({ offline: OFFLINE });
  if (result.skipped) {
    console.log(`! ssq: 没有可补全的文件（${result.skipped}）`);
    return;
  }
  console.log(
    `✓ ssq 补全：福运奖状态更新 ${result.statusChanged} 期；哈希更新 ${result.hashChanged} 期`
  );
  console.log(
    `  派奖：尝试 ${result.promoFetched} 期，命中 ${result.promoFound} 期，抓取失败 ${result.promoFailed} 期` +
      (result.promoFailed ? '（失败不会写 null，下次重试；云端对官方站 403 属预期）' : '')
  );

  const payload = JSON.parse(fs.readFileSync(path.join(DRAW_DIR, 'ssq.json'), 'utf8'));
  const withPromo = payload.records.filter((r) => r.promo);
  if (withPromo.length) {
    const latest = withPromo[0];
    console.log(
      `  派奖期最新 ${latest.issue}：二等奖特别奖 ${latest.promo.secondBonus ? latest.promo.secondBonus.amount + ' 元/注' : '—'}` +
        `，六等奖翻番奖 ${latest.promo.sixthBonus ? latest.promo.sixthBonus.amount + ' 元/注' : '—'}` +
        `，门槛 单票 ≥ ${latest.promo.perTicketAmount} 元`
    );
  }
}

main().catch((err) => {
  console.error('补全失败:', err.message);
  process.exitCode = 1;
});
