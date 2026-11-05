#!/usr/bin/env node
/**
 * 提审前文案扫描：检查小程序前端是否出现预测类禁用词（见 docs/compliance-checklist.md 第 6 节）。
 * 用法：node scripts/check-copy.js
 * 跳过：含 "compliance-allow" 注释的行（仅用于禁用词清单自身等合理场景）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [path.join(ROOT, 'miniprogram')];
const SCAN_FILES = [path.join(ROOT, 'README.md')];
const EXT = new Set(['.js', '.json', '.wxml', '.wxss', '.md']);
const FORBIDDEN = ['预测', '稳中', '必中', '命中率', '提高中奖', '内部规律', '稳赚', '押注'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'shared' || e.name === 'node_modules') continue;
      walk(full, out);
    } else if (EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(d)), ...SCAN_FILES.filter((f) => fs.existsSync(f))];
const hits = [];

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('compliance-allow')) return;
    for (const word of FORBIDDEN) {
      if (line.includes(word)) {
        hits.push(`${path.relative(ROOT, file)}:${i + 1}  「${word}」  ${line.trim().slice(0, 80)}`);
      }
    }
  });
}

if (hits.length) {
  console.error('发现禁用词，提审前必须修改：');
  hits.forEach((h) => console.error('  ' + h));
  process.exit(1);
}
console.log(`文案扫描通过（${files.length} 个文件，未发现禁用词）`);
