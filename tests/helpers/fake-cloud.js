/**
 * 测试用 CloudBase 替身：内存集合 + 链式查询，支持 equality where / orderBy / skip / limit / count。
 * 仅在 node:test 中使用，不进入生产代码。
 */
function createFakeCloud() {
  const store = new Map();
  let seq = 0;
  let currentOpenId = 'oOWNER';
  const logs = [];

  // 读取不自动建集合（真实 CloudBase 读不存在的集合会报错），写入时才创建
  const coll = (name, create = false) => {
    if (!store.has(name)) {
      if (!create) return [];
      store.set(name, []);
    }
    return store.get(name);
  };

  const matches = (doc, query) =>
    Object.keys(query || {}).every((key) => doc[key] === query[key]);

  const runQuery = (name, state) => {
    let rows = coll(name).filter((d) => matches(d, state.query));
    if (state.order) {
      const [field, dir] = state.order;
      rows = rows
        .slice()
        .sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    if (state.skip) rows = rows.slice(state.skip);
    if (Number.isFinite(state.limit)) rows = rows.slice(0, state.limit);
    return rows.map((d) => ({ ...d }));
  };

  const collection = (name) => {
    const state = { query: {}, order: null, skip: 0, limit: Infinity };

    const api = {
      where(query) {
        state.query = query;
        return api;
      },
      orderBy(field, dir) {
        state.order = [field, dir];
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
      field() {
        return api;
      },
      async get() {
        return { data: runQuery(name, state) };
      },
      async count() {
        return { total: runQuery(name, { ...state, skip: 0, limit: Infinity }).length };
      },
      async add({ data }) {
        const _id = data && data._id ? data._id : `id_${(seq += 1)}`;
        coll(name, true).push({ ...data, _id });
        return { _id };
      },
      doc(id) {
        return {
          async update({ data }) {
            const target = coll(name).find((d) => d._id === id);
            if (target) Object.assign(target, data);
            return { stats: { updated: target ? 1 : 0 } };
          },
          async remove() {
            const rows = coll(name);
            const idx = rows.findIndex((d) => d._id === id);
            if (idx >= 0) rows.splice(idx, 1);
            return { stats: { removed: idx >= 0 ? 1 : 0 } };
          },
          async get() {
            const target = coll(name).find((d) => d._id === id);
            if (!target) throw new Error('document not found');
            return { data: { ...target } };
          },
        };
      },
    };
    return api;
  };

  const sdk = {
    DYNAMIC_CURRENT_ENV: 'fake-env',
    init() {},
    getWXContext() {
      return { OPENID: currentOpenId, APPID: 'wxfake' };
    },
    database() {
      return {
        collection,
        command: {},
        async createCollection(name) {
          if (store.has(name)) {
            const err = new Error('collection already exists');
            err.errMsg = `collection ${name} already exists`;
            throw err;
          }
          store.set(name, []);
          return { ok: true };
        },
      };
    },
  };

  return {
    sdk,
    store,
    logs,
    setOpenId(openid) {
      currentOpenId = openid;
    },
    seed(name, docs) {
      store.set(name, docs.map((d, i) => ({ _id: d._id || `seed_${i}`, ...d })));
    },
    rows(name) {
      return coll(name);
    },
  };
}

/** 把指定 require 请求替换成假实现；返回还原函数 */
function installFakeModule(mapping) {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mapping, request)) return mapping[request];
    return originalLoad.apply(this, arguments);
  };
  return () => {
    Module._load = originalLoad;
  };
}

/** 把 require('wx-server-sdk') 替换为假 SDK；返回还原函数 */
function installFakeSdk(sdk) {
  return installFakeModule({ 'wx-server-sdk': sdk });
}

/**
 * 假 https：按顺序返回预设响应，用于离线测试 aiChat。
 * @param {Array<{status:number, body:string}>} responses
 */
function createFakeHttps(responses) {
  const { EventEmitter } = require('events');
  const calls = [];
  let index = 0;

  return {
    calls,
    module: {
      request(url, options, cb) {
        const resp = responses[Math.min(index, responses.length - 1)] || { status: 500, body: '{}' };
        index += 1;
        const record = { url, options, body: '' };
        calls.push(record);

        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = () => {};
        req.write = (chunk) => {
          record.body += chunk;
        };
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = resp.status;
          res.setEncoding = () => {};
          process.nextTick(() => {
            cb(res);
            if (resp.body) res.emit('data', resp.body);
            res.emit('end');
          });
        };
        return req;
      },
    },
  };
}

module.exports = { createFakeCloud, installFakeSdk, installFakeModule, createFakeHttps };
