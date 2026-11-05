/**
 * ticketService：个人号码的写操作（create / update / confirm / void / delete）。
 *
 * 为什么合并成一个函数：单人应用若按动作拆成 5 个云函数，鉴权外壳与部署步骤都重复 5 次；
 * 行为契约（动作名、参数、返回）保持不变，见 docs/decisions.md D14。
 *
 * 安全约束：
 *   - 所有查询都强制带 ownerOpenId（来自运行上下文，不接受前端传入）。
 *   - 号码冻结、状态流转、删除条件都由 shared/domain/tickets.js 判定，前端无法绕过。
 */
const { createHandler, cloud } = require('./shared/cloud/base');
const {
  buildTicketDraft,
  applyPatch,
  confirmPurchase,
  voidTicket,
  canDeleteTicket,
  CODE,
} = require('./shared/domain/tickets');

const COLLECTION = 'ticket_records';

function failWith(code, message) {
  return { success: false, code, message };
}

async function loadOwned(db, openid, ticketId) {
  if (!ticketId || typeof ticketId !== 'string') return null;
  const res = await db
    .collection(COLLECTION)
    .where({ _id: ticketId, ownerOpenId: openid })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

function toDto(ticket) {
  return {
    id: ticket._id,
    game: ticket.game,
    playType: ticket.playType,
    issue: ticket.issue,
    numbers: ticket.numbers,
    displayText: ticket.displayText,
    purchaseStatus: ticket.purchaseStatus,
    recordSource: ticket.recordSource,
    candidateId: ticket.candidateId || null,
    purchaseAt: ticket.purchaseAt || null,
    actualCost: ticket.actualCost === undefined ? null : ticket.actualCost,
    multiple: ticket.multiple,
    note: ticket.note || '',
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    confirmedAt: ticket.confirmedAt || null,
    voidedAt: ticket.voidedAt || null,
    voidReason: ticket.voidReason || '',
  };
}

exports.main = createHandler('ticketService', async ({ event, openid }) => {
  const db = cloud.database();
  const action = event.action;
  const collection = db.collection(COLLECTION);

  if (action === 'create') {
    const built = buildTicketDraft(event.ticket || event, { ownerOpenId: openid });
    if (!built.ok) return failWith(built.code, built.message);

    // 幂等：同一 client 生成的 key 只创建一次，连点不会产生重复记录
    if (built.record.idempotencyKey) {
      const existing = await collection
        .where({ ownerOpenId: openid, idempotencyKey: built.record.idempotencyKey })
        .limit(1)
        .get();
      if (existing.data && existing.data[0]) {
        return { created: false, ticket: toDto(existing.data[0]), duplicated: true };
      }
    }

    const res = await collection.add({ data: built.record });
    return { created: true, ticket: toDto({ ...built.record, _id: res._id }) };
  }

  if (action === 'update') {
    const ticket = await loadOwned(db, openid, event.ticketId);
    if (!ticket) return failWith(CODE.NOT_FOUND, '记录不存在或不属于你');

    const patched = applyPatch(ticket, event.patch || {});
    if (!patched.ok) return failWith(patched.code, patched.message);

    await collection.doc(ticket._id).update({ data: patched.update });
    return { ticket: toDto({ ...ticket, ...patched.update }) };
  }

  if (action === 'confirm') {
    const ticket = await loadOwned(db, openid, event.ticketId);
    if (!ticket) return failWith(CODE.NOT_FOUND, '记录不存在或不属于你');

    const confirmed = confirmPurchase(ticket, event.payload || {});
    if (!confirmed.ok) return failWith(confirmed.code, confirmed.message);

    await collection.doc(ticket._id).update({ data: confirmed.update });
    return { ticket: toDto({ ...ticket, ...confirmed.update }) };
  }

  if (action === 'void') {
    const ticket = await loadOwned(db, openid, event.ticketId);
    if (!ticket) return failWith(CODE.NOT_FOUND, '记录不存在或不属于你');

    const voided = voidTicket(ticket, event.payload || {});
    if (!voided.ok) return failWith(voided.code, voided.message);

    await collection.doc(ticket._id).update({ data: voided.update });
    return { ticket: toDto({ ...ticket, ...voided.update }) };
  }

  if (action === 'delete') {
    const ticket = await loadOwned(db, openid, event.ticketId);
    if (!ticket) return failWith(CODE.NOT_FOUND, '记录不存在或不属于你');

    const verdict = canDeleteTicket(ticket);
    if (!verdict.ok) return failWith(verdict.code, verdict.message);

    await collection.doc(ticket._id).remove();
    return { deleted: true, ticketId: ticket._id };
  }

  return failWith('BAD_ACTION', '未知操作');
});
