/**
 * Web 版 AI：浏览器直连 DeepSeek，Key 由用户自己在设置里填，只存本机。
 *
 * 复用关系（不复制任何判定逻辑）：
 *   - 提示词：shared/ai/prompt.js
 *   - 工具白名单与参数校验：shared/ai/tools.js
 *   - 工具执行器：shared/cloud/aiTools.js（通过 localdb 适配本地存储）
 *   - 调用编排：shared/ai/orchestrator.js
 *
 * 安全边界：Key 存在 localStorage，同源脚本与浏览器扩展理论上可读，
 * 因此界面必须明确告知，并提供「清除密钥」。绝不把 Key 写进任何提交里的文件。
 */

const { buildSystemPrompt, FINALIZE_INSTRUCTION, SYSTEM_PROMPT_VERSION } = require('../../shared/ai/prompt');
const { getToolSchemas } = require('../../shared/ai/tools');
const { runToolLoop } = require('../../shared/ai/orchestrator');
const { createExecutors } = require('../../shared/cloud/aiTools');
const {
  ENDPOINT,
  LIMITS,
  isAcceptableModel,
  buildRequestBody,
  parseCompletion,
  mapHttpError,
  validateUserMessage,
} = require('../../shared/ai/deepseek');
const { createLocalDb } = require('./localdb');

const KEY_STORAGE = 'jc:deepseek_key';
const MODEL_STORAGE = 'jc:deepseek_model';
const DEFAULT_MODEL = 'deepseek-flash';

function createAi(options = {}) {
  const {
    store,
    getGate = null,
    saveBatch = null,
    fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = options;

  function readRaw(key) {
    if (!storage) return '';
    try {
      return storage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  function writeRaw(key, value) {
    if (!storage) throw Object.assign(new Error('当前浏览器禁止本地存储，无法保存密钥'), { code: 'NO_STORAGE' });
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch (err) {
      throw Object.assign(new Error('写入本地存储失败（可能是隐私模式）'), { code: 'NO_STORAGE' });
    }
  }

  const getKey = () => readRaw(KEY_STORAGE).trim();
  const hasKey = () => getKey().length > 0;

  function setKey(raw) {
    const key = String(raw || '').trim();
    if (key.length < 20) {
      throw Object.assign(new Error('密钥看起来太短，请检查是否复制完整'), { code: 'BAD_KEY' });
    }
    writeRaw(KEY_STORAGE, key);
    return key;
  }

  const clearKey = () => writeRaw(KEY_STORAGE, null);

  function getModel() {
    const saved = readRaw(MODEL_STORAGE);
    return isAcceptableModel(saved) ? saved : DEFAULT_MODEL;
  }

  function setModel(name) {
    writeRaw(MODEL_STORAGE, isAcceptableModel(name) ? name : DEFAULT_MODEL);
  }

  async function callModel(messages, tools) {
    const key = getKey();
    if (!key) {
      throw Object.assign(new Error('还没有填写 DeepSeek 密钥'), { code: 'AI_NO_KEY' });
    }
    if (!fetchImpl) {
      throw Object.assign(new Error('当前环境不支持网络请求'), { code: 'AI_NO_FETCH' });
    }

    const body = buildRequestBody({ model: getModel(), messages, tools });
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw Object.assign(new Error('网络请求失败（可能是网络或跨域限制）'), { code: 'AI_NETWORK' });
    }

    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        text = '';
      }
      const mapped = mapHttpError(res.status, text);
      throw Object.assign(new Error(mapped.message), { code: mapped.code });
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      throw Object.assign(new Error('AI 返回不是合法 JSON'), { code: 'BAD_RESPONSE' });
    }

    const parsed = parseCompletion(payload);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.message), { code: parsed.code });
    }
    return { content: parsed.content, toolCalls: parsed.toolCalls, usage: parsed.usage };
  }

  /**
   * @param {{history?: Array, message: string}} input
   */
  async function chat(input) {
    const checked = validateUserMessage(input && input.message);
    if (!checked.ok) {
      throw Object.assign(new Error(checked.message), { code: 'BAD_MESSAGE' });
    }
    if (!hasKey()) {
      throw Object.assign(new Error('还没有填写 DeepSeek 密钥，请先在下方粘贴并保存'), { code: 'AI_NO_KEY' });
    }

    // 闸门状态每次都现读：用户刚在「选号」页关掉，下一步对话就必须拿不到生成工具
    let gate = null;
    try {
      gate = getGate ? await getGate() : null;
    } catch (err) {
      gate = null;
    }
    const futureNumbers = !!(gate && gate.aiFutureNumber);

    const history = Array.isArray(input.history) ? input.history.slice(-LIMITS.historyMessages) : [];
    const messages = [
      { role: 'system', content: buildSystemPrompt({ futureNumbers }) },
      ...history
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
        .map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: checked.value },
    ];

    const executors = createExecutors({
      db: createLocalDb(store),
      openid: 'local',
      gate: { futureNumbers, complianceState: gate ? gate.complianceState : null },
      saveBatch,
    });
    const out = await runToolLoop({
      messages,
      toolSchemas: getToolSchemas({ futureNumbers }),
      callModel,
      executeTool: (name, args) => executors.execute(name, args),
      finalizeInstruction: FINALIZE_INSTRUCTION,
    });

    return {
      reply: (out.finalText || '').slice(0, 4000),
      toolCalls: out.toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
      rounds: out.rounds,
      stoppedReason: out.stoppedReason,
      usage: out.usage || null,
      promptVersion: SYSTEM_PROMPT_VERSION,
    };
  }

  /** 用一条极短的请求验证密钥是否可用 */
  async function verifyKey() {
    if (!hasKey()) {
      return { ok: false, code: 'AI_NO_KEY', message: '还没有填写密钥' };
    }
    try {
      const res = await callModel(
        [
          { role: 'system', content: '只回复"ok"两个字符。' },
          { role: 'user', content: 'ping' },
        ],
        null
      );
      return { ok: true, reply: (res.content || '').slice(0, 20), model: getModel() };
    } catch (err) {
      return { ok: false, code: err.code || 'AI_ERROR', message: err.message };
    }
  }

  return { getKey, hasKey, setKey, clearKey, getModel, setModel, chat, verifyKey, callModel };
}

module.exports = { createAi, KEY_STORAGE, MODEL_STORAGE, DEFAULT_MODEL, ENDPOINT };
