/**
 * AI 工具执行器（仅云端）。
 *
 * 铁律：ownerOpenId 只从运行上下文来，任何工具参数都不能指定用户。
 * 返回结构统一为 { ok, ... }，ok:false 表示业务上无法回答（找不到/未核验/未开放），
 * 由模型向用户如实说明，而不是编造。
 */

const { GAME, GAME_META, PURCHASE_STATUS } = require('../constants/games');
const { resolveRuleVersion } = require('../rules/registry');
const { validateToolCall } = require('../ai/tools');

const DRAWS = 'draw_records';
const TICKETS = 'ticket_records';
const CHECKS = 'ticket_checks';
const LOGS = 'sync_logs';

const JUDGEABLE = ['verified', 'corrected'];

function stripPrivate(row) {
  const { ownerOpenId, ...rest } = row;
  return rest;
}

function summaryOfDraw(d) {
  return {
    issue: d.issue,
    drawDate: d.drawDate,
    numbers: d.numbers,
    prizeInfo: d.prizeInfo,
    specialRuleStatus: d.specialRuleStatus,
    drawStatus: d.drawStatus,
    sourceUrl: d.sourceUrl,
    verifiedAt: d.verifiedAt,
    ruleVersion: d.ruleVersion,
  };
}

async function latestSync(db) {
  try {
    const res = await db.collection(LOGS).orderBy('createdAt', 'desc').limit(1).get();
    const log = (res.data && res.data[0]) || null;
    if (!log) return null;
    return { finishedAt: log.finishedAt || log.createdAt, status: log.status, game: log.game };
  } catch (err) {
    return null;
  }
}

