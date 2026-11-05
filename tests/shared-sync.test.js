/**
 * 共享代码一致性测试（decisions.md D2）
 * 目的：防止改了 shared/ 却忘记同步，导致前端与云函数逻辑分叉。
 * 规则：shared/cloud/** 只属于云函数（依赖 wx-server-sdk），不得进入小程序包。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shared');
const CLOUD_ONLY = new Set(['cloud']);

const isCloudOnly = (rel) => CLOUD_ONLY.has(rel.split(path.sep)[0]);

function listFiles(dir, filter = () => true, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return listFiles(full, filter, base);
      const rel = path.relative(base, full);
      return filter(rel) ? [rel] : [];
    })
    .sort();
}

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const cloudFns = fs
  .readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name);

test('小程序端同步的是「非云专用」共享模块', () => {
  const target = path.join(ROOT, 'miniprogram', 'shared');
  const expected = listFiles(SRC).filter((rel) => !isCloudOnly(rel));
  const actual = listFiles(target);
  assert.deepEqual(actual, expected, '请执行 npm run sync:shared');
  for (const rel of expected) {
    assert.equal(hash(path.join(target, rel)), hash(path.join(SRC, rel)), `${rel} 内容不一致`);
  }
});

test('小程序端不包含依赖 wx-server-sdk 的云专用模块', () => {
  const target = path.join(ROOT, 'miniprogram', 'shared');
  assert.equal(fs.existsSync(path.join(target, 'cloud')), false);

  const leaked = listFiles(path.join(ROOT, 'miniprogram')).filter((rel) => rel.endsWith('.js'));
  for (const rel of leaked) {
    const content = fs.readFileSync(path.join(ROOT, 'miniprogram', rel), 'utf8');
    assert.ok(!content.includes('wx-server-sdk'), `小程序包内出现 wx-server-sdk 引用: ${rel}`);
  }
});

for (const fn of cloudFns) {
  test(`云函数 shared 已同步: ${fn}`, () => {
    const target = path.join(ROOT, 'cloudfunctions', fn, 'shared');
    const expected = listFiles(SRC);
    assert.deepEqual(listFiles(target), expected, `请执行 npm run sync:shared (${fn})`);
    for (const rel of expected) {
      assert.equal(hash(path.join(target, rel)), hash(path.join(SRC, rel)), `${fn}/${rel} 内容不一致`);
    }
  });
}

test('小程序端引用的 shared 路径均存在', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.js'), 'utf8');
  const match = appJs.match(/require\('\.\/shared\/([^']+)'\)/);
  assert.ok(match, 'app.js 应引用 ./shared/...');
  const rel = match[1].endsWith('.js') ? match[1] : `${match[1]}.js`;
  assert.ok(fs.existsSync(path.join(ROOT, 'miniprogram', 'shared', rel)), `缺少 miniprogram/shared/${rel}`);
});
