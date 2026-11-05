#!/usr/bin/env node
/**
 * 本地校验 CSV 并生成可导入云开发控制台的 NDJSON。
 * 用法：node scripts/import-draws.js <csv路径> [--out <输出路径>]
 * 说明：本脚本不联网、不写数据库；写入由云函数 importDraws 或控制台导入完成。
 */
const fs = require('fs');
const path = require('path');

const { parseDrawsCsv, toDrawsCsv } = require('../shared/parsers/csv');
const { validateDrawRecord } = require('../shared/validators/draws');
const { resolveRuleVersion } = require('../shared/rules/registry');

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : input ? input.replace(/\.csv$/i, '.ndjson') : null;

  if (!input) {
    console.error('用法: node scripts/import-draws.js <csv路径> [--out <输出路径>]');
    process.exit(1);
  }
  const text = fs.readFileSync(input, 'utf8');

  const { records, errors, headerOk } = parseDrawsCsv(text, {
    validation: (r) => validateDrawRecord(r, { now: new Date() }),
  });

  if (!headerOk) {
    console.error(`✗ 表头不正确: ${errors[0].message}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const prepared = records.map((r) => {
    const rule = resolveRuleVersion(r.game, r.issue);
    return {
      ...r,
      ruleVersion: rule.found ? rule.ruleVersion : null,
      drawStatus: 'verified',
      verifiedAt: now,
      verifiedBy: 'owner_csv_import',
      createdAt: now,
      updatedAt: now,
    };
  });

  console.log(`读取 ${records.length + errors.length} 行，校验通过 ${records.length} 条`);
  if (errors.length) {
    console.log(`\n跳过 ${errors.length} 行：`);
    for (const e of errors) console.log(`  第 ${e.line} 行 [${e.code}] ${e.message}`);
  }

  const missingRule = prepared.filter((r) => !r.ruleVersion);
  if (missingRule.length) {
    console.log(
      `\n注意：${missingRule.length} 条记录无适用规则版本（${
        [...new Set(missingRule.map((r) => r.issue))].slice(0, 5).join(', ')
      } ...），可入库展示，但阶段 4 判奖时会转人工。`
    );
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), prepared.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(
    path.resolve(outPath).replace(/\.ndjson$/i, '.normalized.csv'),
    toDrawsCsv(prepared)
  );

  console.log(`\n✓ 已写入 ${outPath}（${prepared.length} 条，NDJSON，可直接在云开发控制台导入 draw_records）`);
  console.log(`✓ 同时导出规范化 CSV：${path.resolve(outPath).replace(/\.ndjson$/i, '.normalized.csv')}`);
}

main();
