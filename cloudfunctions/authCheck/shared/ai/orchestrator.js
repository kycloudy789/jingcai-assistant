/**
 * 工具调用编排（纯逻辑，不碰网络/数据库，便于用假模型测试）。
 *
 * 约束：
 *   - 最多 maxRounds 轮模型调用；每轮最多执行 maxToolCallsPerRound 个工具；总量上限 maxTotalToolCalls。
 *   - 工具名与参数由 shared/ai/tools.js 校验；执行异常不抛出，转成工具结果回给模型。
 *   - 轮次用尽后再请求一次（不带工具）拿最终答复，避免用户收到空回复。
 */

const DEFAULT_LIMITS = { maxRounds: 3, maxToolCallsPerRound: 4, maxTotalToolCalls: 8 };

/**
 * @param {object} options
 * @param {Array} options.messages 初始消息（含 system）
 * @param {Array} options.toolSchemas 工具 schema 列表
 * @param {(messages:Array, tools:Array|null) => Promise<{content?:string, toolCalls?:Array, usage?:object}>} options.callModel
 * @param {(name:string, args:any) => Promise<object>} options.executeTool 返回可 JSON 化的对象；约定 ok:false 表示业务拒绝
 * @param {string} [options.finalizeInstruction]
 */
async function runToolLoop(options) {
  const {
    messages,
    toolSchemas,
    callModel,
    executeTool,
    maxRounds = DEFAULT_LIMITS.maxRounds,
    maxToolCallsPerRound = DEFAULT_LIMITS.maxToolCallsPerRound,
    maxTotalToolCalls = DEFAULT_LIMITS.maxTotalToolCalls,
    finalizeInstruction = '已达到工具调用上限，请仅基于已获得的数据作答。',
  } = options;

  const convo = (messages || []).slice();
  const executed = [];
  let rounds = 0;
  let usage = null;

  for (let round = 0; round < maxRounds; round += 1) {
    rounds += 1;
    const res = (await callModel(convo, toolSchemas)) || {};
    usage = res.usage || usage;
    const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];

    if (calls.length === 0) {
      const finalText = typeof res.content === 'string' ? res.content : '';
      convo.push({ role: 'assistant', content: finalText });
      return {
        ok: true,
        finalText,
        messages: convo,
        toolCalls: executed,
        rounds,
        stoppedReason: null,
        usage,
      };
    }

    convo.push({
      role: 'assistant',
      content: typeof res.content === 'string' ? res.content : '',
      tool_calls: calls.map((c) => ({
        id: c.id || `call_${executed.length}_${c.name}`,
        type: 'function',
        function: {
          name: c.name,
          arguments:
            typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}),
        },
      })),
    });

    for (const call of calls.slice(0, maxToolCallsPerRound)) {
      if (executed.length >= maxTotalToolCalls) {
        convo.push({
          role: 'tool',
          tool_call_id: call.id || `call_${executed.length}_${call.name}`,
          content: JSON.stringify({ ok: false, code: 'TOOL_BUDGET_EXCEEDED', message: '本次对话工具调用次数已达上限' }),
        });
        continue;
      }

      let payload;
      try {
        const out = await executeTool(call.name, call.arguments);
        payload = out && typeof out === 'object' ? out : { ok: true, data: out };
      } catch (err) {
        payload = { ok: false, code: 'TOOL_ERROR', message: String((err && err.message) || err).slice(0, 200) };
      }

      executed.push({ name: call.name, args: call.arguments, ok: payload.ok !== false });
      convo.push({
        role: 'tool',
        tool_call_id: call.id || `call_${executed.length}_${call.name}`,
        content: JSON.stringify(payload),
      });
    }
  }

  // 轮次用尽：不带工具再要一次总结
  convo.push({ role: 'system', content: finalizeInstruction });
  const last = (await callModel(convo, null)) || {};
  const finalText = typeof last.content === 'string' ? last.content : '';
  convo.push({ role: 'assistant', content: finalText });

  return {
    ok: true,
    finalText,
    messages: convo,
    toolCalls: executed,
    rounds: rounds + 1,
    stoppedReason: 'TOOL_ROUND_LIMIT',
    usage: last.usage || usage,
  };
}

module.exports = { runToolLoop, DEFAULT_LIMITS };
