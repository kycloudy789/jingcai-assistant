/**
 * initDb 测试：建集合、写默认配置、灌规则种子、重复调用幂等。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeCloud, installFakeSdk } = require('./helpers/fake-cloud');

const fake = createFakeCloud();
const restore = installFakeSdk(fake.sdk);
process.env.OWNER_OPENID = 'oOWNER';

const initDb = require('../cloudfunctions/initDb/index.js');

test.after(() => restore());

test('首次调用：建 8 个集合 + 写入 app_config + 灌 2 条规则', async () => {
  const res = await initDb.main({});
  assert.equal(res.success, true);
  assert.equal(res.data.created.length, 8);
  assert.deepEqual(res.data.existed, []);
  assert.deepEqual(res.data.failed, []);
  assert.equal(res.data.config.seeded, true);

  const config = fake.rows('app_config').find((c) => c._id === 'global');
  assert.deepEqual(config.ownerWhitelist, ['oOWNER'], '把调用者加入白名单');
  assert.equal(config.wxComplianceStatus, 'not_checked');
  assert.equal(config.candidateGenerationEnabled, false, '候选开关默认必须关闭');
  assert.equal(config.aiFutureNumberFeatureEnabled, false);

  assert.equal(fake.rows('draw_rules').length, 2);
  assert.ok(res.data.indexGuide.length >= 4, '必须返回索引清单供手工补建');
});

test('重复调用：集合已存在时不报错，也不覆盖配置', async () => {
  fake.rows('app_config').find((c) => c._id === 'global').ownerWhitelist = ['oOWNER', 'oSECOND'];
  const rulesBefore = fake.rows('draw_rules').length;

  const res = await initDb.main({});
  assert.equal(res.success, true);
  assert.equal(res.data.created.length, 0);
  assert.equal(res.data.existed.length, 8);
  assert.equal(res.data.config.seeded, false);
  assert.equal(res.data.config.existed, true);
  assert.equal(fake.rows('draw_rules').length, rulesBefore, '规则种子不重复插入');

  const config = fake.rows('app_config').find((c) => c._id === 'global');
  assert.deepEqual(config.ownerWhitelist, ['oOWNER', 'oSECOND'], '不得覆盖已有白名单');
});

test('非白名单用户调用被拒绝', async () => {
  fake.setOpenId('oINTRUDER');
  const res = await initDb.main({});
  assert.equal(res.success, false);
  assert.equal(res.code, 'AUTH_DENIED');
  fake.setOpenId('oOWNER');
});
