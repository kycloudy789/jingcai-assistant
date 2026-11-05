#!/usr/bin/env node
/**
 * 端到端自检（不需要 CloudBase）：
 *   抓官方数据 → 映射 → 校验 → 内存入库 → 再次入库验幂等 → 渲染展示文本
 * 用法：node scripts/verify-pipeline.js [ssq|kl8] [issueCount]
 * 说明：只读官方公开数据，单次 1 个请求；不写数据库。
 */
const https = require('https');

const { buildQueryUrl, assertResponseShape, mapRecord } = require('../shared/adapters/cwl');
const { validateDrawRecord } = require('../shared/validators/draws');
const { resolveRuleVersion } = require('../shared/rules/registry');
const { upsertDraws, sha256 } = require('../shared/cloud/drawStore');
const { formatDisplay } = require('../shared/validators/numbers');

const game = process.argv[2] === 'kl8' ? 'kl8' : 'ssq';
const issueCount = Number(process.argv[3]) || 5;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (jingcai-assistant verifier)' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('响应不是合法 JSON'));
        }
      });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

function createFakeDb() {
  const stores = {};
  let seq = 0;
  return {
    stores,
    collection(name) {
      if (!stores[name]) stores[name] = [];
      const data = stores[name];
      return {
        where: (q) => ({
          limit: () => ({
            get: async () => ({
              data: data.filter((d) => Object.keys(q).every((k) => d[k] === q[k])),
            }),
          }),
        }),
        add: async ({ data: doc }) => {
          const _id = `id_${(seq += 1)}`;
          data.push({ ...doc, _id });
          return { _id };
        },
        doc: (id) => ({
          update: async ({ data: patch }) => {
            Object.assign(
              data.find((d) => d._id === id) || {},
              patch
            );
            return {};
          },
        }),
      };
    },
  };
}

(async () => {
  const url = buildQueryUrl({ game, mode: 'incremental', issueCount });
  console.log(`[1/5] 请求官方接口: ${url}`);
  const payload = await fetchJson(url);
  const shape = assertResponseShape(payload);
  if (!shape.ok) throw new Error(`响应外壳异常: ${shape.message}`);
  console.log(`      返回 ${shape.count} 条`);

  console.log('[2/5] 映射与校验');
  const records = [];
  for (const raw of payload.result) {
    const mapped = mapRecord(game, raw, { fetchedAt: new Date().toISOString() });
    if (!mapped.ok) {
      console.log(`      ✗ ${raw.code} ${mapped.code} ${mapped.message}`);
      continue;
    }
    const check = validateDrawRecord(mapped.record);
    if (!check.ok) {
      console.log(`      ✗ ${raw.code} ${check.code} ${check.message}`);
      continue;
    }
    const rule = resolveRuleVersion(game, mapped.record.issue);
    records.push({ ...mapped.record, rawHash: sha256(JSON.stringify(raw)), ruleVersion: rule.found ? rule.ruleVersion : null });
  }
  console.log(`      通过 ${records.length}/${payload.result.length}`);

  console.log('[3/5] 首次入库');
  const db = createFakeDb();
  const first = await upsertDraws(db, records);
  console.log(`      新增 ${first.inserted} / 未变 ${first.unchanged} / 冲突 ${first.conflicts} / 错误 ${first.errors.length}`);

  console.log('[4/5] 重复同步（幂等性）');
  const second = await upsertDraws(db, records);
  console.log(`      新增 ${second.inserted} / 未变 ${second.unchanged} / 冲突 ${second.conflicts}`);
  const total = (db.stores.draw_records || []).length;
  const idempotent = second.inserted === 0 && total === records.length;
  console.log(`      库内条数 ${total} → ${idempotent ? '幂等 ✓' : '幂等 ✗'}`);

  console.log('[5/5] 展示渲染');
  for (const r of db.stores.draw_records.slice(0, 3)) {
    console.log(`      ${r.issue} ${r.drawDate}  ${formatDisplay(r.game, r.numbers)}  规则=${r.ruleVersion || '无'}`);
  }

  if (!idempotent) process.exitCode = 1;
  else console.log('\n✓ 端到端自检通过（真实官方数据）');
})().catch((err) => {
  console.error(`✗ 自检失败: ${err.message}`);
  process.exit(1);
});
