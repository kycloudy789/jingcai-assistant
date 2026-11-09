/**
 * 判奖引擎（确定性代码，唯一判定入口）。
 *
 * 铁律：
 *   1. 只对 purchaseStatus=confirmed 的号码判奖。
 *   2. 只接受 drawStatus=verified / corrected 的开奖数据。
 *   3. 一/二等奖、快乐8"中 10"必须读当期官方公告金额；缺失即"待公告"，绝不估算。
 *   4. 福运奖状态 unknown 时转人工，不猜。
 *   5. 一注只按最高奖级兑付，福运奖仅覆盖"3 红且未中其他奖级"。
 *
 * 本文件不访问数据库、不读环境变量，纯函数，可被前端与云函数共用。
 */

const { GAME, PURCHASE_STATUS, SPECIAL_RULE_STATUS } = require('../constants/games');
const { resolveRuleVersion, getUnitPrize } = require('./registry');
const { isJudgeableStatus } = require('../validators/draws');

const CHECK_STATUS = {
  CHECKED: 'checked',
  NOT_WINNER: 'not_winner',
  PENDING: 'pending_manual_review',
};

const PENDING_REASON = {
  NO_DRAW: 'NO_DRAW',
  DRAW_NOT_VERIFIED: 'DRAW_NOT_VERIFIED',
  NO_RULE_VERSION: 'NO_RULE_VERSION',
  PRIZE_AMOUNT_PENDING: 'PRIZE_AMOUNT_PENDING',
  PRIZE_INFO_MISSING: 'PRIZE_INFO_MISSING',
  FUYUN_STATUS_UNKNOWN: 'FUYUN_STATUS_UNKNOWN',
  NOT_CONFIRMED: 'NOT_CONFIRMED',
  MISMATCH: 'MISMATCH',
};

function intersect(a, b) {
  const setB = new Set(b || []);
  return (a || []).filter((n) => setB.has(n));
}

function quantityOf(ticket) {
  const q = Number(ticket && ticket.multiple);
  return Number.isInteger(q) && q > 0 ? q : 1;
}

/** 读取当期公告的奖级注数与单注金额；无人中（count=0）视为金额未知 */
function announcedGrade(draw, path) {
  let node = draw && draw.prizeInfo;
  for (const key of path) {
    if (!node || typeof node !== 'object') return { count: null, amount: null };
    node = node[key];
  }
  if (!node || typeof node !== 'object') return { count: null, amount: null };
  const count = typeof node.count === 'number' ? node.count : null;
  const amount = typeof node.amount === 'number' ? node.amount : null;
  if (count === 0) return { count: 0, amount: null };
  return { count, amount };
}

function baseResult(ticket, draw, extra) {
  return {
    ok: true,
    ticketId: ticket._id || ticket.id || null,
    game: ticket.game,
    issue: ticket.issue,
    drawStatus: draw ? draw.drawStatus : null,
    drawRecordId: draw ? draw._id || null : null,
    drawHash: draw ? draw.rawHash || null : null,
    ruleVersion: null,
    hit: null,
    prizeLevel: null,
    unitPrize: null,
    quantity: quantityOf(ticket),
    totalPrize: null,
    checkStatus: CHECK_STATUS.PENDING,
    isWinner: false,
    pendingReason: null,
    promo: null,
    ...extra,
  };
}

function pending(ticket, draw, reason, extra = {}) {
  return baseResult(ticket, draw, {
    checkStatus: CHECK_STATUS.PENDING,
    pendingReason: reason,
    ...extra,
  });
}

