/**
 * 本地存储：优先 IndexedDB，失败则降级到 localStorage。
 * 纯静态站没有后端，所有个人数据只存在这台设备的浏览器里；
 * 换设备 / 清缓存会丢数据，所以「数据」页提供导出与导入。
 *
 * 为什么要降级：隐私模式、无痕窗口、部分内置浏览器会禁用或阻塞 IndexedDB，
 * 直接空白页比"能用的降级"更糟。
 */

const DB_NAME = 'jingcai_assistant';
const DB_VERSION = 1;
const STORES = ['draws', 'tickets', 'checks', 'meta'];
const LS_PREFIX = 'jc:';

let backendPromise = null;
let backendKind = null;

function keyPathOf(name) {
  return name === 'meta' ? 'k' : 'id';
}

/* ---------------- IndexedDB ---------------- */

function createIdbBackend() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('打开 IndexedDB 超时'));
    }, 3000);

    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: keyPathOf(name) });
        }
      }
    };
    req.onsuccess = () => {
      if (settled) {
        req.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(makeIdbApi(req.result));
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error || new Error('打开 IndexedDB 失败'));
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('IndexedDB 被其他标签页占用'));
    };
  });
}

function makeIdbApi(db) {
  function run(name, mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(name, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(name);
      let value;
      try {
        value = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(value && value.__req ? value.__req.result : value);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中断'));
    });
  }

  return {
    kind: 'indexeddb',
    putAll(name, rows) {
      if (!rows || !rows.length) return Promise.resolve(0);
      return run(name, 'readwrite', (store) => {
        for (const row of rows) store.put(row);
        return rows.length;
      });
    },
    getAll(name) {
      return run(name, 'readonly', (store) => ({ __req: store.getAll() }));
    },
    get(name, id) {
      return run(name, 'readonly', (store) => ({ __req: store.get(id) }));
    },
    put(name, row) {
      return run(name, 'readwrite', (store) => {
        store.put(row);
        return row;
      });
    },
    remove(name, id) {
      return run(name, 'readwrite', (store) => {
        store.delete(id);
        return true;
      });
    },
    clear(name) {
      return run(name, 'readwrite', (store) => {
        store.clear();
        return true;
      });
    },
  };
}

/* ---------------- localStorage ---------------- */

function createLsBackend() {
  if (typeof localStorage === 'undefined') {
    throw new Error('当前环境既不支持 IndexedDB 也不支持 localStorage');
  }
  const probeKey = 'jc:__probe';
  localStorage.setItem(probeKey, '1');
  localStorage.removeItem(probeKey);

  function read(name) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + name);
      const rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      return [];
    }
  }
  function write(name, rows) {
    localStorage.setItem(LS_PREFIX + name, JSON.stringify(rows));
    return rows.length;
  }
  function upsert(name, row) {
    const rows = read(name);
    const key = keyPathOf(name);
    const idx = rows.findIndex((r) => r[key] === row[key]);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    write(name, rows);
    return row;
  }

  return {
    kind: 'localstorage',
    putAll(name, rows) {
      if (!rows || !rows.length) return Promise.resolve(0);
      const all = read(name);
      const key = keyPathOf(name);
      const index = new Map(all.map((r) => [r[key], r]));
      for (const row of rows) index.set(row[key], row);
      write(name, Array.from(index.values()));
      return Promise.resolve(rows.length);
    },
    getAll: (name) => Promise.resolve(read(name)),
    get: (name, id) => Promise.resolve(read(name).find((r) => r[keyPathOf(name)] === id) || null),
    put: (name, row) => Promise.resolve(upsert(name, row)),
    remove: (name, id) => {
      const key = keyPathOf(name);
      write(name, read(name).filter((r) => r[key] !== id));
      return Promise.resolve(true);
    },
    clear: (name) => {
      localStorage.removeItem(LS_PREFIX + name);
      return Promise.resolve(true);
    },
  };
}

/* ---------------- 统一出口 ---------------- */

async function backend() {
  if (!backendPromise) {
    backendPromise = createIdbBackend()
      .catch(() => {
        const ls = createLsBackend();
        return ls;
      })
      .then((b) => {
        backendKind = b.kind;
        return b;
      });
  }
  return backendPromise;
}

async function putAll(name, rows) {
  return (await backend()).putAll(name, rows);
}

async function getAll(name) {
  const rows = await (await backend()).getAll(name);
  return Array.isArray(rows) ? rows : [];
}

async function get(name, id) {
  return (await backend()).get(name, id);
}

async function put(name, row) {
  return (await backend()).put(name, row);
}

async function remove(name, id) {
  return (await backend()).remove(name, id);
}

async function clear(name) {
  return (await backend()).clear(name);
}

async function clearAll() {
  for (const name of STORES) await clear(name);
}

async function getMeta(key) {
  const row = await get('meta', key);
  return row ? row.v : null;
}

async function setMeta(key, value) {
  await put('meta', { k: key, v: value });
  return value;
}

function kind() {
  return backendKind;
}

module.exports = {
  DB_NAME,
  STORES,
  backend,
  kind,
  putAll,
  getAll,
  get,
  put,
  remove,
  clear,
  clearAll,
  getMeta,
  setMeta,
};
