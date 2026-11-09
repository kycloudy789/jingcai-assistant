/**
 * 双色球派奖（特别奖）解析。
 *
 * 背景：2026-11-02 中国福彩中心公告，自第 2026128 期起开展 12 亿元派奖：
 *   - 二等奖特别奖：每期 2000 万元，由当期「单票金额 ≥ 20 元」的二等奖中奖彩票按注均分，
 *     单注封顶 500 万元；
 *   - 六等奖翻番奖：对「单票金额 ≥ 20 元」的六等奖中奖彩票，每注再加 5 元（5 → 10）。
 *
 * 关键：这两项**不在官方 JSON 接口里**，只出现在开奖公告详情页（detailsLink）的奖级表中。
 * 所以只能从 HTML 表格抓，抓不到就保持 null —— 绝不猜一个金额填进去。
 */

const https = require('https');

/** 公告里「单票金额」门槛（元）。派奖规则原文：单票金额超过 20 元（含） */
const PROMO_TICKET_THRESHOLD = 20;

/** 已知派奖活动窗口；用于决定要不要去抓公告页（抓取有成本，不能对 2000 期全抓） */
const PROMO_START_ISSUE = '2026128';

const PROMO_LABEL = {
  second: '二等奖特别奖',
  sixth: '六等奖翻番奖',
};

function toNumber(text) {
  const raw = String(text === undefined || text === null ? '' : text)
    .replace(/<[^>]+>/g, '')
    .replace(/[,，\s]/g, '')
    .trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从开奖公告页 HTML 里取派奖奖级。
 * @param {string} html 公告页 HTML
 * @returns {{program: string, perTicketAmount: number, secondBonus: object|null, sixthBonus: object|null}|null}
 */
function parsePromoFromHtml(html) {
  const text = String(html || '');
  if (!text) return null;

  // 只在中奖情况表内取行，避免把奖金对照表、页脚表格混进来
  const start = text.indexOf('中奖情况');
  if (start < 0) return null;
  const end = text.indexOf('一等奖中奖情况', start);
  const table = text.slice(start, end > start ? end : start + 20000);

  const cells = (row) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    );

  const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const found = {};
  for (const row of rows) {
    const c = cells(row);
    if (c.length < 3) continue;
    const label = c[0].replace(/\s/g, '');
    if (label === PROMO_LABEL.second) found.second = { count: toNumber(c[1]), amount: toNumber(c[2]) };
    if (label === PROMO_LABEL.sixth) found.sixth = { count: toNumber(c[1]), amount: toNumber(c[2]) };
  }

  if (!found.second && !found.sixth) return null;

  // 注数为 0 时金额不作数（与官方 JSON 奖级的处理保持一致）
  const clean = (grade) => {
    if (!grade) return null;
    const count = typeof grade.count === 'number' ? grade.count : null;
    const amount = count !== null && count > 0 ? grade.amount : null;
    return { count, amount };
  };

  return {
    program: 'ssq_2026_promo_12yi',
    perTicketAmount: PROMO_TICKET_THRESHOLD,
    secondBonus: clean(found.second),
    sixthBonus: clean(found.sixth),
  };
}

function fetchHtml(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Connection: 'close',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(new TextDecoder('utf-8').decode(Buffer.concat(chunks)));
          } catch (err) {
            resolve(Buffer.concat(chunks).toString('utf8'));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * 抓一期公告页并解析派奖。
 * 关键区分：
 *   - {ok:true, promo:null}  → 页面拿到了，确实没有派奖行（可以标"已检查"）
 *   - {ok:false}             → 抓取失败（云端访问官方站 403），下次还要重试
 * 混为一谈的后果：云端一次 403 就把 promo 永久写成 null，派奖金额再也补不上。
 */
async function fetchPromo(url) {
  if (!url) return { ok: false, promo: null, reason: 'NO_URL' };
  try {
    const html = await fetchHtml(url);
    return { ok: true, promo: parsePromoFromHtml(html) };
  } catch (err) {
    return { ok: false, promo: null, reason: err.message };
  }
}

module.exports = {
  PROMO_TICKET_THRESHOLD,
  PROMO_START_ISSUE,
  parsePromoFromHtml,
  fetchPromo,
};
