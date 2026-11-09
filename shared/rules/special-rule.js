/**
 * 双色球特别规定（福运奖）启停推导。
 *
 * 依据《中国福利彩票双色球游戏规则》第十八条（2026-02-01 起执行）：
 *   1. 奖池资金 ≥ 15 亿元 → 开始执行特别规定，下一期起增设福运奖；
 *   2. 执行期间，某期开奖后奖池资金 < 3 亿元 → 停止执行，下一期起取消福运奖；
 *   3. 停止后，奖池资金再次 ≥ 15 亿元 → 重新执行。
 *
 * 也就是说：**当期是否执行，由上一期开奖后的奖池决定**。
 * 这不是"用奖池猜"，而是照着规则第十八条算状态机：
 *   - 官方公告明确给出福运奖注数/金额（>0）→ 本期一定在执行（证据优先）；
 *   - 期号 < 2026014 → 不适用；
 *   - 其余按状态机推进；任一环缺奖池数据 → 后续一律 unknown，转人工。
 *
 * 为什么必须做这件事：官方 JSON 接口对 2026076 之后的期次把 fyjCount / fyjMoney
 * 返回成空字符串。若一律判 unknown，"恰好 3 红 0 蓝"的票会永远停在待人工核验，
 * 等于把可能中的 5 元吞掉。
 */

const SPECIAL_RULE_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  NOT_APPLICABLE: 'not_applicable',
  UNKNOWN: 'unknown',
};

const POOL_START = 1500000000; // 15 亿
const POOL_STOP = 300000000; // 3 亿
const START_ISSUE = '2026014';

function poolOf(record) {
  const v = record && record.poolAmount;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function paidFuyun(record) {
  const f = record && record.prizeInfo && record.prizeInfo.fuyun;
  return !!(f && typeof f.amount === 'number' && f.amount > 0);
}

/**
 * 给一组双色球开奖记录（顺序不限）推导每期的福运奖状态。
 * @param {Array<object>} records
 * @returns {Map<string, {status: string, source: string, pool: number|null, reason: string}>}
 */
function deriveSpecialRuleSeries(records) {
  const asc = [...(records || [])].sort((a, b) => Number(a.issue) - Number(b.issue));
  const out = new Map();

  // 当前是否处于执行期；由「上一期开奖后的奖池」推进
  let state = SPECIAL_RULE_STATUS.NOT_APPLICABLE;
  let stateBroken = false; // 缺奖池 → 无法继续推导

  for (const record of asc) {
    const issue = String(record.issue || '');
    const pool = poolOf(record);
    const beforeStart = Number(issue) < Number(START_ISSUE);

    let status;
    let reason;

    if (beforeStart) {
      status = SPECIAL_RULE_STATUS.NOT_APPLICABLE;
      reason = 'BEFORE_RULE';
    } else if (paidFuyun(record)) {
      status = SPECIAL_RULE_STATUS.ACTIVE;
      reason = 'ANNOUNCEMENT_PAID';
      state = SPECIAL_RULE_STATUS.ACTIVE; // 公告派了奖 → 之后中间奖池区间继续执行
    } else if (stateBroken) {
      status = SPECIAL_RULE_STATUS.UNKNOWN;
      reason = 'POOL_MISSING';
    } else {
      status = state;
      reason = state === SPECIAL_RULE_STATUS.ACTIVE ? 'RULE_18_POOL_START' : 'RULE_18_POOL_STOP';
    }

    out.set(issue, {
      status,
      source: reason === 'ANNOUNCEMENT_PAID' ? 'announcement' : 'rule_18_pool',
      pool,
      reason,
    });

    // 用本期的奖池决定下一期是什么状态
    if (pool === null) {
      if (!beforeStart) stateBroken = true;
      continue;
    }
    if (pool >= POOL_START) state = SPECIAL_RULE_STATUS.ACTIVE;
    else if (pool < POOL_STOP) state = SPECIAL_RULE_STATUS.NOT_APPLICABLE;
    // 处于 [3 亿, 15 亿) 时不改变：执行中的继续执行，停了的继续停
  }

  return out;
}

module.exports = {
  SPECIAL_RULE_STATUS,
  POOL_START,
  POOL_STOP,
  START_ISSUE,
  deriveSpecialRuleSeries,
};
