#!/usr/bin/env node
/**
 * 导出 draw_rules 种子数据（NDJSON），供云开发控制台导入。
 * 用法：node scripts/seed-rules.js [--out data/seed/draw_rules.ndjson]
 * 规则来源见 docs/data-source-plan.md 与 shared/rules/registry.js，改动前须核对官方公告。
 */
const fs = require('fs');
const path = require('path');
const { RULE_VERSIONS } = require('../shared/rules/registry');

const args = process.argv.slice(2);
const idx = args.indexOf('--out');
const out = idx >= 0 ? args[idx + 1] : path.join('data', 'seed', 'draw_rules.ndjson');

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(path.resolve(out), RULE_VERSIONS.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`✓ 已导出 ${RULE_VERSIONS.length} 条规则 → ${path.resolve(out)}`);
for (const r of RULE_VERSIONS) {
  console.log(`  ${r.game} ${r.ruleVersion} 自 ${r.effectiveFromIssue} 起（核验于 ${r.verifiedAt}）`);
}
