/**
 * 号码记录域模型（前后端共用）。
 *
 * 核心不变量：
 *   1. 候选/草稿 ≠ 已购买。只有 draft → confirmed 的显式动作才算"买了"。
 *   2. confirmed 之后号码冻结：只能改备注/金额/倍数，改号必须作废重建（保留痕迹）。
 *   3. 只有 confirmed 参与真实投入统计与判奖（见 isEligibleForPrize / isCountedInStats）。
 */

const { GAME, GAME_META, PURCHASE_STATUS, isGame } = require('../constants/games');
const { validateNumbers, combinationKey, formatDisplay } = require('../validators/numbers');
const { isValidIssue } = require('../rules/registry');

const CODE = {
  OK: 'OK',
  GAME_UNSUPPORTED: 'GAME_UNSUPPORTED',
  ISSUE_INVALID: 'ISSUE_INVALID',
  NUMBERS_INVALID: 'NUMBERS_INVALID',
  MULTIPLE_INVALID: 'MULTIPLE_INVALID',
  COST_INVALID: 'COST_INVALID',
  NOTE_TOO_LONG: 'NOTE_TOO_LONG',
  PURCHASE_AT_INVALID: 'PURCHASE_AT_INVALID',
  IDEMPOTENCY_INVALID: 'IDEMPOTENCY_INVALID',
  STATUS_INVALID: 'STATUS_INVALID',
  TRANSITION_NOT_ALLOWED: 'TRANSITION_NOT_ALLOWED',
  NUMBER_FROZEN: 'NUMBER_FROZEN',
  FIELD_NOT_EDITABLE: 'FIELD_NOT_EDITABLE',
  DELETE_NOT_ALLOWED: 'DELETE_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
};

const MAX_MULTIPLE = 99;
const MAX_COST = 1000000;
const MAX_NOTE_LENGTH = 200;

/** draft 可改字段；confirmed 只允许这些非号码字段；void 只读 */
const EDITABLE_FIELDS = {
  draft: ['game', 'issue', 'numbers', 'multiple', 'actualCost', 'note', 'recordSource', 'candidateId'],
  confirmed: ['note', 'actualCost', 'multiple'],
  void: [],
};

function isIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const dt = new Date(value);
  return !Number.isNaN(dt.getTime());
}

function validateMultiple(value) {
  if (value === undefined || value === null) return { ok: true, value: 1 };
  if (!Number.isInteger(value) || value < 1 || value > MAX_MULTIPLE) {
    return { ok: false, code: CODE.MULTIPLE_INVALID, message: `倍数需为 1–${MAX_MULTIPLE} 的整数` };
  }
  return { ok: true, value };
}

function validateCost(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > MAX_COST) {
    return { ok: false, code: CODE.COST_INVALID, message: `金额需在 0–${MAX_COST} 元之间` };
  }
  return { ok: true, value: Math.round(num * 100) / 100 };
}

function validateNote(value) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  const text = String(value);
  if (text.length > MAX_NOTE_LENGTH) {
    return { ok: false, code: CODE.NOTE_TOO_LONG, message: `备注最多 ${MAX_NOTE_LENGTH} 字` };
  }
  return { ok: true, value: text };
}

/** 购买时间：允许过去，允许当天，不允许晚于当前 +1 天（防手误年份） */
function validatePurchaseAt(value, now) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (!isIsoDateTime(value)) {
    return { ok: false, code: CODE.PURCHASE_AT_INVALID, message: '购买时间格式不正确' };
  }
  const dt = new Date(value);
  const limit = (now || new Date()).getTime() + 86400000;
  if (dt.getTime() > limit) {
    return { ok: false, code: CODE.PURCHASE_AT_INVALID, message: '购买时间不能晚于当前时间' };
  }
  return { ok: true, value: dt.toISOString() };
}

/**
 * 构造草稿记录（尚未确认购买）。
 * @param {object} input {game, issue, numbers, recordSource, candidateId, note, multiple, actualCost, idempotencyKey}
 * @param {{ownerOpenId?: string, now?: Date}} ctx
 */
