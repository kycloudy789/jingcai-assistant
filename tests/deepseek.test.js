/**
 * DeepSeek 报文解析测试：模型输出与错误码归一化。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAcceptableModel,
  buildRequestBody,
  parseCompletion,
  mapHttpError,
  validateUserMessage,
  LIMITS,
} = require('../shared/ai/deepseek');

test('正常回复解析出内容与用量', () => {
  const r = parseCompletion({
    choices: [{ message: { content: '最新一期 2026126' }, finish_reason: 'stop' }],
    usage: { total_tokens: 120 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.content, '最新一期 2026126');
  assert.equal(r.usage.total_tokens, 120);
  assert.deepEqual(r.toolCalls, []);
});

test('工具调用被归一化为 {id,name,arguments}', () => {
  const r = parseCompletion({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'c1', function: { name: 'get_latest_draw', arguments: '{"game":"ssq"}' } },
            { function: { name: 'get_draws', arguments: '{}' } },
          ],
        },
      },
    ],
  });
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].name, 'get_latest_draw');
  assert.equal(r.toolCalls[0].arguments, '{"game":"ssq"}');
  assert.ok(r.toolCalls[1].id, '缺失 id 时自动补');
});

test('空 choices 与错误体都被识别为失败', () => {
  assert.equal(parseCompletion({ choices: [] }).code, 'EMPTY_CHOICES');
  assert.equal(parseCompletion({ error: { message: 'overloaded' } }).code, 'UPSTREAM_ERROR');
  assert.equal(parseCompletion(null).code, 'BAD_RESPONSE');
});

test('HTTP 状态映射为可读错误码', () => {
  assert.equal(mapHttpError(401, '').code, 'AI_AUTH_FAILED');
  assert.equal(mapHttpError(403, '').code, 'AI_AUTH_FAILED');
  assert.equal(mapHttpError(402, '').code, 'AI_QUOTA');
  assert.equal(mapHttpError(429, '').code, 'AI_RATE_LIMIT');
  assert.equal(mapHttpError(503, '').code, 'AI_UPSTREAM');
  assert.equal(mapHttpError(400, 'bad model').code, 'AI_BAD_REQUEST');
});

test('输入长度：空串拒绝、上限拒绝、正常通过', () => {
  assert.equal(validateUserMessage('').ok, false);
  assert.equal(validateUserMessage('  ').ok, false);
  assert.equal(validateUserMessage(123).ok, false);
  assert.equal(validateUserMessage('x'.repeat(LIMITS.maxInputChars + 1)).ok, false);
  const ok = validateUserMessage('  最新开奖  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, '最新开奖', '首尾空白被裁剪');
});

test('模型名只接受 deepseek-* 形式', () => {
  assert.equal(isAcceptableModel('deepseek-flash'), true);
  assert.equal(isAcceptableModel('deepseek-v4-pro'), true);
  assert.equal(isAcceptableModel('gpt-4o'), false);
  assert.equal(isAcceptableModel(''), false);
  assert.equal(isAcceptableModel('deepseek-'), false);
});

test('请求体：无工具时不带 tools 字段，有工具时 tool_choice=auto', () => {
  const plain = buildRequestBody({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plain.tools, undefined);
  assert.equal(plain.stream, false);
  assert.equal(plain.max_tokens, LIMITS.maxOutputTokens);

  const withTools = buildRequestBody({
    model: 'deepseek-flash',
    messages: [],
    tools: [{ type: 'function', function: { name: 'x' } }],
  });
  assert.equal(withTools.tools.length, 1);
  assert.equal(withTools.tool_choice, 'auto');
});
