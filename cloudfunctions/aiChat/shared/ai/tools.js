/**
 * AI 工具白名单（只读）。
 *
 * 设计约束（对应主方案 13.3）：
 *   - 只有查询能力：查开奖、查我的记录、查统计、查规则、查核对结果。
 *   - 不接受模型传入用户标识：ownerOpenId 一律由服务端从运行上下文注入。
 *   - 参数全部做白名单式校验，越界直接拒绝，不"尽量理解"。
 *   - 不提供任何写库、删库、改奖级、改开奖数据的能力。
 */

const { GAME, PURCHASE_STATUS } = require('../constants/games');
const { isValidIssue } = require('../rules/registry');

const TOOL_NAMES = [
  'get_latest_draw',
  'get_draws',
  'get_my_tickets',
  'get_my_ticket_stats',
  'get_number_stats',
  'get_ticket_check',
  'get_rule_info',
];

const CODE = {
  OK: 'OK',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  BAD_ARGS: 'BAD_ARGS',
};

const GAMES = [GAME.SSQ, GAME.KL8];
const WINDOWS = [30, 50, 100];

function clampLimit(value, fallback = 5, max = 20) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), 1), max);
}

function requireGame(raw) {
  if (!GAMES.includes(raw.game)) {
    return { ok: false, message: 'game 必须是 ssq 或 kl8' };
  }
  return { ok: true, game: raw.game };
}

const TOOLS = {
  get_latest_draw: {
    description: '查询指定彩种最新一期「已核验」的开奖结果，含号码、各奖级注数与单注金额、来源与核验时间。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES, description: 'ssq=双色球；kl8=快乐8' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      return { ok: true, args: { game: g.game } };
    },
  },

  get_draws: {
    description: '按期号或最近期数查询已核验的开奖记录（最多 20 期），用于对比或复盘。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        issue: { type: 'string', description: '7 位期号，例如 2026126' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回期数，默认 5' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      const args = { game: g.game, limit: clampLimit(raw.limit, 5) };
      if (raw.issue !== undefined && raw.issue !== null && raw.issue !== '') {
        const issue = String(raw.issue);
        if (!isValidIssue(issue)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'issue 必须是 7 位数字期号' };
        }
        args.issue = issue;
      }
      return { ok: true, args };
    },
  },

  get_my_tickets: {
    description: '查询当前用户本人的号码记录（草稿/已购买/已作废），可按彩种与状态过滤。用户身份由服务端注入，不得传入。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        status: { type: 'string', enum: Object.values(PURCHASE_STATUS) },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '默认 10' },
      },
      required: [],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      const args = { limit: clampLimit(src.limit, 10) };
      if (src.game !== undefined && src.game !== null && src.game !== '') {
        if (!GAMES.includes(src.game)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'game 必须是 ssq 或 kl8' };
        }
        args.game = src.game;
      }
      if (src.status !== undefined && src.status !== null && src.status !== '') {
        if (!Object.values(PURCHASE_STATUS).includes(src.status)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'status 必须是 draft/confirmed/void' };
        }
        args.status = src.status;
      }
      return { ok: true, args };
    },
  },

  get_my_ticket_stats: {
    description: '汇总当前用户本人的号码记录：各状态数量、已购买注数、录入金额合计、中奖笔数与奖金合计（奖金来自核对结果）。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
      },
      required: [],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      if (src.game !== undefined && src.game !== null && src.game !== '') {
        if (!GAMES.includes(src.game)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'game 必须是 ssq 或 kl8' };
        }
        return { ok: true, args: { game: src.game } };
      }
      return { ok: true, args: {} };
    },
  },

  get_number_stats: {
    description: '按最近 N 期已核验开奖统计号码出现频次与当前遗漏期数。这是描述性统计，不代表未来倾向。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        window: { type: 'integer', enum: WINDOWS, description: '统计窗口（期数），默认 30' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      let window = 30;
      if (raw.window !== undefined) {
        const w = Number(raw.window);
        if (!WINDOWS.includes(w)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'window 只能是 30 / 50 / 100' };
        }
        window = w;
      }
      return { ok: true, args: { game: g.game, window } };
    },
  },

  get_ticket_check: {
    description: '查询某条个人号码记录的核对结果（命中号码、奖级、单注与总奖金、是否待人工核验）。',
    parameters: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: '记录 ID' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      if (typeof src.ticketId !== 'string' || !src.ticketId || src.ticketId.length > 64) {
        return { ok: false, code: CODE.BAD_ARGS, message: 'ticketId 不合法' };
      }
      return { ok: true, args: { ticketId: src.ticketId } };
    },
  },

  get_rule_info: {
    description: '查询某彩种某期适用的规则版本、奖级表与来源（用于解释规则变化，例如快乐8 新旧规则奖金差异）。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        issue: { type: 'string', description: '7 位期号；不传则返回当前生效版本' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      const args = { game: g.game };
      if (raw.issue !== undefined && raw.issue !== null && raw.issue !== '') {
        const issue = String(raw.issue);
        if (!isValidIssue(issue)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'issue 必须是 7 位数字期号' };
        }
        args.issue = issue;
      }
      return { ok: true, args };
    },
  },
};

/** 发给模型的 function schema 列表（不含 validate） */
function getToolSchemas() {
  return TOOL_NAMES.map((name) => ({
    type: 'function',
    function: {
      name,
      description: TOOLS[name].description,
      parameters: TOOLS[name].parameters,
    },
  }));
}

/** 校验工具名与参数；拒绝一切未列入白名单的调用 */
function validateToolCall(name, rawArgs) {
  if (!TOOL_NAMES.includes(name)) {
    return { ok: false, code: CODE.UNKNOWN_TOOL, message: `工具 ${name} 不在允许列表内` };
  }
  let parsed = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (err) {
      return { ok: false, code: CODE.BAD_ARGS, message: '工具参数不是合法 JSON' };
    }
  }
  return TOOLS[name].validate(parsed || {});
}

module.exports = { TOOL_NAMES, CODE, TOOLS, getToolSchemas, validateToolCall };