function buildTicketDraft(input, ctx = {}) {
  const payload = input || {};
  const { game } = payload;

  if (!isGame(game)) {
    return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '只支持双色球与快乐8选十' };
  }
  if (!isValidIssue(payload.issue)) {
    return { ok: false, code: CODE.ISSUE_INVALID, message: '期号需为 7 位数字，如 2026127' };
  }

  const numbers = validateNumbers(game, payload.numbers || {});
  if (!numbers.ok) {
    return { ok: false, code: CODE.NUMBERS_INVALID, message: numbers.message };
  }

  const multiple = validateMultiple(payload.multiple);
  if (!multiple.ok) return multiple;

  const cost = validateCost(payload.actualCost);
  if (!cost.ok) return cost;

  const note = validateNote(payload.note);
  if (!note.ok) return note;

  const key = payload.idempotencyKey;
  if (key !== undefined && key !== null && (typeof key !== 'string' || key.length > 64)) {
    return { ok: false, code: CODE.IDEMPOTENCY_INVALID, message: '幂等键不合法' };
  }

  const now = ctx.now || new Date();
  const meta = GAME_META[game];

  return {
    ok: true,
    code: CODE.OK,
    record: {
      ownerOpenId: ctx.ownerOpenId || null,
      game,
      playType: meta.playType,
      issue: payload.issue,
      numbers: numbers.normalized,
      displayText: formatDisplay(game, numbers.normalized),
      numberKey: combinationKey(game, numbers.normalized),
      recordSource: payload.recordSource === 'candidate_import' ? 'candidate_import' : 'manual',
      candidateId: payload.candidateId || null,
      purchaseStatus: PURCHASE_STATUS.DRAFT,
      purchaseAt: null,
      actualCost: cost.value,
      multiple: multiple.value,
      note: note.value,
      idempotencyKey: key || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: null,
      voidedAt: null,
    },
  };
}

function getAllowedFields(status) {
  return EDITABLE_FIELDS[status] || [];
}

/**
 * 编辑草稿/已购买记录。
 * 已购买记录的号码字段一律拒绝（NUMBER_FROZEN），必须作废后重建。
 */
function applyPatch(ticket, patch, ctx = {}) {
  if (!ticket || !ticket.purchaseStatus) {
    return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  }
  const status = ticket.purchaseStatus;
  const allowed = getAllowedFields(status);

  if (status === PURCHASE_STATUS.VOID) {
    return { ok: false, code: CODE.FIELD_NOT_EDITABLE, message: '已作废记录不可编辑' };
  }

  const incoming = patch || {};
  const keys = Object.keys(incoming).filter((k) => incoming[k] !== undefined);
  if (keys.length === 0) {
    return { ok: false, code: CODE.FIELD_NOT_EDITABLE, message: '没有需要修改的内容' };
  }

  const blockedNumbers = ['numbers', 'game', 'issue', 'numberKey'].filter((k) => keys.includes(k));
  if (blockedNumbers.length && status === PURCHASE_STATUS.CONFIRMED) {
    return {
      ok: false,
      code: CODE.NUMBER_FROZEN,
      message: '已确认购买的记录不能修改号码或期号；如需更正请先作废再新建',
    };
  }

  const forbidden = keys.filter((k) => !allowed.includes(k));
  if (forbidden.length) {
    return {
      ok: false,
      code: CODE.FIELD_NOT_EDITABLE,
      message: `以下字段不可修改：${forbidden.join(', ')}`,
    };
  }

  const update = {};

  if (keys.includes('game') || keys.includes('issue') || keys.includes('numbers')) {
    const nextGame = incoming.game || ticket.game;
    const nextIssue = incoming.issue || ticket.issue;
    if (!isGame(nextGame)) {
      return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '不支持的彩种' };
    }
    if (!isValidIssue(nextIssue)) {
      return { ok: false, code: CODE.ISSUE_INVALID, message: '期号需为 7 位数字' };
    }
    const numbers = validateNumbers(nextGame, incoming.numbers || ticket.numbers);
    if (!numbers.ok) {
      return { ok: false, code: CODE.NUMBERS_INVALID, message: numbers.message };
    }
    update.game = nextGame;
    update.issue = nextIssue;
    update.playType = GAME_META[nextGame].playType;
    update.numbers = numbers.normalized;
    update.displayText = formatDisplay(nextGame, numbers.normalized);
    update.numberKey = combinationKey(nextGame, numbers.normalized);
  }

  if (keys.includes('multiple')) {
    const m = validateMultiple(incoming.multiple);
    if (!m.ok) return m;
    update.multiple = m.value;
  }
  if (keys.includes('actualCost')) {
    const c = validateCost(incoming.actualCost);
    if (!c.ok) return c;
    update.actualCost = c.value;
  }
  if (keys.includes('note')) {
    const n = validateNote(incoming.note);
    if (!n.ok) return n;
    update.note = n.value;
  }
  if (keys.includes('recordSource')) {
    update.recordSource = incoming.recordSource === 'candidate_import' ? 'candidate_import' : 'manual';
  }
  if (keys.includes('candidateId')) {
    update.candidateId = incoming.candidateId || null;
  }

  update.updatedAt = (ctx.now || new Date()).toISOString();
  return { ok: true, code: CODE.OK, update };
}

