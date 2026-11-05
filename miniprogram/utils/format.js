/** 展示层格式化：时间统一按 Asia/Shanghai 处理（decisions.md D7） */

/** 把 ISO 时间格式化为 YYYY-MM-DD HH:mm（东八区） */
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${p(
    shifted.getUTCHours()
  )}:${p(shifted.getUTCMinutes())}`;
}

/** 期号展示：2026126 → 2026126（不补零、不截断，避免误读） */
function formatIssue(issue) {
  return issue ? String(issue) : '—';
}

/** 金额展示：null 必须显示"待官方公告"，不能显示 0 */
function formatAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return '待官方公告';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '待官方公告';
  return n.toLocaleString('zh-CN');
}

module.exports = { formatDateTime, formatIssue, formatAmount };
