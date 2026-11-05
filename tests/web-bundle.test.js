/**
 * Web 打包产物测试：确保 bundle 能被浏览器环境执行，且共享逻辑原样可用。
 * 不启动真实浏览器，用一个最小 DOM 替身跑一遍植入过程。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.resolve(__dirname, '..', 'web', 'dist', 'app.js');

function createSandbox() {
  const elements = { app: { innerHTML: '', dataset: {} } };
  const document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById(id) {
      if (!elements[id]) elements[id] = { innerHTML: '', value: '', files: null, dataset: {} };
      return elements[id];
    },
    createElement() {
      return { href: '', download: '', click() {} };
    },
  };
  const sandbox = {
    window: {},
    document,
    console,
    setTimeout,
    fetch: async () => {
      throw new Error('测试环境不联网');
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: class {},
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Set,
    Map,
    Error,
    RegExp,
    parseInt,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, elements };
}

test('bundle 存在且语法可执行', async () => {
  assert.ok(fs.existsSync(BUNDLE), '请先运行 npm run build:web');
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const { sandbox, elements } = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 5000 });
  assert.ok(sandbox.__JC, '应挂载 window.__JC 便于调试');
  // boot 是异步的：等一个宏任务再断言首次渲染
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(elements.app.innerHTML.includes('竞彩助手'), '入口应完成首次渲染');
  assert.ok(elements.app.innerHTML.includes('我的号码'), '应渲染导航');
});

test('bundle 包含全部共享模块，且不含云函数依赖', () => {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  for (const id of [
    'shared/rules/judge.js',
    'shared/rules/registry.js',
    'shared/domain/tickets.js',
    'shared/validators/numbers.js',
    'shared/validators/draws.js',
    'shared/parsers/csv.js',
    'shared/adapters/cwl.js',
    'shared/constants/games.js',
  ]) {
    assert.ok(code.includes(id), `缺少模块 ${id}`);
  }
  assert.equal(code.includes('wx-server-sdk'), false, '静态站不能带云 SDK');
  assert.equal(code.includes('DEEPSEEK_API_KEY'), false, '静态站不能出现密钥名');
});

test('打包后的判奖逻辑与源码行为一致', () => {
  const { sandbox } = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { timeout: 5000 });

  const requireFromBundle = sandbox.__JC.require;
  const judge = requireFromBundle('./shared/rules/judge');
  const draw = {
    _id: 'd1',
    game: 'ssq',
    issue: '2026126',
    drawStatus: 'verified',
    rawHash: 'h',
    numbers: { red: [9, 10, 13, 22, 29, 32], blue: 12, kl8: [] },
    prizeInfo: { first: { count: 5, amount: 9014860 }, second: { count: 159, amount: 157816 } },
    specialRuleStatus: 'inactive',
  };
  const ticket = {
    _id: 't1',
    game: 'ssq',
    issue: '2026126',
    purchaseStatus: 'confirmed',
    multiple: 1,
    numbers: { red: [9, 10, 13, 22, 29, 32], blue: 12, kl8: [] },
  };
  const res = judge.judgeTicket(ticket, draw);
  assert.equal(res.checkStatus, 'checked');
  assert.equal(res.prizeLevel, '1');
  assert.equal(res.totalPrize, 9014860);
});

test('打包后的号码校验与源码一致', () => {
  const { sandbox } = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { timeout: 5000 });

  const numbers = sandbox.__JC.require('./shared/validators/numbers');
  assert.equal(numbers.validateNumbers('ssq', { red: [1, 2, 3], blue: 1 }).ok, false);
  assert.equal(numbers.validateNumbers('ssq', { red: [1, 2, 3, 4, 5, 6], blue: 7 }).ok, true);
  assert.equal(numbers.formatDisplay('ssq', { red: [1, 2, 3, 4, 5, 6], blue: 7 }), '01 02 03 04 05 06 | 07');
});
