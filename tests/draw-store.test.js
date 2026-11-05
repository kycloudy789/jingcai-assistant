/**
 * 入库逻辑测试（用内存假库，验证幂等 / 冲突 / 校验），不依赖 CloudBase。
 * 覆盖主方案 12.3 幂等与防重、9.4 冲突不覆盖。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareRecord, upsertDraws, sha256, COLLECTIONS } = require('../shared/cloud/drawStore');
const { mapRecord } = require('../shared/adapters/cwl');

const ssqFixture = require('./fixtures/cwl-ssq.json');
const kl8Fixture = require('./fixtures/cwl-kl8.json');

function createFakeDb() {
  const docs = [];
  let seq = 0;
  const match = (doc, query) =>
    Object.keys(query).every((key) => {
      const cond = query[key];
      if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(doc[key]);
      return doc[key] === cond;
    });

  return {
    docs,
    collection(name) {
      const store = (this._stores = this._stores || {});
      if (!store[name]) store[name] = [];
      const data = store[name];
      docs.push(data);
      return {
        where(query) {
          return {
            limit() {
              return { get: async () => ({ data: data.filter((d) => match(d, query)) }) };
            },
          };
        },
        add: async ({ data: doc }) => {
          const _id = `id_${(seq += 1)}`;
          data.push({ ...doc, _id });
          return { _id };
        },
        doc(id) {
          return {
            update: async ({ data: patch }) => {
              const target = data.find((d) => d._id === id);
              if (target) Object.assign(target, patch);
              return { stats: { updated: target ? 1 : 0 } };
            },
          };
        },
      };
    },
  };
}

const ssqRecord = (issue = '2026126') => {
  const raw = ssqFixture.result.find((r) => r.code === issue);
  const mapped = mapRecord('ssq', raw, { fetchedAt: '2026-11-05T00:00:00Z' });
  return { ...mapped.record, rawHash: sha256(JSON.stringify(raw)) };
};

const kl8Record = (issue = '2026294') => {
  const raw = kl8Fixture.result.find((r) => r.code === issue);
  const mapped = mapRecord('kl8', raw, { fetchedAt: '2026-11-05T00:00:00Z' });
  return { ...mapped.record, rawHash: sha256(JSON.stringify(raw)) };
};

test('prepareRecord 按期号写入规则版本', () => {
  const ok = prepareRecord(ssqRecord('2026126'));
  assert.equal(ok.ok, true);
  assert.equal(ok.record.ruleVersion, 'ssq_2026_02_01');
  assert.equal(ok.record.drawStatus, 'verified');
  assert.ok(ok.record.verifiedAt);

  const noRule = prepareRecord({ ...ssqRecord('2026126'), issue: '2026013' });
  assert.equal(noRule.ok, true);
  assert.equal(noRule.record.ruleVersion, null, '旧期无规则版本 → 入库但不自动判奖');
  assert.equal(noRule.ruleMissing, true);
});

test('prepareRecord 拒绝非法记录，且不产生默认号码', () => {
  const bad = prepareRecord({ ...ssqRecord('2026126'), numbers: { red: [1, 2, 3], blue: 1, kl8: [] } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'NUMBERS_INVALID');
});

test('首次入库插入，重复同步只更新时间戳（幂等）', async () => {
  const fake = createFakeDb();
  const first = await upsertDraws(fake, [ssqRecord('2026126'), kl8Record('2026294')]);
  assert.deepEqual(
    { inserted: first.inserted, unchanged: first.unchanged, conflicts: first.conflicts },
    { inserted: 2, unchanged: 0, conflicts: 0 }
  );

  const second = await upsertDraws(fake, [ssqRecord('2026126'), kl8Record('2026294')]);
  assert.deepEqual(
    { inserted: second.inserted, unchanged: second.unchanged, conflicts: second.conflicts },
    { inserted: 0, unchanged: 2, conflicts: 0 }
  );

  const rows = fake.docs.find((arr) => arr.length === 2);
  assert.equal(rows.length, 2, '同一 game+issue 不得重复入库');
});

test('数据变化进入冲突，不覆盖旧号码', async () => {
  const fake = createFakeDb();
  await upsertDraws(fake, [ssqRecord('2026126')]);

  const tampered = { ...ssqRecord('2026126'), numbers: { red: [1, 2, 3, 4, 5, 6], blue: 1, kl8: [] } };
  const res = await upsertDraws(fake, [tampered]);
  assert.equal(res.conflicts, 1);
  assert.equal(res.inserted, 0);

  const doc = fake.docs[0][0];
  assert.equal(doc.drawStatus, 'conflict');
  assert.deepEqual(doc.numbers.red, [9, 10, 13, 22, 29, 32], '旧号码必须保留');
  assert.deepEqual(doc.conflictInfo.incomingNumbers.red, [1, 2, 3, 4, 5, 6]);
});

test('同批里一条坏数据不影响其它记录', async () => {
  const fake = createFakeDb();
  const res = await upsertDraws(fake, [ssqRecord('2026126'), { game: 'ssq', issue: 'BAD' }]);
  assert.equal(res.inserted, 1);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'ISSUE_INVALID');
});

test('入库记录包含可追溯字段', async () => {
  const fake = createFakeDb();
  await upsertDraws(fake, [ssqRecord('2026126')]);
  const doc = fake.docs[0][0];
  for (const field of [
    'sourceUrl',
    'sourceType',
    'rawHash',
    'parserVersion',
    'fetchedAt',
    'verifiedAt',
    'verifiedBy',
    'ruleVersion',
  ]) {
    assert.ok(doc[field], `缺少追溯字段 ${field}`);
  }
  assert.equal(doc.sourceType, 'official_web');
  assert.equal(doc.verifiedBy, 'official_api');
});

test('CSV 导入标记核验人为本人', async () => {
  const fake = createFakeDb();
  await upsertDraws(fake, [ssqRecord('2026126')], { verifiedBy: 'owner_csv_import' });
  assert.equal(fake.docs[0][0].verifiedBy, 'owner_csv_import');
});

test('sha256 稳定且为 64 位十六进制', () => {
  const a = sha256('{"a":1}');
  assert.equal(a, sha256('{"a":1}'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(COLLECTIONS.DRAW_RECORDS, 'draw_records');
});
