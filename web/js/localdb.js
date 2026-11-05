/**
 * 把本地存储包装成"像云数据库"的最小接口，
 * 这样 shared/cloud/aiTools.js（原本跑在云函数里）可以原样复用，不必重写一套查询。
 *
 * 支持：where(等值) / orderBy / skip / limit / get / count
 */

const LOCAL_NAMES = {
  draw_records: 'draws',
  ticket_records: 'tickets',
  ticket_checks: 'checks',
};

function createLocalDb(store) {
  async function run(cloudName, state) {
    const localName = LOCAL_NAMES[cloudName];
    if (!localName) return []; // sync_logs 等本地不存的集合：按空处理
    let rows = await store.getAll(localName);

    if (state.where && Object.keys(state.where).length) {
      rows = rows.filter((row) =>
        Object.keys(state.where).every((key) => {
          const expected = state.where[key];
          return row[key] === expected;
        })
      );
    }

    if (state.order) {
      const [field, dir] = state.order;
      rows = rows.slice().sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        return av > bv ? 1 : -1;
      });
      if (dir === 'desc') rows.reverse();
    }

    if (state.skip) rows = rows.slice(state.skip);
    if (Number.isFinite(state.limit)) rows = rows.slice(0, state.limit);

    // 本地记录主键叫 id，云数据库叫 _id；统一补上 _id 供复用代码读取
    return rows.map((row) => ({ ...row, _id: row._id || row.id }));
  }

  return {
    collection(name) {
      const state = { where: {}, order: null, limit: Infinity, skip: 0 };
      const api = {
        where(condition) {
          state.where = condition || {};
          return api;
        },
        orderBy(field, dir) {
          state.order = [field, dir || 'asc'];
          return api;
        },
        skip(n) {
          state.skip = n;
          return api;
        },
        limit(n) {
          state.limit = n;
          return api;
        },
        async get() {
          return { data: await run(name, state) };
        },
        async count() {
          return { total: (await run(name, state)).length };
        },
      };
      return api;
    },
  };
}

module.exports = { createLocalDb };
