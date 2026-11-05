#!/usr/bin/env node
/**
 * 将 shared/ 同步到小程序端与每个云函数目录（见 docs/decisions.md D2）。
 * 用法：node scripts/sync-shared.js [--verify]
 *   --verify 只比对不写入，不一致时以退出码 1 结束（供测试使用）。
 *
 * 规则：shared/cloud/** 只同步到云函数（依赖 wx-server-sdk，不能进小程序包）；
 *       其余共享模块两端都要同步。
 * 零依赖，仅用 Node 内置模块。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shared');
const CLOUD_DIR = path.join(ROOT, 'cloudfunctions');
const MINIPROGRAM_TARGET = path.join(ROOT, 'miniprogram', 'shared');
const CLOUD_ONLY = new Set(['cloud']);

function isCloudOnly(relPath) {
  return CLOUD_ONLY.has(relPath.split(/[\\/]/)[0]);
}

function listFiles(dir, base = dir, filter = null) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base, filter));
    else {
      const rel = path.relative(base, full);
      if (!filter || filter(rel)) out.push(rel);
    }
  }
  return out.sort();
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

function copyTree(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const t = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(SRC, s);
      if (filter && !filter(`${rel}${path.sep}x`)) continue;
      copyTree(s, t, filter);
    } else if (!filter || filter(path.relative(SRC, s))) {
      fs.copyFileSync(s, t);
    }
  }
}

function prune(target, expected, filter) {
  for (const rel of listFiles(target)) {
    if (expected.includes(rel)) continue;
    if (filter && !filter(rel)) continue;
    fs.unlinkSync(path.join(target, rel));
    console.log(`[sync-shared] - 移除多余文件 ${path.relative(ROOT, path.join(target, rel))}`);
  }
}

function main() {
  const verify = process.argv.includes('--verify');

  const cloudDirNames = fs.existsSync(CLOUD_DIR)
    ? fs.readdirSync(CLOUD_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
        .map((d) => d.name)
    : [];

  const targets = [
    { dir: MINIPROGRAM_TARGET, include: (rel) => !isCloudOnly(rel) },
    ...cloudDirNames.map((name) => ({
      dir: path.join(CLOUD_DIR, name, 'shared'),
      include: () => true,
    })),
  ];

  let drift = 0;
  for (const { dir, include } of targets) {
    const rel = path.relative(ROOT, dir);
    const srcFiles = listFiles(SRC, SRC, include);

    if (verify) {
      const tFiles = listFiles(dir);
      const expected = srcFiles;
      const missing = expected.filter((f) => !tFiles.includes(f));
      const changed = expected.filter(
        (f) => tFiles.includes(f) && hash(path.join(SRC, f)) !== hash(path.join(dir, f))
      );
      const extra = tFiles.filter((f) => !expected.includes(f));
      if (missing.length || changed.length || extra.length) {
        drift += 1;
        console.error(`[sync-shared] ✗ ${rel}`);
        if (missing.length) console.error(`  缺失: ${missing.join(', ')}`);
        if (changed.length) console.error(`  不一致: ${changed.join(', ')}`);
        if (extra.length) console.error(`  多余: ${extra.join(', ')}`);
      } else {
        console.log(`[sync-shared] ✓ ${rel}`);
      }
    } else {
      copyTree(SRC, dir, include);
      prune(dir, srcFiles, include);
      console.log(`[sync-shared] → ${rel} (${srcFiles.length} 个文件)`);
    }
  }

  if (verify && drift > 0) {
    console.error('\n[sync-shared] 共享代码未同步，请执行: npm run sync:shared');
    process.exit(1);
  }
  if (!verify) console.log('[sync-shared] 完成');
}

main();
