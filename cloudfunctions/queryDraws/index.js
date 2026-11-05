/**
 * queryDraws：开奖列表 / 详情 / 元信息（最新期号、上次同步）。
 * 只读。前端不得修改官方记录。
 */
const { createHandler, cloud } = require('./shared/cloud/base');
const { COLLECTIONS } = require('./shared/cloud/drawStore');
const { GAME } = require('./shared/constants/games');

const MAX_PAGE_SIZE = 50;

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

exports.main = createHandler('queryDraws', async ({ event }) => {
  const db = cloud.database();
  const _ = db.command;
  const collection = db.collection(COLLECTIONS.DRAW_RECORDS);
  const mode = event.mode || 'list';

  if (mode === 'detail') {
    const { game, issue } = event;
    if (!game || !issue) {
      return { success: false, code: 'BAD_PARAMS', message: '需要 game 与 issue' };
    }
    const res = await collection.where({ game, issue: String(issue) }).limit(1).get();
    const item = (res.data && res.data[0]) || null;
    if (!item) {
      return { success: false, code: 'NOT_FOUND', message: '本地尚无该期已核验数据，可执行同步或导入' };
    }
    return { item };
  }

  if (mode === 'meta') {
    const result = { latest: {}, lastSync: null };
    for (const game of [GAME.SSQ, GAME.KL8]) {
      const res = await collection
        .where({ game })
        .orderBy('issue', 'desc')
        .limit(1)
        .field({ issue: true, drawDate: true, drawStatus: true, verifiedAt: true })
        .get();
      result.latest[game] = (res.data && res.data[0]) || null;
    }
    try {
      const logs = await db
        .collection(COLLECTIONS.SYNC_LOGS)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
      result.lastSync = (logs.data && logs.data[0]) || null;
    } catch (err) {
      result.lastSync = null;
    }
    return result;
  }

  // list
  const game = event.game;
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { success: false, code: 'GAME_UNSUPPORTED', message: '只支持 ssq 与 kl8' };
  }

  const pageNo = clampInt(event.pageNo, 1, 10000, 1);
  const pageSize = clampInt(event.pageSize, 1, MAX_PAGE_SIZE, 20);

  const where = { game };
  const year = typeof event.year === 'string' && /^\d{4}$/.test(event.year) ? event.year : null;
  if (year) {
    where.issue = _.gte(`${year}001`).and(_.lte(`${year}999`));
  }
  if (typeof event.issue === 'string' && /^\d{7}$/.test(event.issue)) {
    where.issue = event.issue;
  }
  if (event.status && ['verified', 'corrected', 'conflict', 'parsed'].includes(event.status)) {
    where.drawStatus = event.status;
  }

  const countRes = await collection.where(where).count();
  const listRes = await collection
    .where(where)
    .orderBy('issue', 'desc')
    .skip((pageNo - 1) * pageSize)
    .limit(pageSize)
    .get();

  return {
    items: listRes.data || [],
    pageNo,
    pageSize,
    total: countRes.total || 0,
    hasMore: pageNo * pageSize < (countRes.total || 0),
    year,
  };
});
