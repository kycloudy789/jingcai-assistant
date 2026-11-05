/**
 * 开奖记录校验（主方案 9.4）。
 * 只有通过本校验的记录才允许进入 verified 状态，进而在阶段 4 参与判奖。
 */

const { GAME, GAME_META, DRAW_STATUS } = require('../constants/games');
const { validateSsq, validateKl8 } = require('./numbers');
const { isValidIssue } = require('../rules/registry');

const CODE = {
  OK: 'OK',
  GAME_UNSUPPORTED: 'GAME_UNSUPPORTED',
  ISSUE_INVALID: 'ISSUE_INVALID',
  DATE_INVALID: 'DATE_INVALID',
  DATE_FUTURE: 'DATE_FUTURE',
  NUMBERS_INVALID: 'NUMBERS_INVALID',
  AMOUNT_INVALID: 'AMOUNT_INVALID',
  STATUS_INVALID: 'STATUS_INVALID',
};

const ALLOWED_STATUS = new Set(Object.values(DRAW_STATUS));

/** "2026-11-03" → Date（按 Asia/Shanghai 零点） */
function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const dt = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(dt.getTime())) return null;
  const back = new Date(dt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return back === value ? dt : null;
}

function isMoneyOrNull(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {object} record 规范记录
 * @param {{now?: Date, allowFutureDays?: number}} options
 */
function validateDrawRecord(record, options = {}) {
  if (!record || typeof record !== 'object') {
    return { ok: false, code: CODE.ISSUE_INVALID, message: '记录为空' };
  }
  const { game } = record;
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '不支持的彩种' };
  }
  if (!isValidIssue(record.issue)) {
    return { ok: false, code: CODE.ISSUE_INVALID, message: `期号不合法: ${record.issue}` };
  }

  const date = parseIsoDate(record.drawDate);
  if (!date) {
    return { ok: false, code: CODE.DATE_INVALID, message: `开奖日期不合法: ${record.drawDate}` };
  }
  const now = options.now || new Date();
  const allowFutureDays = options.allowFutureDays === undefined ? 1 : options.allowFutureDays;
  if (date.getTime() > now.getTime() + allowFutureDays * 86400000) {
    return { ok: false, code: CODE.DATE_FUTURE, message: '开奖日期晚于当前时间，疑似脏数据' };
  }

  const numbers = record.numbers || {};
  const numberCheck =
    game === GAME.SSQ
      ? validateSsq(numbers.red, numbers.blue)
      : validateKl8(numbers.kl8, { asDraw: true });

  // 快乐8 用 kl8 字段；双色球若误把号码塞进 kl8 也应被拒
  if (!numberCheck.ok) {
    return { ok: false, code: CODE.NUMBERS_INVALID, message: numberCheck.message };
  }

  if (record.drawStatus && !ALLOWED_STATUS.has(record.drawStatus)) {
    return { ok: false, code: CODE.STATUS_INVALID, message: `未知状态: ${record.drawStatus}` };
  }

  const moneyFields = ['salesAmount', 'poolAmount', 'fixedPoolAmount'];
  for (const field of moneyFields) {
    if (!isMoneyOrNull(record[field])) {
      return { ok: false, code: CODE.AMOUNT_INVALID, message: `${field} 金额不合法` };
    }
  }

  return { ok: true, code: CODE.OK, normalized: { ...record, numbers: numberCheck.normalized } };
}

/** 期号前 4 位即年份，用于列表筛选 */
function issueYear(issue) {
  return isValidIssue(issue) ? issue.slice(0, 4) : null;
}

/** 只有 verified / corrected 可参与判奖（parsed 只是解析成功） */
function isJudgeableStatus(status) {
  return status === DRAW_STATUS.VERIFIED || status === DRAW_STATUS.CORRECTED;
}

module.exports = {
  CODE,
  validateDrawRecord,
  parseIsoDate,
  issueYear,
  isJudgeableStatus,
  GAME_META,
};
