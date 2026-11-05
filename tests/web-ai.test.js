/**
 * Web 版 AI 测试：Key 只存本地、工具走本地数据、错误分型、不泄露 Key。
 * 用假 fetch 驱动，不联网。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createAi, KEY_STORAGE } = require('../web/js/ai');

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function fakeStore(seed = {}) {
  const data = { draws: [], tickets: [], checks: [], meta: [], ...seed };
  return {
    async getAll(name) {
      return (data[name] || []).slice();
    },
    _data: data,
  };
}

const SSQ_DRAW = {
  id: 'ssq:2026126',
  game: 'ssq',
  issue: '2026126',
  drawDate: '2026-11-03',
  drawStatus: 'verified',
  numbers: { red: [9, 10, 13, 22, 29, 32], blue: 12, kl8: [] },
  prizeInfo: { first: { count: 5, amount: 9014860 } },
  ruleVersion: 'ssq_2026_02_01',
};

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

const REPLY = (text) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { total_tokens: 90 },
});

const TOOL_CALL = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_latest_draw', arguments: '{"game":"ssq"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
};

test('没有 Key 时直接拒绝，不发请求', async () => {
  const calls = [];
  const ai = createAi({
    store: fakeStore(),
    storage: fakeStorage(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return okResponse(REPLY('x'));
    },
  });
  await assert.rejects(() => ai.chat({ message: '你好' }), (err) => err.code === 'AI_NO_KEY');
  assert.equal(calls.length, 0);
});

test('Key 太短被拒绝；合法 Key 只写入本地存储', () => {
  const storage = fakeStorage();
  const ai = createAi({ store: fakeStore(), storage, fetchImpl: async () => okResponse(REPLY('x')) });
  assert.throws(() => ai.setKey('short'), (err) => err.code === 'BAD_KEY');
  ai.setKey('  sk-0123456789abcdef0123456789abcdef  ');
  assert.equal(storage.getItem(KEY_STORAGE), 'sk-0123456789abcdef0123456789abcdef', '首尾空白应被裁剪');
  assert.equal(ai.hasKey(), true);
  ai.clearKey();
  assert.equal(ai.hasKey(), false);
});

test('一次工具调用后作答，且请求带 Authorization 与工具定义', async () => {
  const calls = [];
  const queue = [okResponse(TOOL_CALL), okResponse(REPLY('最新一期是 2026126，红球 09 10 13 22 29 32，蓝球 12。'))];

  const ai = createAi({
    store: fakeStore({ draws: [SSQ_DRAW] }),
    storage: fakeStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return queue.shift();
    },
  });
  ai.setKey('sk-test-0123456789abcdef0123456789');

  const out = await ai.chat({ message: '最新一期双色球开奖号码' });
  assert.match(out.reply, /2026126/);
  assert.deepEqual(out.toolCalls, [{ name: 'get_latest_draw', ok: true }]);
  assert.equal(calls.length, 2);

  const first = calls[0];
  assert.equal(first.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.headers.Authorization, 'Bearer sk-test-0123456789abcdef0123456789');

  const body = JSON.parse(first.init.body);
  assert.ok(Array.isArray(body.tools) && body.tools.length === 7, '应下发 7 个只读工具');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.model, 'deepseek-flash');

  // 第二次请求必须带上工具结果，模型才能据此作答
  const second = JSON.parse(calls[1].init.body);
  assert.ok(
    second.messages.some((m) => m.role === 'tool' && m.content.includes('2026126')),
    '工具结果应回填给模型'
  );
});

test('工具真的查到了本地数据（localdb 适配正确）', async () => {
  const calls = [];
  const queue = [okResponse(TOOL_CALL), okResponse(REPLY('ok'))];
  const ai = createAi({
    store: fakeStore({ draws: [SSQ_DRAW] }),
    storage: fakeStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return queue.shift();
    },
  });
  ai.setKey('sk-test-0123456789abcdef0123456789');
  await ai.chat({ message: '开奖' });

  const second = JSON.parse(calls[1].init.body);
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.ok, true);
  assert.equal(payload.draw.issue, '2026126');
  assert.equal(payload.draw.prizeInfo.first.amount, 9014860);
});

test('401 统一为 AI_AUTH_FAILED，且错误里不含 Key', async () => {
  const key = 'sk-secret-0123456789abcdef0123456';
  const ai = createAi({
    store: fakeStore(),
    storage: fakeStorage(),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return '{"error":{"message":"invalid api key"}}';
      },
      async json() {
        return {};
      },
    }),
  });
  ai.setKey(key);
  await assert.rejects(
    () => ai.chat({ message: '你好' }),
    (err) => {
      assert.equal(err.code, 'AI_AUTH_FAILED');
      assert.equal(err.message.includes(key), false, '错误信息不得包含 Key');
      assert.equal(err.message.includes('invalid api key'), false, '不得回传上游原文');
      return true;
    }
  );
});

test('verifyKey：可用时返回模型名，缺 Key 时给出可读原因', async () => {
  const storage = fakeStorage();
  const ai = createAi({ store: fakeStore(), storage, fetchImpl: async () => okResponse(REPLY('ok')) });
  const noKey = await ai.verifyKey();
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'AI_NO_KEY');

  ai.setKey('sk-0123456789abcdef0123456789abcdef');
  const ok = await ai.verifyKey();
  assert.equal(ok.ok, true);
  assert.equal(ok.model, 'deepseek-flash');
});

test('网络异常映射为 AI_NETWORK，不抛出原始错误', async () => {
  const ai = createAi({
    store: fakeStore(),
    storage: fakeStorage(),
    fetchImpl: async () => {
      throw new Error('Failed to fetch');
    },
  });
  ai.setKey('sk-0123456789abcdef0123456789abcdef');
  await assert.rejects(() => ai.chat({ message: '你好' }), (err) => err.code === 'AI_NETWORK');
});

test('空消息被拒绝', async () => {
  const ai = createAi({ store: fakeStore(), storage: fakeStorage(), fetchImpl: async () => okResponse(REPLY('x')) });
  ai.setKey('sk-0123456789abcdef0123456789abcdef');
  await assert.rejects(() => ai.chat({ message: '   ' }), (err) => err.code === 'BAD_MESSAGE');
});

test('模型名可配置但只接受 deepseek-* 形式', () => {
  const storage = fakeStorage();
  const ai = createAi({ store: fakeStore(), storage, fetchImpl: async () => okResponse(REPLY('x')) });
  assert.equal(ai.getModel(), 'deepseek-flash');
  ai.setModel('gpt-4o');
  assert.equal(ai.getModel(), 'deepseek-flash', '非法模型名回落到默认');
  ai.setModel('deepseek-v4-pro');
  assert.equal(ai.getModel(), 'deepseek-v4-pro');
});
