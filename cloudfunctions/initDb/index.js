/**
 * initDb：一次性初始化（替代手工建集合、手写 app_config、手工导入规则）。
 *
 * 做什么：
 *   1. 创建 8 个集合（已存在则跳过）；
 *   2. 若 app_config 无 "global" 文档，写入默认配置，并把当前调用者加入白名单；
 *   3. 若 draw_rules 为空，写入规则版本种子；
 *   4. 返回仍需手工完成的索引清单（SDK 无法建索引）。
 *
 * 幂等：重复调用不会重复建集合、不会覆盖已有 app_config。
 */
const { createHandler, cloud } = require('./shared/cloud/base');
const { RULE_VERSIONS } = require('./shared/rules/registry');
const { DEFAULT_FEATURE_FLAGS } = require('./shared/constants/games');

const COLLECTIONS = [
  'draw_records',
  'draw_rules',
  'sync_logs',
  'app_config',
  'ticket_records',
  'ticket_checks',
  'ai_conversations',
  'ai_messages',
];

const INDEX_GUIDE = [
  { collection: 'draw_records', indexes: ['game ASC + issue DESC（唯一）', 'game ASC + drawDate DESC', 'drawStatus ASC'] },
  { collection: 'ticket_records', indexes: ['ownerOpenId ASC + createdAt DESC', 'ownerOpenId ASC + purchaseStatus ASC', 'ownerOpenId ASC + idempotencyKey ASC（唯一）'] },
  { collection: 'ticket_checks', indexes: ['idempotencyKey ASC（唯一）', 'ticketId ASC + checkedAt DESC', 'ownerOpenId ASC + checkedAt DESC'] },
  { collection: 'sync_logs', indexes: ['createdAt DESC'] },
  { collection: 'ai_messages', indexes: ['sessionId ASC + createdAt ASC', 'ownerOpenId ASC + createdAt DESC'] },
  { collection: 'ai_conversations', indexes: ['ownerOpenId ASC + updatedAt DESC'] },
];

exports.main = createHandler('initDb', async ({ openid, config }) => {
  const db = cloud.database();
  const created = [];
  const existed = [];
  const failed = [];

  const canCreate = typeof db.createCollection === 'function';
  if (!canCreate) {
    return {
      success: false,
      code: 'SDK_UNSUPPORTED',
      message: '当前云函数 SDK 不支持自动建集合，请在云开发控制台手动创建',
      needCollections: COLLECTIONS,
    };
  }

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '');
      if (/exist|已存在|duplicate/i.test(msg)) existed.push(name);
      else failed.push({ name, message: msg.slice(0, 150) });
    }
  }

  // app_config：只在缺失时写入，绝不覆盖
  let configSeeded = false;
  let configExisted = false;
  try {
    const found = await db.collection('app_config').where({ _id: 'global' }).limit(1).get();
    if (found.data && found.data[0]) {
      configExisted = true;
    } else {
      await db.collection('app_config').add({
        data: {
          _id: 'global',
          ownerWhitelist: [openid],
          wxComplianceStatus: DEFAULT_FEATURE_FLAGS.wxComplianceStatus,
          candidateGenerationEnabled: false,
          aiFutureNumberFeatureEnabled: false,
          productionFeaturePolicy: DEFAULT_FEATURE_FLAGS.productionFeaturePolicy,
          syncEnabled: true,
          fuyunEmptyMeansInactive: false,
          aiEnabled: true,
          modelName: 'deepseek-flash',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      configSeeded = true;
    }
  } catch (err) {
    failed.push({ name: 'app_config', message: String(err && (err.errMsg || err.message)).slice(0, 150) });
  }

  // draw_rules：只在为空时写入种子
  let rulesSeeded = 0;
  try {
    const countRes = await db.collection('draw_rules').count();
    if (!countRes.total) {
      for (const rule of RULE_VERSIONS) {
        await db.collection('draw_rules').add({ data: { ...rule, createdAt: new Date().toISOString() } });
        rulesSeeded += 1;
      }
    }
  } catch (err) {
    failed.push({ name: 'draw_rules', message: String(err && (err.errMsg || err.message)).slice(0, 150) });
  }

  return {
    created,
    existed,
    failed,
    config: { seeded: configSeeded, existed: configExisted, ownerOpenId: openid },
    rules: { seeded: rulesSeeded },
    indexGuide: INDEX_GUIDE,
    note: '集合与配置已就绪。索引无法通过 SDK 创建，请按下表在控制台补建；随后到「开奖」页同步数据。',
  };
});
