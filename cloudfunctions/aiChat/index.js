/**
 * aiChat：DeepSeek 对话 + 只读工具编排。
 *
 * 安全边界：
 *   - API Key 只从云函数环境变量 DEEPSEEK_API_KEY 读取，永不落库、不回传前端。
 *   - 工具由服务端执行，身份取运行上下文；模型只能"请求查询"，不能直接动数据库。
 *   - 最多 3 轮工具调用、单轮 4 个、总量 8 个；单次请求 25s 超时；输出限 900 tokens。
 *   - 出错时返回可读错误码，不影响用户查看开奖与判奖结果。
 */
const https = require('https');

const { createHandler, cloud } = require('./shared/cloud/base');
const { buildSystemPrompt, SYSTEM_PROMPT_VERSION, FINALIZE_INSTRUCTION } = require('./shared/ai/prompt');
const { getToolSchemas } = require('./shared/ai/tools');
const { runToolLoop } = require('./shared/ai/orchestrator');
const { createExecutors } = require('./shared/cloud/aiTools');
const {
  ENDPOINT,
  LIMITS,
  isAcceptableModel,
  buildRequestBody,
  parseCompletion,
  mapHttpError,
  validateUserMessage,
} = require('./shared/ai/deepseek');

const CONVERSATIONS = 'ai_conversations';
const MESSAGES = 'ai_messages';
const DEFAULT_MODEL = 'deepseek-flash';

function postJson(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
          if (data.length > 2 * 1024 * 1024) {
            req.destroy();
            reject(new Error('响应过大'));
          }
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error('响应不是合法 JSON'));
            }
            return;
          }
          const mapped = mapHttpError(res.statusCode, data);
          const err = new Error(mapped.message);
          err.aiCode = mapped.code;
          err.status = res.statusCode;
          reject(err);
        });
      }
    );
    req.setTimeout(LIMITS.timeoutMs, () => {
      req.destroy();
      const err = new Error('AI 请求超时');
      err.aiCode = 'AI_TIMEOUT';
      reject(err);
    });
    req.on('error', (err) => {
      if (!err.aiCode) err.aiCode = 'AI_NETWORK';
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

exports.main = createHandler('aiChat', async ({ event, openid, config }) => {
  if (config.aiEnabled === false) {
    return { success: false, code: 'AI_DISABLED', message: 'AI 功能已在服务端关闭' };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      code: 'AI_NOT_CONFIGURED',
      message: '云端未配置 DEEPSEEK_API_KEY，AI 功能不可用（其他功能不受影响）',
    };
  }

  const model = isAcceptableModel(config.modelName) ? config.modelName : DEFAULT_MODEL;
  const checked = validateUserMessage(event.message);
  if (!checked.ok) {
    return { success: false, code: 'BAD_MESSAGE', message: checked.message };
  }

  const db = cloud.database();
  const now = new Date().toISOString();

  // 会话：没有就新建
  let sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null;
  if (sessionId) {
    const found = await db.collection(CONVERSATIONS).where({ _id: sessionId, ownerOpenId: openid }).limit(1).get();
    if (!(found.data && found.data[0])) sessionId = null;
  }
  if (!sessionId) {
    const created = await db.collection(CONVERSATIONS).add({
      data: {
        ownerOpenId: openid,
        title: checked.value.slice(0, 20),
        createdAt: now,
        updatedAt: now,
      },
    });
    sessionId = created._id;
  }

  // 历史消息（只取最近若干条，控制上下文成本）
  const historyRes = await db
    .collection(MESSAGES)
    .where({ sessionId, ownerOpenId: openid })
    .orderBy('createdAt', 'desc')
    .limit(LIMITS.historyMessages)
    .get();
  const history = (historyRes.data || []).slice().reverse();

  await db.collection(MESSAGES).add({
    data: { sessionId, ownerOpenId: openid, role: 'user', content: checked.value, createdAt: now },
  });

  const messages = [
    { role: 'system', content: buildSystemPrompt({ today: now.slice(0, 10) }) },
    ...history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: checked.value },
  ];

  const executors = createExecutors({ db, openid });
  const toolSchemas = getToolSchemas();

  let loopResult;
  try {
    loopResult = await runToolLoop({
      messages,
      toolSchemas,
      finalizeInstruction: FINALIZE_INSTRUCTION,
      callModel: async (convo, tools) => {
        const body = buildRequestBody({ model, messages: convo, tools });
        const raw = await postJson(ENDPOINT, body, apiKey);
        const parsed = parseCompletion(raw);
        if (!parsed.ok) {
          const err = new Error(parsed.message);
          err.aiCode = parsed.code;
          throw err;
        }
        return { content: parsed.content, toolCalls: parsed.toolCalls, usage: parsed.usage };
      },
      executeTool: (name, args) => executors.execute(name, args),
    });
  } catch (err) {
    const code = err.aiCode || 'AI_INTERNAL';
    // 失败也要留下用户消息，但不写助手消息，避免污染上下文
    return {
      success: false,
      code,
      message: err.message || 'AI 服务暂时不可用',
      data: { sessionId },
    };
  }

  const reply = (loopResult.finalText || '').slice(0, 4000);
  const toolSummary = loopResult.toolCalls.map((c) => ({ name: c.name, ok: c.ok }));

  await db.collection(MESSAGES).add({
    data: {
      sessionId,
      ownerOpenId: openid,
      role: 'assistant',
      content: reply,
      toolNames: toolSummary.map((t) => t.name),
      toolSummary,
      modelName: model,
      promptVersion: SYSTEM_PROMPT_VERSION,
      usage: loopResult.usage || null,
      rounds: loopResult.rounds,
      stoppedReason: loopResult.stoppedReason,
      createdAt: new Date().toISOString(),
    },
  });

  await db
    .collection(CONVERSATIONS)
    .doc(sessionId)
    .update({ data: { updatedAt: new Date().toISOString() } });

  return {
    sessionId,
    reply,
    model,
    toolCalls: toolSummary,
    rounds: loopResult.rounds,
    stoppedReason: loopResult.stoppedReason,
    usage: loopResult.usage || null,
    promptVersion: SYSTEM_PROMPT_VERSION,
  };
});
