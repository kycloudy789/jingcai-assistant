/**
 * 规则版本注册表（主方案 8.3）。
 * 判奖逻辑在阶段 4 实现；本文件只负责"某期适用哪一版规则"与奖级表查询。
 * 严禁在页面或判奖代码里硬编码奖级金额。
 */

const { GAME } = require('../constants/games');

/**
 * 期号比较：仅接受 7 位数字期号，按整数比较（安全，远小于 2^53）。
 * 不做"上期+1"推算——期号只认官方公告。
 */
function isValidIssue(issue) {
  return typeof issue === 'string' && /^\d{7}$/.test(issue);
}

function compareIssue(a, b) {
  if (!isValidIssue(a) || !isValidIssue(b)) {
    throw new Error(`非法期号: ${a} / ${b}`);
  }
  return Number(a) - Number(b);
}

/** 双色球奖级：1–6 等奖；福运奖为特别规定，单列 */
const SSQ_PRIZE_TABLE = {
  1: 'floating',
  2: 'floating',
  3: 3000,
  4: 200,
  5: 10,
  6: 5,
};

/** 快乐8选十奖级：键为命中个数 */
const KL8_CHOOSE10_PRIZE_TABLE = {
  10: 'floating',
  9: 8000,
  8: 720,
  7: 80,
  6: 5,
  5: 3,
  0: 2,
};

/**
 * 已建档规则版本。旧版本（ssq < 2026014、kl8 < 2025350）尚未取得权威文本，
 * 不建档即代表"不支持自动核对"，必须转人工，不得套用新规则。
 */
const RULE_VERSIONS = [
  {
    game: GAME.SSQ,
    ruleVersion: 'ssq_2026_02_01',
    effectiveFromIssue: '2026014',
    effectiveToIssue: null,
    prizeTable: SSQ_PRIZE_TABLE,
    specialRuleConditions: {
      type: 'fuyun',
      matchRed: 3,
      prizePerTicket: 5,
      poolStartAmount: 1500000000,
      poolStopAmount: 300000000,
      note: '奖池达 15 亿元（含）起执行；执行后奖池低于 3 亿元停止。按期官方公告判定。',
    },
    sourceUrl: 'https://www.scflcp.com.cn/tzgg/823144831.jhtml',
    verifiedAt: '2026-11-04',
    status: 'active',
  },
  {
    game: GAME.KL8,
    ruleVersion: 'kl8_2025_12_30',
    effectiveFromIssue: '2025350',
    effectiveToIssue: null,
    prizeTable: KL8_CHOOSE10_PRIZE_TABLE,
    specialRuleConditions: {},
    sourceUrl: 'https://www.scflcp.com.cn/yxgz/823144315.jhtml',
    verifiedAt: '2026-11-04',
    status: 'active',
  },
];

/**
 * 解析某期适用规则。
 * @returns {{found: boolean, ruleVersion: string|null, rule: object|null, reason?: string}}
 */
function resolveRuleVersion(game, issue) {
  if (!isValidIssue(issue)) {
    return { found: false, ruleVersion: null, rule: null, reason: 'INVALID_ISSUE' };
  }
  const candidates = RULE_VERSIONS.filter((r) => r.game === game && r.status === 'active');
  for (const rule of candidates) {
    const afterStart = compareIssue(issue, rule.effectiveFromIssue) >= 0;
    const beforeEnd = !rule.effectiveToIssue || compareIssue(issue, rule.effectiveToIssue) <= 0;
    if (afterStart && beforeEnd) {
      return { found: true, ruleVersion: rule.ruleVersion, rule };
    }
  }
  return {
    found: false,
    ruleVersion: null,
    rule: null,
    reason: 'NO_RULE_VERSION',
  };
}

/** 查询某规则版本的单注奖金；'floating' 表示必须读当期公告 */
function getUnitPrize(rule, key) {
  const table = rule && rule.prizeTable ? rule.prizeTable : {};
  if (!Object.prototype.hasOwnProperty.call(table, key)) return { known: false, value: null };
  const value = table[key];
  if (value === 'floating') return { known: false, value: null, floating: true };
  return { known: true, value };
}

/**
 * 单注价格。仅用于给用户一个"默认建议"，绝不代替用户录入的实际金额。
 * verified 表示该单价已确认（官方规则文本，或产品所有者确认），可作为输入框占位建议。
 */
const UNIT_PRICE = {
  [GAME.SSQ]: { value: 2, verified: true, source: '双色球游戏规则：单式一注 2 元' },
  [GAME.KL8]: { value: 2, verified: true, source: '快乐8 单注 2 元（产品所有者 2026-11-05 确认）' },
};

/**
 * 建议金额。verified=false 时返回 null，避免把未确认的单价伪装成"系统算出来的"。
 * @returns {{value: number|null, verified: boolean, source: string}}
 */
function suggestCost(game, multiple) {
  const unit = UNIT_PRICE[game];
  const m = Number.isInteger(multiple) && multiple > 0 ? multiple : 1;
  if (!unit) return { value: null, verified: false, source: '未知彩种' };
  if (!unit.verified) return { value: null, verified: false, source: unit.source };
  return { value: unit.value * m, verified: true, source: unit.source };
}

module.exports = {
  RULE_VERSIONS,
  SSQ_PRIZE_TABLE,
  KL8_CHOOSE10_PRIZE_TABLE,
  UNIT_PRICE,
  isValidIssue,
  compareIssue,
  resolveRuleVersion,
  getUnitPrize,
  suggestCost,
};