/**
 * 确认已购买：draft → confirmed。
 * 必须显式提供实际金额（可为 0，如赠票），避免用"推算金额"污染统计。
 */
function confirmPurchase(ticket, payload, ctx = {}) {
  if (!ticket || !ticket.purchaseStatus) {
    return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  }
  if (ticket.purchaseStatus !== PURCHASE_STATUS.DRAFT) {
    return {
      ok: false,
      code: CODE.TRANSITION_NOT_ALLOWED,
      message: `当前状态 ${ticket.purchaseStatus} 不能执行"确认已购买"`,
    };
  }

  const input = payload || {};
  const now = ctx.now || new Date();

  const cost = validateCost(input.actualCost);
  if (!cost.ok) return cost;
  if (cost.value === null) {
    return { ok: false, code: CODE.COST_INVALID, message: '请填写实际支付金额（赠送票可填 0）' };
  }

  const multiple = validateMultiple(input.multiple === undefined ? ticket.multiple : input.multiple);
  if (!multiple.ok) return multiple;

  const purchaseAt = validatePurchaseAt(input.purchaseAt, now);
  if (!purchaseAt.ok) return purchaseAt;

  const note = input.note === undefined ? { ok: true, value: ticket.note } : validateNote(input.note);
  if (!note.ok) return note;

  return {
    ok: true,
    code: CODE.OK,
    update: {
      purchaseStatus: PURCHASE_STATUS.CONFIRMED,
      purchaseAt: purchaseAt.value || now.toISOString(),
      actualCost: cost.value,
      multiple: multiple.value,
      note: note.value,
      confirmedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
}

/** 作废：draft / confirmed → void。已核对结果（阶段 4）不受影响，但会从统计中剔除 */
function voidTicket(ticket, payload, ctx = {}) {
  if (!ticket || !ticket.purchaseStatus) {
    return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  }
  if (ticket.purchaseStatus === PURCHASE_STATUS.VOID) {
    return { ok: false, code: CODE.TRANSITION_NOT_ALLOWED, message: '该记录已作废' };
  }
  const reason = validateNote((payload || {}).reason);
  if (!reason.ok) return reason;
  const now = ctx.now || new Date();

  return {
    ok: true,
    code: CODE.OK,
    update: {
      purchaseStatus: PURCHASE_STATUS.VOID,
      voidedAt: now.toISOString(),
      voidReason: reason.value || '',
      updatedAt: now.toISOString(),
    },
  };
}

/** 只有草稿与已作废可物理删除；已确认购买必须先作废（主方案 14.4） */
function canDeleteTicket(ticket) {
  if (!ticket) return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  if (ticket.purchaseStatus === PURCHASE_STATUS.CONFIRMED) {
    return {
      ok: false,
      code: CODE.DELETE_NOT_ALLOWED,
      message: '已确认购买的记录请先作废再删除，以免历史统计无痕变化',
    };
  }
  return { ok: true, code: CODE.OK };
}

/** 判奖准入：仅 confirmed */
function isEligibleForPrize(ticket) {
  return Boolean(ticket) && ticket.purchaseStatus === PURCHASE_STATUS.CONFIRMED;
}

/** 统计准入：仅 confirmed（void 与 draft 都不计入真实投入/中奖） */
function isCountedInStats(ticket) {
  return Boolean(ticket) && ticket.purchaseStatus === PURCHASE_STATUS.CONFIRMED;
}

/** 列表分组计数 */
function summarize(list) {
  const acc = { draft: 0, confirmed: 0, void: 0, total: 0 };
  for (const t of list || []) {
    acc.total += 1;
    if (acc[t.purchaseStatus] !== undefined) acc[t.purchaseStatus] += 1;
  }
  return acc;
}

module.exports = {
  CODE,
  MAX_MULTIPLE,
  MAX_COST,
  MAX_NOTE_LENGTH,
  EDITABLE_FIELDS,
  buildTicketDraft,
  applyPatch,
  confirmPurchase,
  voidTicket,
  canDeleteTicket,
  isEligibleForPrize,
  isCountedInStats,
  summarize,
  validateMultiple,
  validateCost,
  validateNote,
  validatePurchaseAt,
};
