/**
 * 开奖记录入库（仅云端使用）。
 * 原则：不静默覆盖。内容变化 → conflict，等人工裁定。
 */

const crypto = require('crypto');
const { DRAW_STATUS } = require('../constants/games');
const { resolveRuleVersion } = require('../rules/registry');
const { validateDrawRecord } = require('../validators/draws');
const { contentSignature } = require('../adapters/cwl');

const COLLECTIONS = {
  DRAW_RECORDS: 'draw_records',
  DRAW_RULES: 'draw_rules',
  SYNC_LOGS: 'sync_logs',
  APP_CONFIG: 'app_config',
};

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * 补齐派生字段：规则版本、原始摘要、核验状态。
 * verified = 官方来源 + 格式/范围校验通过（不代表已与第二来源交叉核对）。
 */
function prepareRecord(record, options = {}) {
  const check = validateDrawRecord(record, { now: options.now });
  if (!check.ok) {
    return { ok: false, code: check.code, message: check.message, issue: record && record.issue };
  }
  const rule = resolveRuleVersion(record.game, record.issue);
  const now = new Date().toISOString();

  return {
    ok: true,
    record: {
      ...check.normalized,
      ruleVersion: rule.found ? rule.ruleVersion : null,
      rawHash: options.rawHash || null,
      drawStatus: DRAW_STATUS.VERIFIED,
      verifiedAt: now,
      verifiedBy: options.verifiedBy || 'official_api',
      updatedAt: now,
      createdAt: now,
    },
    ruleMissing: !rule.found,
  };
}

/**
 * 幂等写入：同 game+issue 只保留一条；内容一致则只更新时间戳。
 * @returns {{inserted:number, unchanged:number, conflicts:number, errors:Array}}
 */
async function upsertDraws(db, records, options = {}) {
  const collection = db.collection(COLLECTIONS.DRAW_RECORDS);
  const summary = { inserted: 0, unchanged: 0, conflicts: 0, errors: [] };

  for (const input of records || []) {
    const prepared = prepareRecord(input, {
      rawHash: input.rawHash,
      now: options.now,
      verifiedBy: options.verifiedBy,
    });
    if (!prepared.ok) {
      summary.errors.push({ issue: prepared.issue, code: prepared.code, message: prepared.message });
      continue;
    }
    const record = prepared.record;

    let existing = null;
    try {
      const res = await collection.where({ game: record.game, issue: record.issue }).limit(1).get();
      existing = (res.data && res.data[0]) || null;
    } catch (err) {
      summary.errors.push({ issue: record.issue, code: 'QUERY_FAILED', message: err.message });
      continue;
    }

    if (!existing) {
      try {
        await collection.add({ data: record });
        summary.inserted += 1;
      } catch (err) {
        summary.errors.push({ issue: record.issue, code: 'INSERT_FAILED', message: err.message });
      }
      continue;
    }

    const same = contentSignature(existing) === contentSignature(record);
    if (same) {
      try {
        await collection.doc(existing._id).update({
          data: {
            fetchedAt: record.fetchedAt,
            rawHash: record.rawHash || existing.rawHash || null,
            updatedAt: record.updatedAt,
          },
        });
        summary.unchanged += 1;
      } catch (err) {
        summary.errors.push({ issue: record.issue, code: 'UPDATE_FAILED', message: err.message });
      }
      continue;
    }

    // 内容不一致：保留旧数据，标记冲突，等待人工裁定
    try {
      await collection.doc(existing._id).update({
        data: {
          drawStatus: DRAW_STATUS.CONFLICT,
          conflictInfo: {
            incomingNumbers: record.numbers,
            incomingPrizeInfo: record.prizeInfo,
            incomingSourceUrl: record.sourceUrl,
            incomingSourceType: record.sourceType,
            incomingRawHash: record.rawHash,
            detectedAt: record.updatedAt,
          },
          updatedAt: record.updatedAt,
        },
      });
      summary.conflicts += 1;
    } catch (err) {
      summary.errors.push({ issue: record.issue, code: 'CONFLICT_WRITE_FAILED', message: err.message });
    }
  }

  return summary;
}

/** 写同步日志；日志失败不影响主流程 */
async function writeSyncLog(db, entry) {
  try {
    const res = await db.collection(COLLECTIONS.SYNC_LOGS).add({
      data: { ...entry, createdAt: new Date().toISOString() },
    });
    return res._id || null;
  } catch (err) {
    console.warn('[sync_logs] 写入失败', err && err.message);
    return null;
  }
}

module.exports = {
  COLLECTIONS,
  sha256,
  prepareRecord,
  upsertDraws,
  writeSyncLog,
};