/** 票面金额：只有用户录过 actualCost 才知道"单票金额" */
function ticketAmount(ticket) {
  const v = Number(ticket && ticket.actualCost);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 判断这张票是否达到派奖门槛，并算出单注派奖额 */
function resolvePromo(ticket, draw, level) {
  const promo = draw && draw.promo;
  if (!promo) return null;
  const bonus = level === '2' ? promo.secondBonus : level === '6' ? promo.sixthBonus : null;
  if (!bonus || typeof bonus.amount !== 'number' || bonus.amount <= 0) return null;

  const threshold = typeof promo.perTicketAmount === 'number' ? promo.perTicketAmount : null;
  const amount = ticketAmount(ticket);
  const applied = amount !== null && threshold !== null && amount >= threshold;
  return {
    program: promo.program || null,
    label: level === '2' ? '二等奖特别奖' : '六等奖翻番奖',
    threshold,
    extraPerBet: bonus.amount,
    ticketAmount: amount,
    applied,
    reason: applied ? 'APPLIED' : amount === null ? 'TICKET_AMOUNT_UNKNOWN' : 'BELOW_THRESHOLD',
    note: applied
      ? ''
      : amount === null
      ? '未录入票面金额，无法判断是否达到派奖门槛（单票满 20 元才有派奖）'
      : `票面金额 ${amount} 元，未达派奖门槛（单票满 ${threshold} 元）`,
  };
}

/** 双色球判奖
 * @param {object} ticket 号码记录
 * @param {object} draw 开奖记录（已核验）
 * @param {object} rule 规则版本对象
 * @param {string} checkedAt ISO 时间
 */
function judgeSsq(ticket, draw, rule, checkedAt) {
  const red = ticket.numbers.red || [];
  const drawRed = draw.numbers.red || [];
  const matchedRed = intersect(red, drawRed);
  const redHit = matchedRed.length;
  const blueHit = ticket.numbers.blue === draw.numbers.blue;

  let level = null;
  if (redHit === 6 && blueHit) level = '1';
  else if (redHit === 6) level = '2';
  else if (redHit === 5 && blueHit) level = '3';
  else if (redHit === 5 || (redHit === 4 && blueHit)) level = '4';
  else if (redHit === 4 || (redHit === 3 && blueHit)) level = '5';
  else if (blueHit) level = '6';

  const hit = {
    red: redHit,
    blue: blueHit,
    numbers: matchedRed,
    blueNumber: blueHit ? draw.numbers.blue : null,
  };

  // 福运奖：仅当恰好 3 红、未中蓝、且未落入 1–6 等奖
  if (!level && redHit === 3 && !blueHit) {
    const status = draw.specialRuleStatus || SPECIAL_RULE_STATUS.UNKNOWN;
    if (status === SPECIAL_RULE_STATUS.ACTIVE) {
      const special = rule.specialRuleConditions || {};
      const unitPrize = typeof special.prizePerTicket === 'number' ? special.prizePerTicket : null;
      if (unitPrize === null) {
        return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION, {
          ruleVersion: rule.ruleVersion,
          hit,
        });
      }
      const quantity = quantityOf(ticket);
      return baseResult(ticket, draw, {
        ruleVersion: rule.ruleVersion,
        hit,
        prizeLevel: 'fuyun',
        unitPrize,
        quantity,
        totalPrize: unitPrize * quantity,
        checkStatus: CHECK_STATUS.CHECKED,
        isWinner: true,
        checkedAt,
      });
    }
    if (status === SPECIAL_RULE_STATUS.INACTIVE || status === SPECIAL_RULE_STATUS.NOT_APPLICABLE) {
      return baseResult(ticket, draw, {
        ruleVersion: rule.ruleVersion,
        hit,
        checkStatus: CHECK_STATUS.NOT_WINNER,
        checkedAt,
      });
    }
    return pending(ticket, draw, PENDING_REASON.FUYUN_STATUS_UNKNOWN, {
      ruleVersion: rule.ruleVersion,
      hit,
    });
  }

  if (!level) {
    return baseResult(ticket, draw, {
      ruleVersion: rule.ruleVersion,
      hit,
      checkStatus: CHECK_STATUS.NOT_WINNER,
      checkedAt,
    });
  }

  // 一/二等奖为浮动奖，必须读当期公告
  if (level === '1' || level === '2') {
    const path = level === '1' ? ['first'] : ['second'];
    const grade = announcedGrade(draw, path);
    if (grade.amount === null) {
      return pending(ticket, draw, PENDING_REASON.PRIZE_AMOUNT_PENDING, {
        ruleVersion: rule.ruleVersion,
        hit,
        prizeLevel: level,
      });
    }
    const quantity = quantityOf(ticket);
    const promo = level === '2' ? resolvePromo(ticket, draw, level) : null;
    const unit = grade.amount + (promo && promo.applied ? promo.extraPerBet : 0);
    return baseResult(ticket, draw, {
      ruleVersion: rule.ruleVersion,
      hit,
      prizeLevel: level,
      unitPrize: unit,
      quantity,
      totalPrize: unit * quantity,
      promo,
      checkStatus: CHECK_STATUS.CHECKED,
      isWinner: true,
      checkedAt,
    });
  }

  const fixed = getUnitPrize(rule, level);
  if (!fixed.known) {
    return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION, {
      ruleVersion: rule.ruleVersion,
      hit,
      prizeLevel: level,
    });
  }
  const quantity = quantityOf(ticket);
  const promo = resolvePromo(ticket, draw, level);
  const unit = fixed.value + (promo && promo.applied ? promo.extraPerBet : 0);
  return baseResult(ticket, draw, {
    ruleVersion: rule.ruleVersion,
    hit,
    prizeLevel: level,
    unitPrize: unit,
    quantity,
    totalPrize: unit * quantity,
    promo,
    checkStatus: CHECK_STATUS.CHECKED,
    isWinner: true,
    checkedAt,
  });
}

