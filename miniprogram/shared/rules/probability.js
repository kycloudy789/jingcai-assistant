/**
 * 机会概率（组合数学）。仅用于向用户如实说明概率量级，
 * 严禁用于任何"提高中奖概率"的表述。
 */

/** C(n, k)，n 较小，直接乘法即可（避免浮点误差用 BigInt 也不必要） */
function combination(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) {
    result = (result * (n - kk + i)) / i;
  }
  return Math.round(result);
}

/** 双色球一等奖：1 / (C(33,6) × 16) = 1 / 17,721,088 */
function ssqFirstPrizeOdds() {
  return combination(33, 6) * 16;
}

/** 快乐8选十命中 k 个的概率（超几何分布）：C(20,k)·C(60,10-k) / C(80,10) */
function kl8HitProbability(k) {
  const total = combination(80, 10);
  return (combination(20, k) * combination(60, 10 - k)) / total;
}

module.exports = { combination, ssqFirstPrizeOdds, kl8HitProbability };