function createExecutors({ db, openid, now = () => new Date() }) {
  const draws = db.collection(DRAWS);
  const tickets = db.collection(TICKETS);
  const checks = db.collection(CHECKS);

  async function findDraw(game, issue) {
    const res = await draws.where({ game, issue }).limit(1).get();
    return (res.data && res.data[0]) || null;
  }

  async function recentDraws(game, want) {
    // 多取一些再过滤状态，避免依赖 _.in
    const res = await draws.where({ game }).orderBy('issue', 'desc').limit(want * 3).get();
    return (res.data || []).filter((d) => JUDGEABLE.includes(d.drawStatus)).slice(0, want);
  }

  const handlers = {
    async get_latest_draw(args) {
      const list = await recentDraws(args.game, 1);
      const sync = await latestSync(db);
      if (!list.length) {
        return {
          ok: false,
          code: 'NO_VERIFIED_DRAW',
          message: '本地暂无该彩种的已核验开奖数据',
          lastSync: sync,
          hint: '可让用户在「开奖」页点击「同步最新」，或使用 CSV 导入。',
        };
      }
      return { ok: true, game: args.game, draw: summaryOfDraw(list[0]), lastSync: sync };
    },

    async get_draws(args) {
      if (args.issue) {
        const one = await findDraw(args.game, args.issue);
        if (!one || !JUDGEABLE.includes(one.drawStatus)) {
          return {
            ok: false,
            code: 'NOT_FOUND',
            message: `本地没有 ${args.game} 第 ${args.issue} 期的已核验数据`,
          };
        }
        return { ok: true, game: args.game, count: 1, draws: [summaryOfDraw(one)] };
      }
      const list = await recentDraws(args.game, args.limit || 5);
      if (!list.length) {
        return { ok: false, code: 'NO_VERIFIED_DRAW', message: '本地暂无该彩种的已核验开奖数据' };
      }
      return { ok: true, game: args.game, count: list.length, draws: list.map(summaryOfDraw) };
    },

    async get_my_tickets(args) {
      const where = { ownerOpenId: openid };
      if (args.game) where.game = args.game;
      if (args.status) where.purchaseStatus = args.status;

      const res = await tickets.where(where).orderBy('createdAt', 'desc').limit(args.limit || 10).get();
      const rows = res.data || [];
      const countRes = await tickets.where(where).count();

      return {
        ok: true,
        total: countRes.total || 0,
        returned: rows.length,
        filter: { game: args.game || 'all', status: args.status || 'all' },
        tickets: rows.map((t) => ({
          id: t._id,
          game: t.game,
          issue: t.issue,
          displayText: t.displayText,
          purchaseStatus: t.purchaseStatus,
          actualCost: t.actualCost === undefined ? null : t.actualCost,
          multiple: t.multiple,
          checkSummary: t.checkSummary || null,
          createdAt: t.createdAt,
        })),
        note: rows.length < (countRes.total || 0) ? '仅返回最近若干条，未列出全部' : '已列出全部匹配记录',
      };
    },

    async get_my_ticket_stats(args) {
      const scope = { ownerOpenId: openid };
      if (args.game) scope.game = args.game;

      const counts = {};
      for (const status of Object.values(PURCHASE_STATUS)) {
        const res = await tickets.where({ ...scope, purchaseStatus: status }).count();
        counts[status] = res.total || 0;
      }

      const confirmedRes = await tickets
        .where({ ...scope, purchaseStatus: PURCHASE_STATUS.CONFIRMED })
        .limit(500)
        .get();
      const confirmed = confirmedRes.data || [];

      let totalCost = 0;
      let missingCost = 0;
      for (const t of confirmed) {
        if (typeof t.actualCost === 'number') totalCost += t.actualCost;
        else missingCost += 1;
      }

      // 奖金只认核对结果，不读 checkSummary 的金额做统计口径（D16）
      const checkRes = await checks.where(scope).limit(500).get();
      const checkRows = checkRes.data || [];
      const latestByTicket = new Map();
      for (const c of checkRows) {
        const prev = latestByTicket.get(c.ticketId);
        if (!prev || String(c.checkedAt) > String(prev.checkedAt)) latestByTicket.set(c.ticketId, c);
      }

      const confirmedIds = new Set(confirmed.map((t) => t._id));
      let winners = 0;
      let totalPrize = 0;
      let pendingReview = 0;
      let recordsWithCheck = 0;

      for (const [ticketId, c] of latestByTicket) {
        if (!confirmedIds.has(ticketId)) continue;
        recordsWithCheck += 1;
        if (c.checkStatus === 'pending_manual_review') pendingReview += 1;
        if (c.isWinner) {
          winners += 1;
          if (typeof c.totalPrize === 'number') totalPrize += c.totalPrize;
        }
      }

      return {
        ok: true,
        scope: { game: args.game || 'all' },
        counts,
        purchased: {
          tickets: counts.confirmed,
          totalCost,
          missingCostTickets: missingCost,
          costNote:
            missingCost > 0
              ? `有 ${missingCost} 张已购买记录未填写实际金额，合计金额仅统计已填写的部分`
              : '金额为用户录入的实际支付额',
        },
        winnings: {
          recordsWithCheck,
          winners,
          totalPrize,
          pendingReview,
          prizeNote: '奖金来自核对结果；待人工核验或待官方公告的金额未计入合计',
        },
      };
    },

    async get_number_stats(args) {
      const window = args.window || 30;
      const list = await recentDraws(args.game, window);
      if (!list.length) {
        return { ok: false, code: 'NO_VERIFIED_DRAW', message: '本地暂无已核验开奖数据，无法统计' };
      }

      const meta = GAME_META[args.game];
      const isSsq = args.game === GAME.SSQ;
      const pick = (d) => (isSsq ? { red: d.numbers.red || [], blue: [d.numbers.blue] } : { red: d.numbers.kl8 || [], blue: [] });

      // list 已按 issue 降序
      const appearRed = new Map();
      const appearBlue = new Map();
      const omissionRed = new Map();
      const omissionBlue = new Map();

      list.forEach((d, idx) => {
        const picked = pick(d);
        for (const n of picked.red) {
          appearRed.set(n, (appearRed.get(n) || 0) + 1);
          if (!omissionRed.has(n)) omissionRed.set(n, idx);
        }
        for (const n of picked.blue) {
          if (!n) continue;
          appearBlue.set(n, (appearBlue.get(n) || 0) + 1);
          if (!omissionBlue.has(n)) omissionBlue.set(n, idx);
        }
      });

      const maxRed = isSsq ? meta.redMax : meta.max;
      const build = (max, appear, omission) => {
        const out = [];
        for (let n = 1; n <= max; n += 1) {
          out.push({
            number: n,
            count: appear.get(n) || 0,
            omission: omission.has(n) ? omission.get(n) : list.length,
          });
        }
        return out;
      };

      const result = {
        ok: true,
        game: args.game,
        window,
        sampleSize: list.length,
        issueRange: { from: list[list.length - 1].issue, to: list[0].issue },
        red: isSsq ? build(33, appearRed, omissionRed) : undefined,
        blue: isSsq ? build(16, appearBlue, omissionBlue) : undefined,
        kl8: isSsq ? undefined : build(80, appearRed, omissionRed),
        definitions: {
          count: '在统计窗口内出现的期数',
          omission: '自最近一次出现后连续未出现的期数；窗口内从未出现记为窗口长度',
        },
        note: '这是历史描述性统计，不能用于判断未来开奖倾向。',
      };
      return result;
    },

    async get_ticket_check(args) {
      const res = await tickets.where({ _id: args.ticketId, ownerOpenId: openid }).limit(1).get();
      const ticket = (res.data && res.data[0]) || null;
      if (!ticket) {
        return { ok: false, code: 'NOT_FOUND', message: '没有找到这条记录（或不属于当前用户）' };
      }
      const checkRes = await checks
        .where({ ticketId: args.ticketId })
        .orderBy('checkedAt', 'desc')
        .limit(1)
        .get();
      const check = (checkRes.data && checkRes.data[0]) || null;
      if (!check) {
        return {
          ok: false,
          code: 'NO_CHECK',
          message: '这条记录还没有核对结果',
          ticket: { id: ticket._id, issue: ticket.issue, displayText: ticket.displayText },
          hint: '需先同步该期已核验开奖，再执行"一键核对"。',
        };
      }
      return {
        ok: true,
        ticket: {
          id: ticket._id,
          game: ticket.game,
          issue: ticket.issue,
          displayText: ticket.displayText,
          purchaseStatus: ticket.purchaseStatus,
        },
        check: {
          checkStatus: check.checkStatus,
          prizeLevel: check.prizeLevel,
          unitPrize: check.unitPrize,
          quantity: check.quantity,
          totalPrize: check.totalPrize,
          hitDetails: check.hitDetails,
          pendingReason: check.pendingReason,
          ruleVersion: check.ruleVersion,
          checkedAt: check.checkedAt,
        },
      };
    },

    async get_rule_info(args) {
      const rule = resolveRuleVersion(args.game, args.issue || '');
      if (!rule.found) {
        const fallback = resolveRuleVersion(args.game, '9999999');
        if (args.issue) {
          return {
            ok: false,
            code: 'NO_RULE_VERSION',
            message: `第 ${args.issue} 期没有已建档的规则版本，不支持自动判奖`,
            current: fallback.found
              ? {
                  ruleVersion: fallback.rule.ruleVersion,
                  effectiveFromIssue: fallback.rule.effectiveFromIssue,
                }
              : null,
          };
        }
        if (!fallback.found) {
          return { ok: false, code: 'NO_RULE_VERSION', message: '该彩种没有已建档规则' };
        }
        return { ok: true, game: args.game, rule: describe(fallback.rule) };
      }
      return { ok: true, game: args.game, rule: describe(rule.rule) };
    },
  };

  function describe(rule) {
    return {
      ruleVersion: rule.ruleVersion,
      effectiveFromIssue: rule.effectiveFromIssue,
      effectiveToIssue: rule.effectiveToIssue,
      prizeTable: rule.prizeTable,
      specialRuleConditions: rule.specialRuleConditions,
      sourceUrl: rule.sourceUrl,
      verifiedAt: rule.verifiedAt,
      note: '奖金以"floating"表示浮动奖，必须读取当期官方公告，不得估算。',
    };
  }

  /** 统一入口：先校验工具名与参数，再执行 */
  async function execute(name, rawArgs) {
    const checked = validateToolCall(name, rawArgs);
    if (!checked.ok) {
      return { ok: false, code: checked.code, message: checked.message };
    }
    const handler = handlers[name];
    if (!handler) {
      return { ok: false, code: 'UNKNOWN_TOOL', message: `工具 ${name} 不在允许列表内` };
    }
    return handler(checked.args);
  }

  return { execute, handlers };
}

module.exports = { createExecutors, stripPrivate, summaryOfDraw };
