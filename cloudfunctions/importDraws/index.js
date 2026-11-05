/**
 * importDraws：CSV 兜底导入（官方接口不可用、或需要补历史时使用）。
 * 输入：{ csvText, dryRun }
 * 导入的记录标记来源为人工导入，核验人记为本机所有者，便于事后追溯。
 */
const { createHandler, cloud } = require('./shared/cloud/base');
const { parseDrawsCsv } = require('./shared/parsers/csv');
const { validateDrawRecord } = require('./shared/validators/draws');
const { upsertDraws, writeSyncLog, COLLECTIONS } = require('./shared/cloud/drawStore');
const { GAME } = require('./shared/constants/games');

const MAX_CSV_BYTES = 1024 * 1024; // 1MB，约 8000 行
const MAX_ROWS = 2000;

exports.main = createHandler('importDraws', async ({ event }) => {
  const csvText = event.csvText;
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return { success: false, code: 'EMPTY_INPUT', message: '缺少 CSV 内容' };
  }
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    return { success: false, code: 'TOO_LARGE', message: 'CSV 超过 1MB，请拆分后导入' };
  }

  const parsed = parseDrawsCsv(csvText, {
    validation: (r) => validateDrawRecord(r, { now: new Date() }),
  });

  if (!parsed.headerOk) {
    return { success: false, code: 'BAD_HEADER', message: parsed.errors[0].message };
  }
  if (parsed.records.length > MAX_ROWS) {
    return { success: false, code: 'TOO_MANY_ROWS', message: `单次最多导入 ${MAX_ROWS} 行` };
  }

  const preview = parsed.records.slice(0, 3).map((r) => ({
    game: r.game,
    issue: r.issue,
    drawDate: r.drawDate,
    display:
      r.game === GAME.SSQ
        ? `${r.numbers.red.map((n) => String(n).padStart(2, '0')).join(' ')} | ${String(
            r.numbers.blue
          ).padStart(2, '0')}`
        : r.numbers.kl8.map((n) => String(n).padStart(2, '0')).join(' '),
  }));

  if (event.dryRun === true) {
    return {
      dryRun: true,
      totalRows: parsed.records.length + parsed.errors.length,
      validRows: parsed.records.length,
      errors: parsed.errors,
      preview,
    };
  }

  const db = cloud.database();
  const startedAt = new Date().toISOString();
  const summary = await upsertDraws(db, parsed.records, { verifiedBy: 'owner_csv_import' });

  const logId = await writeSyncLog(db, {
    game: 'mixed',
    mode: 'csv_import',
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceUrl: null,
    sourceType: 'manual_official_import',
    parserVersion: 'csv_import@1.0.0',
    fetchedCount: parsed.records.length,
    inserted: summary.inserted,
    unchanged: summary.unchanged,
    conflicts: summary.conflicts,
    errorCount: summary.errors.length + parsed.errors.length,
    status: summary.errors.length ? 'partial' : 'success',
    error: parsed.errors.length ? JSON.stringify(parsed.errors.slice(0, 5)) : null,
  });

  return {
    validRows: parsed.records.length,
    inserted: summary.inserted,
    unchanged: summary.unchanged,
    conflicts: summary.conflicts,
    errors: parsed.errors.concat(summary.errors).slice(0, 20),
    logId,
    collection: COLLECTIONS.DRAW_RECORDS,
    preview,
  };
});
