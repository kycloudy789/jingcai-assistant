/**
 * 17500.cn 明文数据文件解析（第二条号码通道）。
 *
 * 每期一行，空格分隔：
 *   双色球：期号 日期 红×6 蓝 出球顺序×6 ... 其它列
 *   快乐8：期号 日期 号码×20 销量 奖池 ... 其它列
 *
 * 只取「期号 / 日期 / 号码」这三样——奖级明细的列结构在不同年份会变，
 * 拿不准的字段一律不解析，免得把错的金额写进判奖。
 */

const { GAME } = require('../constants/games');

const SOURCE = 'third_party:17500.cn';
const PARSER_VERSION = 'txt17500@1.0.0';

function listUrl(game) {
  if (game === GAME.SSQ) return 'https://data.17500.cn/ssq_asc.txt';
  if (game === GAME.KL8) return 'https://data.17500.cn/kl8_asc.txt';
  return null;
}

function validNumbers(list, min, max, count) {
  if (list.length !== count) return null;
  const nums = list.map(Number);
  if (!nums.every((n) => Number.isInteger(n) && n >= min && n <= max)) return null;
  if (new Set(nums).size !== nums.length) return null;
  return nums.sort((a, b) => a - b);
}

/** 解析一行；不合法返回 null */
function parseLine(game, line) {
  const parts = String(line || '').trim().split(/\s+/);
  if (parts.length < 3) return null;

  const issue = parts[0];
  const drawDate = parts[1];
  if (!/^\d{7}$/.test(issue)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) return null;

  if (game === GAME.SSQ) {
    const red = validNumbers(parts.slice(2, 8), 1, 33, 6);
    const blue = Number(parts[8]);
    if (!red) return null;
    if (!Number.isInteger(blue) || blue < 1 || blue > 16) return null;
    return { issue, drawDate, numbers: { red, blue, kl8: [] } };
  }

  if (game === GAME.KL8) {
    const kl8 = validNumbers(parts.slice(2, 22), 1, 80, 20);
    if (!kl8) return null;
    return { issue, drawDate, numbers: { red: [], blue: null, kl8 } };
  }

  return null;
}

/** 解析整份 txt → 按期号降序 */
function parseText(game, text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const row = parseLine(game, line);
    if (!row || seen.has(row.issue)) continue;
    seen.add(row.issue);
    out.push(row);
  }
  out.sort((a, b) => Number(b.issue) - Number(a.issue));
  return out;
}

module.exports = { parseText, parseLine, listUrl, SOURCE, PARSER_VERSION };
