#!/usr/bin/env node
/**
 * 把 CommonJS 的 shared/ 与 web/js/ 打成一个可直接 <script> 引入的 bundle。
 * 零依赖：自己实现模块注册表 + 相对路径解析。
 *
 * 用法：node scripts/build-web.js [--out web/dist/app.js]
 * 产物：web/dist/app.js（含入口 web/js/app.js 的执行）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'web/js/app.js';
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'web/dist/app.js');

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function toId(absFile) {
  return path.relative(ROOT, absFile).split(path.sep).join('/');
}

function resolveId(fromId, request) {
  const base = fromId.split('/').slice(0, -1);
  for (const part of request.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  let id = base.join('/');
  if (!id.endsWith('.js')) id += '.js';
  return id;
}

const collected = new Map();

function collect(id) {
  if (collected.has(id)) return;
  const abs = path.join(ROOT, id);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到模块: ${id}`);
  }
  const code = fs.readFileSync(abs, 'utf8');
  collected.set(id, code);

  REQUIRE_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRE_RE.exec(code))) {
    if (!m[1].startsWith('.')) continue; // 浏览器端不允许裸包名
    collect(resolveId(id, m[1]));
  }
}

function build() {
  collect(ENTRY);

  const parts = [];
  parts.push('/* 由 scripts/build-web.js 生成，请勿手改。源码：shared/ + web/js/ */');
  parts.push('(function(){');
  parts.push('"use strict";');
  parts.push('var __modules = {};');
  parts.push('var __cache = {};');
  parts.push(`function __define(id, factory){ __modules[id] = factory; }`);
  parts.push(`function __resolve(fromId, request){
  var base = fromId.split("/").slice(0, -1);
  var parts = request.split("/");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p === "" || p === ".") continue;
    if (p === "..") base.pop(); else base.push(p);
  }
  var id = base.join("/");
  if (id.slice(-3) !== ".js") id += ".js";
  return id;
}`);
  parts.push(`function __makeRequire(fromId){
  return function(request){
    var id = __resolve(fromId, request);
    if (__cache[id]) return __cache[id].exports;
    var factory = __modules[id];
    if (!factory) throw new Error("模块未打包: " + id + "（引用自 " + fromId + "）");
    var mod = { exports: {} };
    __cache[id] = mod;
    factory(mod, mod.exports, __makeRequire(id));
    return mod.exports;
  };
}`);

  for (const [id, code] of collected) {
    parts.push(`\n/* ===== ${id} ===== */`);
    parts.push(`__define(${JSON.stringify(id)}, function(module, exports, require){`);
    parts.push(code);
    parts.push('});');
  }

  parts.push(`\nvar __entry = __makeRequire("__bundle__");`);
  parts.push(`if (typeof window !== "undefined") { window.__JC = { require: __entry, modules: Object.keys(__modules) }; }`);
  parts.push(`__entry(${JSON.stringify(`./${ENTRY}`)});`);
  parts.push('})();');

  const bundle = parts.join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bundle);

  const sizeKb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
  console.log(`✓ 打包 ${collected.size} 个模块 → ${path.relative(ROOT, OUT)} (${sizeKb} KB)`);
  for (const id of collected.keys()) console.log(`  · ${id}`);
}

build();
