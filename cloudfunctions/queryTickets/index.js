/**
 * queryTickets：个人号码查询（列表 / 详情 / 状态计数）。
 * 只读；强制按 ownerOpenId 过滤，模型与前端都无法看到他人记录。
 */
const { createHandler, cloud } = require('./shared/cloud/base');
const { PURCHASE_STATUS, isGame } = require('./shared/constants/games');

const COLLECTION = 'ticket_records';
const MAX_PAGE_SIZE = 50;

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

exports.main = createHandler('queryTickets', async ({ event, openid }) => {
  const db = cloud.database();
  const _ = db.command;
  const collection = db.collection(COLLECTION);
  const mode = event.mode || 'list';

  if (mode === 'detail') {
    if (!event.ticketId) {
      return { success: false, code: 'BAD_PARAMS', message: '缺少 ticketId' };
    }
    const res = await collection
      .where({ _id: event.ticketId, ownerOpenId: openid })
      .limit(1)
      .get();
    const item = (res.data && res.data[0]) || null;
    if (!item) return { success: false, code: 'NOT_FOUND', message: '记录不存在或不属于你' };
    return { item };
  }

  if (mode === 'summary') {
    const out = { draft: 0, confirmed: 0, void: 0, total: 0 };
    for (const status of Object.values(PURCHASE_STATUS)) {
      const res = await collection.where({ ownerOpenId: openid, purchaseStatus: status }).count();
      out[status] = res.total || 0;
      out.total += res.total || 0;
    }
    return out;
  }

  const pageNo = clampInt(event.pageNo, 1, 10000, 1);
  const pageSize = clampInt(event.pageSize, 1, MAX_PAGE_SIZE, 20);

  const where = { ownerOpenId: openid };
  if (isGame(event.game)) where.game = event.game;
  if (typeof event.issue === 'string' && /^\d{7}$/.test(event.issue)) where.issue = event.issue;
  if (Object.values(PURCHASE_STATUS).includes(event.status)) where.purchaseStatus = event.status;

  const countRes = await collection.where(where).count();
  const listRes = await collection
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip((pageNo - 1) * pageSize)
    .limit(pageSize)
    .get();

  const counts = { draft: 0, confirmed: 0, void: 0 };
  for (const status of Object.values(PURCHASE_STATUS)) {
    const res = await collection.where({ ownerOpenId: openid, purchaseStatus: status }).count();
    counts[status] = res.total || 0;
  }

  return {
    items: listRes.data || [],
    pageNo,
    pageSize,
    total: countRes.total || 0,
    hasMore: pageNo * pageSize < (countRes.total || 0),
    counts,
  };
});
