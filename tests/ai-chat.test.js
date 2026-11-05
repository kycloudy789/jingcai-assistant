/**
 * aiChat 云函数测试（假 CloudBase + 假 https）：
 * 密钥缺失降级、AI 关闭、正常对话、工具调用、上游错误映射、会话归属。
 */
const test = require('node:test');
const { SYSTEM_PROMPT_VERSION } = require('../shared/ai/prompt');
const assert = require('node:assert/strict');

const { createFakeCloud, installFakeModule, createFakeHttps } = require('./helpers/fake-cloud');

const fake = createFakeCloud();
const https = createFakeHttps([]);
const restore = installFakeModule({ 'wx-server-sdk': fake.sdk, https: https.module });

const aiChat = require('../cloudfunctions/aiChat/index.js');

const REPLY = (text) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });

const TOOL_CALL = JSON.stringify({
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_latest_draw', arguments: '{"game":"ssq"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { total_tokens: 50 },
});

test.before(() => {
  fake.setOpenId('oOWNER');
  fake.seed('app_config', [
    { _id: 'global', ownerWhitelist: ['oOWNER'], aiEnabled: true, modelName: 'deepseek-flash' },
  ]);
  fake.seed('draw_records', [
    {
      _id: 'd1',
      game: 'ssq',
      issue: '2026126',
      drawDate: '2026-11-03',
      drawStatus: 'verified',
      numbers: { red: [9, 10, 13, 22, 29, 32], blue: 12, kl8: [] },
      prizeInfo: { first: { count: 5, amount: 9014860 } },
      ruleVersion: 'ssq_2026_02_01',
    },
  ]);
});

test.after(() => {
  delete process.env.DEEPSEEK_API_KEY;
  restore();
});

test('未配置密钥时降级为可读提示，不影响其他功能', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const res = await aiChat.main({ message: '最新开奖是多少' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'AI_NOT_CONFIGURED');
});

test('服务端关闭 AI 时直接拒绝', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  fake.seed('app_config', [
    { _id: 'global', ownerWhitelist: ['oOWNER'], aiEnabled: false, modelName: 'deepseek-flash' },
  ]);
  const res = await aiChat.main({ message: '你好' });
  assert.equal(res.code, 'AI_DISABLED');

  fake.seed('app_config', [
    { _id: 'global', ownerWhitelist: ['oOWNER'], aiEnabled: true, modelName: 'deepseek-flash' },
  ]);
});

test('普通问答：返回回复并落库两条消息', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  https.calls.length = 0;
  const local = createFakeHttps([{ status: 200, body: REPLY('你好，我可以查已核验的开奖数据。') }]);
  const restoreLocal = installFakeModule({ https: local.module });
  delete require.cache[require.resolve('../cloudfunctions/aiChat/index.js')];
  const fn = require('../cloudfunctions/aiChat/index.js');
  restoreLocal();

  const before = fake.rows('ai_messages').length;
  const res = await fn.main({ message: '你好' });

  assert.equal(res.success, true);
  assert.equal(res.data.reply, '你好，我可以查已核验的开奖数据。');
  assert.ok(res.data.sessionId);
  assert.equal(res.data.model, 'deepseek-flash');
  assert.equal(res.data.promptVersion, SYSTEM_PROMPT_VERSION);
  assert.equal(fake.rows('ai_messages').length, before + 2);

  const userMsg = fake.rows('ai_messages').find((m) => m.role === 'user' && m.content === '你好');
  assert.ok(userMsg);
  const assistantMsg = fake.rows('ai_messages').find((m) => m.role === 'assistant');
  assert.equal(assistantMsg.promptVersion, SYSTEM_PROMPT_VERSION);
});

test('工具调用：模型请求查开奖，服务端执行后作答', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const local = createFakeHttps([
    { status: 200, body: TOOL_CALL },
    { status: 200, body: REPLY('最新一期是 2026126，红球 09 10 13 22 29 32，蓝球 12。') },
  ]);
  const restoreLocal = installFakeModule({ https: local.module });
  delete require.cache[require.resolve('../cloudfunctions/aiChat/index.js')];
  const fn = require('../cloudfunctions/aiChat/index.js');
  restoreLocal();

  const res = await fn.main({ message: '最新一期双色球开奖号码' });
  assert.equal(res.success, true);
  assert.equal(res.data.toolCalls.length, 1);
  assert.equal(res.data.toolCalls[0].name, 'get_latest_draw');
  assert.equal(res.data.toolCalls[0].ok, true);
  assert.match(res.data.reply, /2026126/);
  assert.equal(local.calls.length, 2, '一次工具调用 + 一次作答');

  const secondBody = JSON.parse(local.calls[1].body);
  assert.ok(
    secondBody.messages.some((m) => m.role === 'tool' && m.content.includes('2026126')),
    '工具结果必须回填给模型'
  );
});

test('上游 401 → 统一为 AI_AUTH_FAILED，不泄露响应体', async () => {
  process.env.DEEPSEEK_API_KEY = 'bad-key';
  const local = createFakeHttps([{ status: 401, body: '{"error":{"message":"invalid api key"}}' }]);
  const restoreLocal = installFakeModule({ https: local.module });
  delete require.cache[require.resolve('../cloudfunctions/aiChat/index.js')];
  const fn = require('../cloudfunctions/aiChat/index.js');
  restoreLocal();

  const res = await fn.main({ message: '你好' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'AI_AUTH_FAILED');
  assert.ok(!JSON.stringify(res).includes('invalid api key'));
});

test('输入过长被拒绝，不消耗模型调用', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const res = await aiChat.main({ message: 'x'.repeat(1001) });
  assert.equal(res.success, false);
  assert.equal(res.code, 'BAD_MESSAGE');
});

test('空消息被拒绝', async () => {
  const res = await aiChat.main({ message: '   ' });
  assert.equal(res.code, 'BAD_MESSAGE');
});

test('会话归属：拿别人的 sessionId 会新建自己的会话', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  fake.seed('ai_conversations', [
    { _id: 'sess_other', ownerOpenId: 'oOTHER', title: 'x', createdAt: '2026-11-05T00:00:00.000Z' },
  ]);
  const local = createFakeHttps([{ status: 200, body: REPLY('好的') }]);
  const restoreLocal = installFakeModule({ https: local.module });
  delete require.cache[require.resolve('../cloudfunctions/aiChat/index.js')];
  const fn = require('../cloudfunctions/aiChat/index.js');
  restoreLocal();

  const res = await fn.main({ message: '继续', sessionId: 'sess_other' });
  assert.equal(res.success, true);
  assert.notEqual(res.data.sessionId, 'sess_other');
});
