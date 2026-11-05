#!/usr/bin/env node
/**
 * 写入小程序 AppID 到 project.config.json。
 * 用法：node scripts/set-appid.js wx1234567890abcdef
 * 说明：AppID 不是密钥，但仍建议只放本地配置；如需入库请自行确认仓库可见性。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'project.config.json');
const arg = process.argv[2];

if (!arg) {
  const current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  console.log(`当前 AppID: ${current.appid}`);
  console.log('用法: node scripts/set-appid.js <你的AppID>');
  process.exit(0);
}

if (!/^wx[0-9a-f]{16}$/.test(arg)) {
  console.error('✗ AppID 格式不对。应为 wx 开头 + 16 位小写十六进制，例如 wx0123456789abcdef');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const before = config.appid;
config.appid = arg;
fs.writeFileSync(FILE, `${JSON.stringify(config, null, 2)}\n`);
console.log(`✓ AppID 已更新: ${before} → ${arg}`);
console.log('  接着在微信开发者工具中重新导入/刷新项目即可使用云开发。');