/** 快乐8选十判奖 */
function judgeKl8(ticket, draw, rule, checkedAt) {
  const picked = ticket.numbers.kl8 || [];
  const drawNumbers = draw.numbers.kl8 || [];
  const matched = intersect(picked, drawNumbers);
  const hitCount = matched.length;
  const hit = { count: hitCount, numbers: matched };
  const quantity = quantityOf(ticket);

  if (hitCount === 10) {
    const grade = announcedGrade(draw, ['choose10', 'hit10']);
    if (grade.amount === null) {
      return pending(ticket, draw, PENDING_REASON.PRIZE_AMOUNT_PENDING, {
        ruleVersion: rule.ruleVersion,
        hit,
        prizeLevel: '10',
      });
    }
    return baseResult(ticket, draw, {
      ruleVersion: rule.ruleVersion,
      hit,
      prizeLevel: '10',
      unitPrize: grade.amount,
      quantity,
      totalPrize: grade.amount * quantity,
      checkStatus: CHECK_STATUS.CHECKED,
      isWinner: true,
      checkedAt,
    });
  }

  const fixed = getUnitPrize(rule, String(hitCount));
  if (!fixed.known) {
    // 1–4 命中：规则表里没有该奖级，属于"不中奖"，不是缺规则
    if ([1, 2, 3, 4].includes(hitCount)) {
      return baseResult(ticket, draw, {
        ruleVersion: rule.ruleVersion,
        hit,
        checkStatus: CHECK_STATUS.NOT_WINNER,
        checkedAt,
      });
    }
    return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION, {
      ruleVersion: rule.ruleVersion,
      hit,
    });
  }

  return baseResult(ticket, draw, {
    ruleVersion: rule.ruleVersion,
    hit,
    prizeLevel: String(hitCount),
    unitPrize: fixed.value,
    quantity,
    totalPrize: fixed.value * quantity,
    checkStatus: CHECK_STATUS.CHECKED,
    isWinner: true,
    checkedAt,
  });
}

/**
 * 统一入口
 * @param {object} ticket 号码记录（须 confirmed）
 * @param {object|null} draw 对应期开奖记录
 * @param {{checkedAt?: string}} options
 */
function judgeTicket(ticket, draw, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();

  if (!ticket || ticket.purchaseStatus !== PURCHASE_STATUS.CONFIRMED) {
    return {
      ok: false,
      code: PENDING_REASON.NOT_CONFIRMED,
      message: '只有「已确认购买」的号码才参与判奖',
    };
  }
  if (!draw) return pending(ticket, null, PENDING_REASON.NO_DRAW);
  if (!isJudgeableStatus(draw.drawStatus)) {
    return pending(ticket, draw, PENDING_REASON.DRAW_NOT_VERIFIED);
  }
  if (draw.game !== ticket.game || draw.issue !== ticket.issue) {
    return pending(ticket, draw, PENDING_REASON.MISMATCH);
  }

  const rule = resolveRuleVersion(ticket.game, ticket.issue);
  if (!rule.found) {
    return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION);
  }

  if (ticket.game === GAME.SSQ) return judgeSsq(ticket, draw, rule.rule, checkedAt);
  if (ticket.game === GAME.KL8) return judgeKl8(ticket, draw, rule.rule, checkedAt);
  return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION);
}

/** 批量：draws 以 `${game}:${issue}` 为键 */
function judgeMany(tickets, drawMap, options = {}) {
  const results = [];
  for (const ticket of tickets || []) {
    const key = `${ticket.game}:${ticket.issue}`;
    results.push(judgeTicket(ticket, (drawMap && drawMap[key]) || null, options));
  }
  return results;
}

/** 幂等键：同一张票 + 同一份开奖 + 同一版规则 + 同一份原始数据 → 同一次核对 */
function checkIdempotencyKey(ticket, draw, ruleVersion) {
  return [
    ticket._id || ticket.id || 'no-ticket',
    draw && (draw._id || 'no-draw'),
    ruleVersion || 'no-rule',
    (draw && draw.rawHash) || 'no-hash',
  ].join('|');
}

module.exports = {
  CHECK_STATUS,
  resolvePromo,
  PENDING_REASON,
  judgeTicket,
  judgeMany,
  checkIdempotencyKey,
  announcedGrade,
  intersect,
};
