/**
 * 号码组合的生成与展示（与界面无关，便于测试）。
 * 注数 = 生成几注不同号码；倍数 = 每注打几倍，两者独立。
 */

const { GAME } = require('../../shared/constants/games');

const MAX_BETS = 5;

function emptyBet() {
  return { red: [], blue: null, kl8: [] };
}

function betKey(bet, game) {
  return game === GAME.SSQ ? `${bet.red.join(',')}|${bet.blue}` : bet.kl8.join(',');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function betLabel(bet, game) {
  const parts = game === GAME.SSQ ? bet.red : bet.kl8;
  if (!parts.length) return '未选号';
  const main = parts.map(pad2).join(' ');
  return game === GAME.SSQ && bet.blue ? `${main} + ${pad2(bet.blue)}` : main;
}

function pick(from, to, count) {
  const pool = [];
  for (let n = from; n <= to; n += 1) pool.push(n);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

function randomBet(game) {
  return game === GAME.SSQ
    ? { red: pick(1, 33, 6), blue: pick(1, 16, 1)[0], kl8: [] }
    : { red: [], blue: null, kl8: pick(1, 80, 10) };
}

/**
 * 生成 count 注互不相同的号码。
 * 注数超过上限时截断到 5，低于 1 时按 1 处理。
 */
function randomBets(game, count) {
  const total = Math.max(1, Math.min(MAX_BETS, Number(count) || 1));
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < total && guard < total * 60) {
    guard += 1;
    const bet = randomBet(game);
    const key = betKey(bet, game);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bet);
  }
  return out;
}

module.exports = { MAX_BETS, emptyBet, betKey, betLabel, randomBet, randomBets, pad2 };
