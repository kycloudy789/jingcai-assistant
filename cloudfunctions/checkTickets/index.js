/**
 * checkTickets：对「已确认购买」的号码执行判奖并留痕。
 *
 * 约束：
 *   - 只处理 purchaseStatus=confirmed 的记录；
 *   - 只使用 drawStatus=verified/corrected 的开奖数据；
 *   - 幂等键 = 票 + 开奖记录 + 规则版本 + 原始哈希；重复执行不产生重复核对；
 *   - 数据更正后重算：新建一条核对结果，recheckOf 指向上一版，不覆盖历史；
 *   - 不在本函数里改 purchaseStatus（checked 是派生态，见 decisions.md D8）。
 */
const { createHandler, cloud } = require('./shared/cloud/base');
const { judgeTicket, checkIdempotencyKey, PENDING_REASON } = require('./shared/rules/judge');
const { PURCHASE_STATUS, isGame } = require('./shared/constants/games');

/** 这些原因只代表"还没到判奖时机"，不必落库，否则会污染核对记录 */
const SKIP_REASONS = new Set([
  PENDING_REASON.NO_DRAW,
  PENDING_REASON.DRAW_NOT_VERIFIED,
  PENDING_REASON.MISMATCH,
]);

const TICKETS = 'ticket_records';
const DRAWS = 'draw_records';
const CHECKS = 'ticket_checks';
const MAX_TICKETS = 200;

exports.main = createHandler('checkTickets', async ({ event, openid }) => {
  const db = cloud.database();
  const now = new Date().toISOString();
  const force = event.force === true;

  const ticketQuery = { ownerOpenId: openid, purchaseStatus: PURCHASE_STATUS.CONFIRMED };
  if (isGame(event.game)) ticketQuery.game = event.game;
  if (typeof event.issue === 'string' && /^\d{7}$/.test(event.issue)) ticketQuery.issue = event.issue;
  if (event.ticketId) ticketQuery._id = event.ticketId;

  const ticketRes = await db
    .collection(TICKETS)
    .where(ticketQuery)
    .limit(MAX_TICKETS)
    .get();

  const tickets = ticketRes.data || [];
  if (!tickets.length) {
    return { total: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, winners: 0, results: [] };
  }

  const drawCache = new Map();
  async function getDraw(game, issue) {
    const key = `${game}:${issue}`;
    if (drawCache.has(key)) return drawCache.get(key);
    const res = await db.collection(DRAWS).where({ game, issue }).limit(1).get();
    const doc = (res.data && res.data[0]) || null;
    const usable = doc && (doc.drawStatus === 'verified' || doc.drawStatus === 'corrected') ? doc : null;
    drawCache.set(key, usable);
    return usable;
  }

  const summary = { total: tickets.length, inserted: 0, updated: 0, unchanged: 0, skipped: 0, winners: 0, results: [] };

  for (const ticket of tickets) {
    const draw = await getDraw(ticket.game, ticket.issue);
    const result = judgeTicket(ticket, draw);

    if (!result.ok) {
      summary.skipped += 1;
      continue;
    }
    if (SKIP_REASONS.has(result.pendingReason)) {
      summary.skipped += 1;
      continue;
    }

    const idempotencyKey = checkIdempotencyKey(ticket, draw, result.ruleVersion);
    const payload = {
      ticketId: ticket._id,
      ownerOpenId: openid,
      game: result.game,
      issue: result.issue,
      drawRecordId: result.drawRecordId,
      drawHash: result.drawHash,
      ruleVersion: result.ruleVersion,
      hitDetails: result.hit,
      prizeLevel: result.prizeLevel,
      unitPrize: result.unitPrize,
      quantity: result.quantity,
      totalPrize: result.totalPrize,
      checkStatus: result.checkStatus,
      pendingReason: result.pendingReason,
      isWinner: result.isWinner,
      idempotencyKey,
      checkedAt: now,
      updatedAt: now,
    };

    const existing = await db
      .collection(CHECKS)
      .where({ idempotencyKey })
      .limit(1)
      .get();
    const existingDoc = (existing.data && existing.data[0]) || null;

    if (existingDoc) {
      if (!force) {
        summary.unchanged += 1;
        summary.results.push({ ticketId: ticket._id, checkStatus: existingDoc.checkStatus, reused: true });
        continue;
      }
      await db.collection(CHECKS).doc(existingDoc._id).update({ data: payload });
      summary.updated += 1;
    } else {
      // 保留历史：新的核对指向上一版
      const prev = await db
        .collection(CHECKS)
        .where({ ticketId: ticket._id })
        .orderBy('checkedAt', 'desc')
        .limit(1)
        .get();
      const prevDoc = (prev.data && prev.data[0]) || null;

      await db.collection(CHECKS).add({
        data: { ...payload, recheckOf: prevDoc ? prevDoc._id : null, createdAt: now },
      });
      summary.inserted += 1;
    }

    if (result.isWinner) summary.winners += 1;
    summary.results.push({
      ticketId: ticket._id,
      checkStatus: result.checkStatus,
      prizeLevel: result.prizeLevel,
      totalPrize: result.totalPrize,
      pendingReason: result.pendingReason,
    });

    // 派生展示字段（仅是 ticket_checks 的缓存，不参与任何判定）
    await db
      .collection(TICKETS)
      .doc(ticket._id)
      .update({
        data: {
          checkSummary: {
            checkStatus: result.checkStatus,
            prizeLevel: result.prizeLevel,
            unitPrize: result.unitPrize,
            totalPrize: result.totalPrize,
            pendingReason: result.pendingReason,
            ruleVersion: result.ruleVersion,
            checkedAt: now,
            hitNumbers: (result.hit && result.hit.numbers) || [],
            hitRed: result.hit && typeof result.hit.red === 'number' ? result.hit.red : null,
            hitCount: result.hit && typeof result.hit.count === 'number' ? result.hit.count : null,
            hitBlue: result.hit && typeof result.hit.blue === 'boolean' ? result.hit.blue : null,
          },
          updatedAt: now,
        },
      });
  }

  return summary;
});
