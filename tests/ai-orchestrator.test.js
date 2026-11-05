/**
 * 工具调用编排测试：轮次上限、异常兜底、预算控制。
 * 用假模型驱动，不联网。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runToolLoop } = require('../shared/ai/orchestrator');

const SYSTEM = { role: 'system', content: 'test' };
const SCHEMAS = [{ type: 'function', function: { name: 'get_latest_draw', parameters: {} } }];

/** 按脚本依次返回预设响应 */
function scriptedModel(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async callModel(messages, tools) {
      calls.push({ messageCount: messages.length, tools: tools ? tools.length : null });
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof step === 'function' ? step(messages, tools) : step;
    },
  };
}

test('一轮工具调用后给出最终答复', async () => {
  const model = scriptedModel([
    { content: '', toolCalls: [{ id: 'c1', name: 'get_latest_draw', arguments: '{"game":"ssq"}' }] },
    { content: '最新一期是 2026126。', toolCalls: [] },
  ]);
  const toolResults = [];

  const out = await runToolLoop({
    messages: [SYSTEM, { role: 'user', content: '最新开奖' }],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async (name, args) => {
      toolResults.push({ name, args });
      return { ok: true, draw: { issue: '2026126' } };
    },
  });

  assert.equal(out.finalText, '最新一期是 2026126。');
  assert.equal(out.rounds, 2);
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].ok, true);
  assert.equal(toolResults[0].name, 'get_latest_draw');
  assert.equal(out.stoppedReason, null);
});

test('模型不调工具时直接返回，不发多余请求', async () => {
  const model = scriptedModel([{ content: '你好，我可以查开奖记录。', toolCalls: [] }]);
  const out = await runToolLoop({
    messages: [SYSTEM],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async () => ({ ok: true }),
  });
  assert.equal(out.rounds, 1);
  assert.equal(out.toolCalls.length, 0);
  assert.equal(model.calls.length, 1);
});

test('轮次用尽后不再带工具，请求一次总结', async () => {
  const model = scriptedModel([
    { content: '', toolCalls: [{ id: 'c1', name: 'get_latest_draw', arguments: '{"game":"ssq"}' }] },
    { content: '', toolCalls: [{ id: 'c2', name: 'get_latest_draw', arguments: '{"game":"ssq"}' }] },
    { content: '', toolCalls: [{ id: 'c3', name: 'get_latest_draw', arguments: '{"game":"ssq"}' }] },
    { content: '数据不足，请先同步。', toolCalls: [] },
  ]);

  const out = await runToolLoop({
    messages: [SYSTEM],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async () => ({ ok: true }),
    maxRounds: 3,
  });

  assert.equal(out.stoppedReason, 'TOOL_ROUND_LIMIT');
  assert.equal(out.finalText, '数据不足，请先同步。');
  assert.equal(model.calls.length, 4);
  assert.equal(model.calls[3].tools, null, '收尾请求不再提供工具');
});

test('工具执行抛错不影响对话，错误回传给模型', async () => {
  const model = scriptedModel([
    { content: '', toolCalls: [{ id: 'c1', name: 'get_latest_draw', arguments: '{}' }] },
    { content: '查询失败，请稍后重试。', toolCalls: [] },
  ]);

  const out = await runToolLoop({
    messages: [SYSTEM],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async () => {
      throw new Error('db down');
    },
  });

  assert.equal(out.toolCalls[0].ok, false);
  const toolMessage = out.messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /TOOL_ERROR/);
  assert.equal(out.finalText, '查询失败，请稍后重试。');
});

test('业务拒绝（ok:false）仍作为工具结果返回，不中断', async () => {
  const model = scriptedModel([
    { content: '', toolCalls: [{ id: 'c1', name: 'get_latest_draw', arguments: '{"game":"ssq"}' }] },
    { content: '本地还没有已核验数据。', toolCalls: [] },
  ]);

  const out = await runToolLoop({
    messages: [SYSTEM],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async () => ({ ok: false, code: 'NO_VERIFIED_DRAW', message: '暂无数据' }),
  });

  assert.equal(out.toolCalls[0].ok, false);
  assert.match(out.messages.find((m) => m.role === 'tool').content, /NO_VERIFIED_DRAW/);
});

test('单轮工具数被截断，总量预算生效', async () => {
  const manyCalls = {
    content: '',
    toolCalls: Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      name: 'get_latest_draw',
      arguments: '{"game":"ssq"}',
    })),
  };
  const model = scriptedModel([manyCalls, manyCalls, manyCalls, { content: 'ok', toolCalls: [] }]);
  let executed = 0;

  const out = await runToolLoop({
    messages: [SYSTEM],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async () => {
      executed += 1;
      return { ok: true };
    },
    maxRounds: 3,
    maxToolCallsPerRound: 4,
    maxTotalToolCalls: 5,
  });

  assert.ok(executed <= 5, `实际执行 ${executed} 次，超过预算`);
  assert.ok(out.messages.some((m) => typeof m.content === 'string' && m.content.includes('TOOL_BUDGET_EXCEEDED')));
});

test('assistant 的工具调用被规范成 function calling 结构', async () => {
  const model = scriptedModel([
    { content: null, toolCalls: [{ name: 'get_latest_draw', arguments: { game: 'ssq' } }] },
    { content: 'done', toolCalls: [] },
  ]);
  const out = await runToolLoop({
    messages: [SYSTEM],
    toolSchemas: SCHEMAS,
    callModel: model.callModel,
    executeTool: async () => ({ ok: true }),
  });
  const assistant = out.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'get_latest_draw');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"game":"ssq"}');
  assert.ok(assistant.tool_calls[0].id);
});
