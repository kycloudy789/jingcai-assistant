/**
 * Web 仓库层：闸门与"导入只生成草稿"的行为测试。
 * 用内存版 store 替换 web/js/store.js（浏览器专有），仓库层原样执行。
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function createMemStore() {
  const data = new Map();
  const meta = new Map();
  const coll = (name) => {
    if (!data.has(name)) data.set(name, []);
    return data.get(name);
  };
  return {
    _data: data,
    _meta: meta,
    async getAll(name) {
      return coll(name).slice();
    },
    async get(name, id) {
      const key = name === 'meta' ? 'k' : 'id';
      return coll(name).find((r) => r[key] === id) || null;
    },
    async put(name, row) {
      const key = name === 'meta' ? 'k' : 'id';
      const rows = coll(name);
      const i = rows.findIndex((r) => r[key] === row[key]);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      return row;
    },
    async putAll(name, rows) {
      for (const r of rows) await this.put(name, r);
      return rows.length;
    },
    async remove(name, id) {
      const key = name === 'meta' ? 'k' : 'id';
      const rows = coll(name);
      const i = rows.findIndex((r) => r[key] === id);
      if (i >= 0) rows.splice(i, 1);
      return true;
    },
    async clear(name) {
      data.set(name, []);
      return true;
    },
    async clearAll() {
      data.clear();
      return true;
    },
    async getMeta(key) {
      return meta.has(key) ? meta.get(key) : null;
    },
    async setMeta(key, value) {
      meta.set(key, value);
      return value;
    },
  };
}

function loadRepoWithStore(memStore) {
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === './store' && parent && /web[\\/]js[\\/]repo\.js$/.test(parent.filename)) {
      return memStore;
    }
    return original.apply(this, arguments);
  };
  delete require.cache[require.resolve('../web/js/repo')];
  try {
    return require('../web/js/repo');
  } finally {
    Module._load = original;
  }
}

test('默认闸门关闭：生成被拒绝，且不写任何批次', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);

  const gate = await repo.gateState();
  assert.equal(gate.candidateGeneration, false);
  assert.equal(gate.complianceState, 'not_checked');

  const res = await repo.generateCandidateBatch({ game: 'ssq', seed: 'r1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FEATURE_DISABLED');
  assert.equal((await repo.listCandidates()).length, 0);
});

test('开启后可生成，批次字段完整且组间不重复', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true, { allowAi: true });

  const res = await repo.generateCandidateBatch({
    game: 'ssq',
    strategy: 'balanced',
    count: 3,
    targetIssue: '2026127',
    seed: 'repo-seed',
  });
  assert.equal(res.ok, true);
  const b = res.batch;
  assert.equal(b.algorithmVersion, 'candidate@1.0.0');
  assert.equal(b.randomSeed, require('../shared/domain/candidates').hashSeed('repo-seed'));
  assert.ok(b.parameterSnapshot);
  assert.equal(b.complianceState, 'self_attested_personal_use');
  assert.equal(b.targetIssue, '2026127');
  assert.equal(new Set(b.groups.map((g) => g.key)).size, 3);

  const list = await repo.listCandidates();
  assert.equal(list.length, 1);
});

test('关闭闸门后：历史批次仍可读，但不能再生成/导入', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true);
  const gen = await repo.generateCandidateBatch({ game: 'ssq', targetIssue: '2026127', seed: 'r2' });

  await repo.setCandidateGate(false);
  assert.equal((await repo.listCandidates()).length, 1, '历史批次不该被删');
  assert.equal((await repo.generateCandidateBatch({ game: 'ssq' })).code, 'FEATURE_DISABLED');
  assert.equal((await repo.importCandidateBatch(gen.batch.id)).code, 'FEATURE_DISABLED');
});

test('导入批次：只生成草稿，金额为空、号码冻结前可改', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true);
  const gen = await repo.generateCandidateBatch({
    game: 'ssq',
    count: 3,
    targetIssue: '2026127',
    seed: 'import-1',
  });

  const res = await repo.importCandidateBatch(gen.batch.id);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);

  const tickets = await repo.listTickets();
  assert.equal(tickets.length, 3);
  for (const t of tickets) {
    assert.equal(t.purchaseStatus, 'draft', '导入只能是 draft');
    assert.equal(t.actualCost, null, '金额必须为空，不能自动填单价');
    assert.equal(t.purchaseAt, null);
    assert.equal(t.recordSource, 'candidate_import');
    assert.match(t.candidateId, /^b_.*#\d$/);
  }

  // 再导入一次会产生新草稿（幂等由 idempotencyKey 决定，这里未传，允许重复）
  const again = await repo.importCandidateBatch(gen.batch.id);
  assert.equal(again.ok, true);
  assert.equal((await repo.listTickets()).length, 6);
});

test('导入批次：缺期号时明确报错，不静默写库', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true);
  const gen = await repo.generateCandidateBatch({ game: 'kl8', count: 2, seed: 'import-2' });

  const res = await repo.importCandidateBatch(gen.batch.id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ISSUE_REQUIRED');
  assert.equal((await repo.listTickets()).length, 0);
});

test('导入批次：期号非法时整体不写（不会部分成功）', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true);
  const gen = await repo.generateCandidateBatch({ game: 'ssq', count: 3, seed: 'import-3' });

  const res = await repo.importCandidateBatch(gen.batch.id, '202612');
  assert.equal(res.ok, false);
  assert.equal((await repo.listTickets()).length, 0);
});

test('批次回看：目标期已开奖时给出命中数，未开奖时为 null', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true);
  const gen = await repo.generateCandidateBatch({
    game: 'ssq',
    count: 2,
    targetIssue: '2026127',
    seed: 'review-repo',
  });

  let list = await repo.listCandidateReviews('ssq');
  assert.equal(list[0].review, null, '没开奖就没有回看数据');

  await mem.put('draws', {
    id: 'ssq:2026127',
    game: 'ssq',
    issue: '2026127',
    drawStatus: 'verified',
    numbers: { ...gen.batch.groups[0].numbers },
  });
  list = await repo.listCandidateReviews('ssq');
  assert.equal(list[0].review.ok, true);
  assert.equal(list[0].review.best.totalHits, 7);
});

test('备份导出包含候选批次，且能原样恢复', async () => {
  const mem = createMemStore();
  const repo = loadRepoWithStore(mem);
  await repo.setCandidateGate(true);
  await repo.generateCandidateBatch({ game: 'ssq', count: 2, seed: 'export-1' });

  const dump = await repo.exportAll();
  assert.equal(dump.schema, 'jingcai-web@2');
  assert.equal(dump.candidates.length, 1);

  const mem2 = createMemStore();
  const repo2 = loadRepoWithStore(mem2);
  const counts = await repo2.importAll(JSON.parse(JSON.stringify(dump)));
  assert.equal(counts.candidates, 1);
  assert.equal((await repo2.listCandidates()).length, 1);

  // 旧版备份（@1，无 candidates）仍可导入
  const legacy = { ...dump, schema: 'jingcai-web@1' };
  delete legacy.candidates;
  const counts2 = await repo2.importAll(JSON.parse(JSON.stringify(legacy)));
  assert.equal(counts2.tickets, 0);
});
