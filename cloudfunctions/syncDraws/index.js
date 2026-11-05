/**
 * syncDraws：从中国福彩网官方接口增量/按期同步开奖数据。
 * 输入：{ game, mode: 'incremental'|'issue'|'year', issueStart, issueEnd, issueCount, dryRun }
 * 输出：同步计数 + 同步日志 id；失败时给出可读原因，旧数据保持不变。
 */
const https = require('https');

const { createHandler, cloud } = require('./shared/cloud/base');
const {
  buildQueryUrl,
  assertResponseShape,
  mapRecord,
  PARSER_VERSION,
} = require('./shared/adapters/cwl');
const { upsertDraws, writeSyncLog, sha256, COLLECTIONS } = require('./shared/cloud/drawStore');
const { GAME } = require('./shared/constants/games');

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 6 * 1024 * 1024;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; jingcai-assistant/1.0; personal use)',
          Accept: 'application/json',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new Error('响应体过大，已中止（疑似未带 issueCount 触发全量返回）'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(new Error('响应不是合法 JSON'));
          }
        });
      }
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', (err) => reject(err));
  });
}

exports.main = createHandler('syncDraws', async ({ event, config }) => {
  const game = event.game || GAME.SSQ;
  const mode = event.mode || 'incremental';
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { success: false, code: 'GAME_UNSUPPORTED', message: '只支持 ssq 与 kl8' };
  }
  if (config.syncEnabled === false) {
    return { success: false, code: 'SYNC_DISABLED', message: '服务端已关闭同步' };
  }

  let url;
  try {
    url = buildQueryUrl({
      game,
      mode,
      issueStart: event.issueStart,
      issueEnd: event.issueEnd,
      issueCount: event.issueCount || 30,
    });
  } catch (err) {
    return { success: false, code: 'BAD_PARAMS', message: err.message };
  }

  const startedAt = new Date().toISOString();
  const db = cloud.database();

  let payload;
  try {
    payload = await fetchJson(url);
  } catch (err) {
    await writeSyncLog(db, {
      game,
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceUrl: url,
      parserVersion: PARSER_VERSION,
      fetchedCount: 0,
      inserted: 0,
      unchanged: 0,
      conflicts: 0,
      status: 'failed',
      error: String(err.message || err).slice(0, 300),
    });
    return {
      success: false,
      code: 'FETCH_FAILED',
      message: `官方数据源不可用：${err.message}。已保留本地数据，可稍后重试或使用 CSV 导入。`,
    };
  }

  const shape = assertResponseShape(payload);
  if (!shape.ok) {
    await writeSyncLog(db, {
      game,
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceUrl: url,
      parserVersion: PARSER_VERSION,
      fetchedCount: 0,
      inserted: 0,
      unchanged: 0,
      conflicts: 0,
      status: 'failed',
      error: shape.message,
    });
    return { success: false, code: shape.code, message: `官方返回异常：${shape.message}` };
  }

  const fetchedAt = new Date().toISOString();
  const records = [];
  const parseErrors = [];

  for (const raw of payload.result) {
    const mapped = mapRecord(game, raw, {
      fetchedAt,
      fuyunEmptyMeansInactive: config.fuyunEmptyMeansInactive === true,
    });
    if (!mapped.ok) {
      parseErrors.push({ issue: raw && raw.code, code: mapped.code, message: mapped.message });
      continue;
    }
    records.push({ ...mapped.record, rawHash: sha256(JSON.stringify(raw)) });
  }

  if (event.dryRun === true) {
    return {
      dryRun: true,
      game,
      mode,
      sourceUrl: url,
      fetchedCount: payload.result.length,
      parsedCount: records.length,
      parseErrors,
      sample: records.slice(0, 2),
      parserVersion: PARSER_VERSION,
    };
  }

  const summary = await upsertDraws(db, records, { now: new Date(fetchedAt) });
  const status =
    summary.inserted === 0 && summary.conflicts === 0 && summary.errors.length === 0
      ? 'no_change'
      : 'success';

  const logId = await writeSyncLog(db, {
    game,
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceUrl: url,
    parserVersion: PARSER_VERSION,
    fetchedCount: payload.result.length,
    parsedCount: records.length,
    inserted: summary.inserted,
    unchanged: summary.unchanged,
    conflicts: summary.conflicts,
    errorCount: summary.errors.length + parseErrors.length,
    status: parseErrors.length && records.length === 0 ? 'failed' : status,
    error: parseErrors.length ? JSON.stringify(parseErrors.slice(0, 5)) : null,
  });

  return {
    game,
    mode,
    sourceUrl: url,
    fetchedCount: payload.result.length,
    parsedCount: records.length,
    inserted: summary.inserted,
    unchanged: summary.unchanged,
    conflicts: summary.conflicts,
    errors: parseErrors.concat(summary.errors).slice(0, 20),
    logId,
    parserVersion: PARSER_VERSION,
    collection: COLLECTIONS.DRAW_RECORDS,
  };
});
